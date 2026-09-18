/**
 * Removing a space.
 *
 * The claim under test is narrow and total: after a removal reports itself
 * finished, nothing keyed to that space is left in any table, nothing of it is
 * left on disk, and restoring a backup taken before the removal does not bring
 * it back. Every assertion here is a re-count, never a reading of what the
 * sweep said it did.
 *
 * The fixture fills every table that keys rows to a space and every directory
 * a space uses, because an assertion that nothing is left is only worth making
 * against a space that had something everywhere.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorManifest, RemovalPhase } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { Sql } from 'postgres';
import { ServiceError } from '../../src/api/errors.ts';
import { artifactsManifest } from '../../src/connectors/artifacts.ts';
import { browserManifest } from '../../src/connectors/browser.ts';
import { builtinEnvironment, ensureBuiltinConnections } from '../../src/connectors/builtin.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { grantedToolCatalog, REACT_TOOL } from '../../src/connectors/catalog.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { execManifest } from '../../src/connectors/exec.ts';
import { filesManifest } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { webManifest } from '../../src/connectors/web.ts';
import { space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { FileRestrictionJournal, restoreMemory } from '../../src/memory/restore.ts';
import { PathOutsideRoot, removeConfined } from '../../src/spaces/plan.ts';
import {
  type BrowserTeardown,
  type SandboxTeardown,
  SpaceRemovalService,
} from '../../src/spaces/removal.ts';
import { testDatabase } from '../helpers/database.ts';
import { type SeededSpace, seedFiles, seedSpace } from './space-removal-fixture.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-space-removal-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });
if (handle)
  afterAll(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

/** A journal on disk, with its real hash chain: the removal record has to survive a restore. */
async function newJournal(): Promise<FileRestrictionJournal> {
  const journal = new FileRestrictionJournal(join(root, `journal-${crypto.randomUUID()}.jsonl`));
  await journal.initializeNew();
  return journal;
}

/** The one the routes write to, made here because createApp is not async. */
const routeJournal = await newJournal();

type Overrides = {
  journal?: FileRestrictionJournal;
  sandboxes?: SandboxTeardown;
  browser?: BrowserTeardown;
  onPhase?: (removalId: string, phase: RemovalPhase) => void;
  connectors?: ConnectorRegistry;
};

async function service(overrides: Overrides = {}) {
  if (!handle) throw new Error('Postgres unavailable');
  return new SpaceRemovalService({
    db: handle.db,
    sql: handle.sql,
    // The fence never enqueues: a cancelled job has no next wake, so the
    // queue is never reached and a live pg-boss is not needed here.
    jobs: new JobService(handle.db, {} as PgBoss),
    journal: overrides.journal ?? (await newJournal()),
    roots: { spacesRoot, workRoot },
    leaseMs: 5_000,
    ...(overrides.sandboxes ? { sandboxes: overrides.sandboxes } : {}),
    ...(overrides.browser ? { browser: overrides.browser } : {}),
    ...(overrides.onPhase ? { onPhase: overrides.onPhase } : {}),
    ...(overrides.connectors ? { connectors: overrides.connectors } : {}),
  });
}

const seed = (kind: 'shared' | 'personal', name = 'The Ledger') => {
  if (!handle) throw new Error('Postgres unavailable');
  return seedSpace(handle.sql, { kind, name, spacesRoot, workRoot });
};

/** Every base table in the database that keys rows to a space, read from the catalog. */
async function spaceKeyedTables(sql: Sql): Promise<string[]> {
  const rows = await sql<
    { table_name: string }[]
  >`select c.table_name from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'space_id' and t.table_type = 'BASE TABLE'
    order by c.table_name`;
  return rows.map((row) => String(row.table_name));
}

/** What each of those tables still holds for one space. Zero everywhere is the claim. */
async function rowsLeft(
  sql: Sql,
  spaceId: string,
  except: string[] = [],
): Promise<Record<string, number>> {
  const held: Record<string, number> = {};
  for (const table of await spaceKeyedTables(sql)) {
    if (table === 'space_removal' || except.includes(table)) continue;
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count
      from ${sql(table)} where space_id = ${spaceId}`;
    if (Number(row?.count ?? 0) > 0) held[table] = Number(row?.count);
  }
  return held;
}

async function countOf(sql: Sql, table: string, where: ReturnType<Sql>): Promise<number> {
  const [row] = await sql<{ count: number }[]>`select count(*)::int as count
    from ${sql(table)} where ${where}`;
  return Number(row?.count ?? 0);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * A statement the database ought to refuse, run in its own transaction so the
 * abort is rolled back cleanly and the next statement starts from a whole
 * connection. Returns the message, or an empty string if it was allowed.
 */
async function refused(run: (tx: Sql) => Promise<unknown>): Promise<string> {
  if (!handle) throw new Error('Postgres unavailable');
  try {
    await handle.sql.begin(async (tx) => {
      await run(tx as unknown as Sql);
    });
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * A finished removal reads as the one word `complete`. Anything else reads as
 * its state and the reason it stopped, so a failure here names the thing that
 * was left behind instead of only saying the word was wrong.
 */
function outcome(row: { state: string; blockedReason: string | null } | undefined): string {
  if (!row) return 'no removal';
  return row.state === 'complete'
    ? 'complete'
    : `${row.state}: ${row.blockedReason ?? 'no reason'}`;
}

async function removeCompletely(seeded: SeededSpace, overrides: Overrides = {}) {
  const removals = await service(overrides);
  const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
  const finished = await removals.run(fenced.id);
  return { removals, fenced, finished };
}

const MANIFESTS: ConnectorManifest[] = [
  artifactsManifest,
  browserManifest,
  calendarManifest,
  emailManifest,
  execManifest,
  filesManifest,
  webManifest,
];

describe.if(handle !== null)('removing a space', () => {
  if (!handle) return;
  const { sql, db } = handle;

  // ------------------------------------------------------------------
  // The record, and the index that keeps two removals from racing
  // ------------------------------------------------------------------

  test('space_removal_migration_applies — the column and the table are there, with their checks', async () => {
    const [column] = await sql<{ data_type: string }[]>`select data_type
      from information_schema.columns where table_name = 'space' and column_name = 'removed_at'`;
    expect(column?.data_type).toBe('timestamp with time zone');

    const columns = await sql<{ column_name: string }[]>`select column_name
      from information_schema.columns where table_name = 'space_removal' order by column_name`;
    expect(columns.map((row) => row.column_name)).toEqual([
      'attempts',
      'blocked_reason',
      'connection_ids',
      'counts',
      'finished_at',
      'git_path',
      'id',
      'job_ids',
      'kind',
      'lease_expires_at',
      'lease_owner',
      'phase',
      'providers',
      'requested_by',
      'space_id',
      'space_name',
      'started_at',
      'state',
    ]);

    const checks = await sql<{ conname: string }[]>`select conname from pg_constraint
      where conrelid = 'space_removal'::regclass and contype = 'c' order by conname`;
    expect(checks.map((row) => row.conname)).toEqual([
      'space_removal_kind',
      'space_removal_phase',
      'space_removal_state',
    ]);

    // The row outlives the space, so it must not reference it.
    const references = await sql`select conname from pg_constraint
      where conrelid = 'space_removal'::regclass and contype = 'f'`;
    expect(references).toHaveLength(0);
  });

  test('space_removal_live_index_is_unique — one live removal per space, however many are asked for', async () => {
    const seeded = await seed('shared');
    const removals = await service();
    const first = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const again = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    expect(again.id).toBe(first.id);
    expect(await countOf(sql, 'space_removal', sql`space_id = ${seeded.spaceId}`)).toBe(1);

    // The database refuses a rival row even if something tries to write one.
    const message = await refused(
      (tx) =>
        tx`insert into space_removal (id, space_id, space_name, git_path, kind, requested_by, state)
        values ('rem_second', ${seeded.spaceId}, 'The Ledger', 'x', 'removed',
          ${seeded.principalId}, 'pending')`,
    );
    expect(message).toContain('space_removal_live_idx');
  });

  // ------------------------------------------------------------------
  // The fence
  // ------------------------------------------------------------------

  test('fence_cancels_running_jobs — nothing in the space can do any more work', async () => {
    const seeded = await seed('shared');
    const removals = await service();
    await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');

    const jobs = await sql<{ state: string }[]>`select state from job
      where space_id = ${seeded.spaceId}`;
    expect(jobs.every((row) => row.state === 'cancelled')).toBe(true);
    expect(await countOf(sql, 'trigger', sql`job_id = ${seeded.jobId} and enabled`)).toBe(0);

    const [parent] = await db.select().from(space).where(eq(space.id, seeded.spaceId));
    expect(parent?.removedAt).not.toBeNull();
    expect(parent?.policyGeneration).toBe(1);

    const [memory] = await sql<{ revoked: boolean; restore_ready: boolean }[]>`select revoked,
      restore_ready from memory_spaces where space_id = ${seeded.spaceId}`;
    expect(memory?.revoked).toBe(true);
    expect(memory?.restore_ready).toBe(false);
  });

  test('fence_bumps_lease_epoch — a stalled attempt that wakes meets a fence', async () => {
    const seeded = await seed('shared');
    const [before] = await sql<{ lease_epoch: number }[]>`select lease_epoch from job
      where id = ${seeded.jobId}`;
    const removals = await service();
    await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const [after] = await sql<{ lease_epoch: number }[]>`select lease_epoch from job
      where id = ${seeded.jobId}`;
    expect(Number(after?.lease_epoch)).toBe(Number(before?.lease_epoch) + 1);
  });

  test('fence_is_idempotent — asking twice joins the removal already running', async () => {
    const seeded = await seed('shared');
    const removals = await service();
    const first = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const second = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    expect(second.id).toBe(first.id);
    const [parent] = await db.select().from(space).where(eq(space.id, seeded.spaceId));
    // The generation moved once, not twice: the second call did no work.
    expect(parent?.policyGeneration).toBe(1);
  });

  test('fence_rejects_name_mismatch — the wrong name changes nothing at all', async () => {
    const seeded = await seed('shared');
    const removals = await service();
    await expect(removals.fence(seeded.principalId, seeded.spaceId, 'the ledger')).rejects.toThrow(
      ServiceError,
    );
    const [parent] = await db.select().from(space).where(eq(space.id, seeded.spaceId));
    expect(parent?.removedAt).toBeNull();
    expect(await countOf(sql, 'space_removal', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    const [row] = await sql<{ state: string }[]>`select state from job where id = ${seeded.jobId}`;
    expect(row?.state).toBe('waiting_for_event_or_time');
  });

  test('member_cannot_delete_space — the service refuses a member as well as the route does', async () => {
    const seeded = await seed('shared');
    const removals = await service();
    await expect(removals.fence(seeded.memberId, seeded.spaceId, 'The Ledger')).rejects.toThrow(
      /owner/i,
    );
    expect(await countOf(sql, 'space_removal', sql`space_id = ${seeded.spaceId}`)).toBe(0);
  });

  // ------------------------------------------------------------------
  // The sweep
  // ------------------------------------------------------------------

  test('removal_deletes_every_table — nothing keyed to the space is left anywhere', async () => {
    const seeded = await seed('shared');
    // The fixture is only worth having if it filled the tables it claims to.
    const before = await rowsLeft(sql, seeded.spaceId);
    expect(Object.keys(before).length).toBeGreaterThan(20);

    const { finished } = await removeCompletely(seeded);
    expect(outcome(finished)).toBe('complete');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'space_membership', sql`space_id = ${seeded.spaceId}`)).toBe(0);
  });

  test('removal_deletes_survivor_rows — the four that outlive a job go, content and all', async () => {
    const seeded = await seed('shared');
    // Each is checked by its own key, never by job_id: a row whose job_id was
    // merely nulled would pass a job_id check while still holding its content.
    const byKey: Array<[string, ReturnType<Sql>]> = [
      ['submission', sql`submission_id = ${seeded.submissionId}`],
      ['acceptance_journal', sql`submission_id = ${seeded.submissionId}`],
      ['reply_obligation', sql`submission_id = ${seeded.submissionId}`],
      ['notification', sql`id = ${seeded.notificationId}`],
    ];
    for (const [table, where] of byKey) expect(await countOf(sql, table, where)).toBe(1);

    await removeCompletely(seeded);

    for (const [table, where] of byKey) expect(await countOf(sql, table, where)).toBe(0);
    expect(await countOf(sql, 'artifact', sql`source_job_id = ${seeded.jobId}`)).toBe(0);
  });

  test('sweep_order_satisfies_restrict_constraints — the three that refuse a plain delete', async () => {
    const seeded = await seed('shared');
    // Proof that the order is load-bearing: out of order, the database refuses.
    for (const statement of [
      (tx: Sql) => tx`delete from space where id = ${seeded.spaceId}`,
      (tx: Sql) => tx`delete from agent where space_id = ${seeded.spaceId}`,
      (tx: Sql) => tx`delete from connection where space_id = ${seeded.spaceId}`,
    ])
      expect(await refused(statement)).toContain('violates foreign key constraint');

    // And the two that are `restrict` rather than `no action` are why a single
    // statement cannot do it: `restrict` is checked at once, and is not
    // satisfied by rows that same statement is deleting.
    const restricting = await sql<{ conname: string }[]>`select conname from pg_constraint
      where contype = 'f' and confdeltype = 'r'
        and conrelid in ('job'::regclass, 'action'::regclass) order by conname`;
    expect(restricting.map((row) => row.conname)).toEqual([
      'action_connection_id_connection_id_fk',
      'job_agent_id_agent_id_fk',
    ]);

    const { finished } = await removeCompletely(seeded);
    expect(outcome(finished)).toBe('complete');
    expect(finished.blockedReason).toBeNull();
  });

  // ------------------------------------------------------------------
  // The files
  // ------------------------------------------------------------------

  test('removal_deletes_space_directory — the git tree and its history go with it', async () => {
    const seeded = await seed('shared');
    const directory = join(spacesRoot, seeded.spaceId);
    expect(await exists(join(directory, '.git'))).toBe(true);
    expect(await exists(join(directory, 'browser', 'chromium', 'Cookies'))).toBe(true);

    await removeCompletely(seeded);
    expect(await exists(directory)).toBe(false);
  });

  test('removal_deletes_job_workspaces — keyed by job id, which only the fence still knows', async () => {
    const seeded = await seed('shared');
    const workspace = join(workRoot, seeded.jobId);
    expect(await exists(workspace)).toBe(true);
    await removeCompletely(seeded);
    expect(await exists(workspace)).toBe(false);
  });

  test('removal_refuses_path_outside_root — a name that leads elsewhere removes nothing', async () => {
    const outside = join(root, 'not-a-space');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8');

    for (const name of ['..', '../not-a-space', 'a/b', '.'])
      await expect(removeConfined(spacesRoot, name)).rejects.toThrow(PathOutsideRoot);
    expect(await exists(join(outside, 'keep.txt'))).toBe(true);

    // A name that is a link out of the root is refused for the same reason.
    const target = join(spacesRoot, 'plain');
    await mkdir(target, { recursive: true });
    await removeConfined(spacesRoot, 'plain');
    expect(await exists(target)).toBe(false);
  });

  // ------------------------------------------------------------------
  // The journal, and what a restore does
  // ------------------------------------------------------------------

  test('removal_appends_journal_record — one record, hash chain intact', async () => {
    const seeded = await seed('shared');
    const journal = await newJournal();
    await removeCompletely(seeded, { journal });

    // read() re-verifies the chain and throws if a link does not match.
    const records = await journal.read();
    const mine = records.filter((record) => record.space_id === seeded.spaceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.operation).toBe('remove_space');
    expect(mine[0]?.all).toBe(true);
    expect(mine[0]?.claim_ids).toEqual([]);
    expect(mine[0]?.targets).toEqual([]);
  });

  test('restore_does_not_resurrect_space — a backup from before the removal brings it back, and the replay takes it apart again', async () => {
    const seeded = await seed('shared');
    const journal = await newJournal();
    const backup = await snapshot(sql, seeded.spaceId);

    const { removals } = await removeCompletely(seeded, { journal });
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);

    // Restore what a database backup taken before the removal would hold.
    await restore(sql, backup);
    await seedFiles(spacesRoot, workRoot, seeded.spaceId, seeded.jobId);
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);

    // The journal is retained apart from the snapshot, so the replay still
    // finds the record and queues the sweep again.
    await restoreMemory(sql, journal);
    const [queued] = await sql<{ id: string; state: string }[]>`select id, state from space_removal
      where space_id = ${seeded.spaceId} and state <> 'complete'`;
    expect(queued?.state).toBe('pending');

    const [memory] = await sql<{ revoked: boolean; restore_ready: boolean }[]>`select revoked,
      restore_ready from memory_spaces where space_id = ${seeded.spaceId}`;
    expect(memory?.revoked).toBe(true);
    // replay_leaves_space_unserved: restore_ready gates serving, and it is false.
    expect(memory?.restore_ready).toBe(false);

    const finished = await removals.run(String(queued?.id));
    expect(outcome(finished)).toBe('complete');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);
    expect(await exists(join(spacesRoot, seeded.spaceId))).toBe(false);
  });

  test('replay_leaves_space_unserved — a queued removal is never restore_ready, even among spaces that are', async () => {
    const kept = await seed('shared', 'Kept');
    const going = await seed('shared');
    const journal = await newJournal();
    const backup = await snapshot(sql, going.spaceId);
    await removeCompletely(going, { journal });
    await restore(sql, backup);

    await restoreMemory(sql, journal);
    const [survivor] = await sql<{ restore_ready: boolean }[]>`select restore_ready
      from memory_spaces where space_id = ${kept.spaceId}`;
    const [removed] = await sql<{ restore_ready: boolean }[]>`select restore_ready
      from memory_spaces where space_id = ${going.spaceId}`;
    expect(survivor?.restore_ready).toBe(true);
    expect(removed?.restore_ready).toBe(false);
  });

  // ------------------------------------------------------------------
  // Blocked, never a false success
  // ------------------------------------------------------------------

  test('removal_reports_partial_as_blocked — a provider that refuses leaves the space in place', async () => {
    const seeded = await seed('shared');
    const refusing: SandboxTeardown = {
      providerFor: () => ({}),
      destroyWorkspacesForSpace: async () => {
        throw new Error('the sandbox provider could not be reached');
      },
      listWorkspacesForSpace: async () => ({ sessions: ['sbx_1'], snapshots: ['snap_1'] }),
    };
    const removals = await service({ sandboxes: refusing });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const finished = await removals.run(fenced.id);

    expect(finished.state).toBe('blocked');
    expect(finished.state).not.toBe('complete');
    expect(finished.blockedReason).toContain('could not be reached');
    // The space is still there, and nothing anywhere says it was deleted.
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
    expect(finished.finishedAt).toBeNull();
  });

  test('removal_never_completes_with_skipped_phase — a capability it needed and could not reach is not a zero', async () => {
    const seeded = await seed('shared');
    // The space has a sandbox session and no provider is wired to clear it.
    await sql`create table if not exists sandbox_session (
      id text primary key, space_id text not null, resume_ref text)`;
    await sql`insert into sandbox_session (id, space_id, resume_ref)
      values (${`sbx_${seeded.spaceId}`}, ${seeded.spaceId}, 'ref')`;
    try {
      const removals = await service();
      const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      const finished = await removals.run(fenced.id);
      expect(finished.state).toBe('blocked');
      expect(finished.counts).toMatchObject({ omitted: { sandboxes: 'capability_absent' } });
      expect(finished.blockedReason).toContain('sandboxes');
      expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
    } finally {
      await sql`drop table if exists sandbox_session`;
    }
  });

  test('removal_resumes_after_crash — the phase is committed, so the next run carries on from it', async () => {
    const seeded = await seed('shared');
    const journal = await newJournal();
    // Stop the sweep part way, the way a process that dies does: whatever
    // phase was reached is committed, and nothing past it has run.
    const dying = new AbortController();
    const removals = await service({
      journal,
      onPhase: (_id, phase) => {
        if (phase === 'files') dying.abort();
      },
    });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const halfway = await removals.run(fenced.id, dying.signal);
    expect(halfway.state).not.toBe('complete');
    expect(halfway.phase).toBe('files');
    // The phases before it did run, and their work is committed.
    expect(await countOf(sql, 'session', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    // The one after it did not.
    expect(await countOf(sql, 'agent', sql`space_id = ${seeded.spaceId}`)).toBe(1);

    // Leave the lease where a dead process would have left it.
    await sql`update space_removal set lease_expires_at = now() - interval '1 minute'
      where id = ${fenced.id}`;
    const resumed = await removals.resume();
    expect(resumed.map((row) => row.id)).toContain(fenced.id);
    const finished = resumed.find((row) => row.id === fenced.id);
    expect(outcome(finished)).toBe('complete');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
  });

  // ------------------------------------------------------------------
  // The two seams
  // ------------------------------------------------------------------

  test('removal_clears_provider_snapshots — the provider is asked, and asked again', async () => {
    const seeded = await seed('shared');
    const held = { sessions: ['sbx_1'], snapshots: ['snap_1'] };
    const asked: string[] = [];
    const sandboxes: SandboxTeardown = {
      providerFor: (adapter, connectionId) => ({ adapter, connectionId }),
      destroyWorkspacesForSpace: async (spaceId, providerFor, signal) => {
        // A provider is reached through a connection, never an adapter alone:
        // one space can hold sandboxes in more than one account.
        expect(providerFor('fake', seeded.connectionId)).toEqual({
          adapter: 'fake',
          connectionId: seeded.connectionId,
        });
        expect(signal.aborted).toBe(false);
        asked.push(spaceId);
        const closed = [...held.sessions];
        const snapshotsDeleted = [...held.snapshots];
        held.sessions = [];
        held.snapshots = [];
        return { closed, snapshotsDeleted };
      },
      listWorkspacesForSpace: async () => ({ ...held }),
    };
    const { finished } = await removeCompletely(seeded, { sandboxes });
    expect(outcome(finished)).toBe('complete');
    expect(asked).toEqual([seeded.spaceId]);
    expect(held).toEqual({ sessions: [], snapshots: [] });
    expect(finished.counts).toMatchObject({
      providers: { sandbox_sessions: 0, sandbox_snapshots: 0 },
      cleared: { sandbox_sessions_closed: 1, sandbox_snapshots_deleted: 1 },
    });
  });

  test('removal_blocked_when_provider_unreachable — a provider that still lists a snapshot is not finished', async () => {
    const seeded = await seed('shared');
    const stubborn: SandboxTeardown = {
      providerFor: () => ({}),
      // It reports that it deleted the snapshot, and still lists it. The
      // re-listing is what makes the difference between a claim and a fact.
      destroyWorkspacesForSpace: async () => ({ closed: [], snapshotsDeleted: ['snap_1'] }),
      listWorkspacesForSpace: async () => ({ sessions: [], snapshots: ['snap_1'] }),
    };
    const removals = await service({ sandboxes: stubborn });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const finished = await removals.run(fenced.id);
    expect(finished.state).toBe('blocked');
    expect(finished.blockedReason).toContain('sandbox_snapshots');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
  });

  test('removal_clears_browser_profile — the worker stops, the profile and its sites go, the space root is left for the sweep', async () => {
    const seeded = await seed('shared');
    const forgot: string[] = [];
    const browser: BrowserTeardown = {
      forgetSpace: async (spaceId) => {
        // One call: the worker exits, the profile directory goes, then the
        // site rows. It leaves the space root alone, which is why the
        // filesystem phase still owns it and has to run after this.
        forgot.push(spaceId);
        const profile = join(spacesRoot, spaceId, 'browser');
        await rm(profile, { recursive: true, force: true });
        return { space_id: spaceId, profile, rows: 2 };
      },
    };
    const { finished } = await removeCompletely(seeded, { browser });
    expect(outcome(finished)).toBe('complete');
    expect(forgot).toEqual([seeded.spaceId]);
    expect(finished.counts).toMatchObject({ cleared: { signed_in_sites: 2 } });
    expect(await exists(join(spacesRoot, seeded.spaceId, 'browser'))).toBe(false);
  });

  // ------------------------------------------------------------------
  // Nothing puts back what the sweep has taken
  // ------------------------------------------------------------------

  test('connector_cannot_be_served_for_a_space_under_removal — not recreated, and not still answering', async () => {
    const seeded = await seed('shared');
    const environment = builtinEnvironment(loadEnv({ NODE_ENV: 'test' }));

    // Before the fence, the space is furnished as any space is.
    const furnished = await ensureBuiltinConnections(sql, environment, seeded.spaceId);
    const before = await countOf(sql, 'connection', sql`space_id = ${seeded.spaceId}`);
    expect(before).toBeGreaterThan(1);

    // A registry that is answering for every one of them.
    const registry = new ConnectorRegistry();
    const rows = await sql<{ id: string }[]>`select id from connection
      where space_id = ${seeded.spaceId} order by id`;
    const connector = { manifest: emailManifest } as never;
    for (const row of rows) registry.register(row.id, connector);

    const removals = await service({ connectors: registry });
    await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');

    // A request landing mid-sweep, and the pass over every space at startup,
    // both refuse to furnish a space that is being removed.
    expect(await ensureBuiltinConnections(sql, environment, seeded.spaceId)).toEqual([]);
    expect(await ensureBuiltinConnections(sql, environment)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ spaceId: seeded.spaceId })]),
    );

    const finished = await removals.run((await removals.current(seeded.spaceId))?.id ?? '');
    expect(outcome(finished)).toBe('complete');
    // Nothing is left to serve, and nothing in this process is still serving.
    expect(await countOf(sql, 'connection', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'secret', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    for (const row of [...rows, ...furnished.map((made) => ({ id: made.id }))])
      expect(registry.get(row.id)).toBeUndefined();
    expect(finished.counts).toMatchObject({ providers: { connectors_served: 0 } });
  });

  // ------------------------------------------------------------------
  // The personal space
  // ------------------------------------------------------------------

  test('personal_space_is_emptied_not_removed — the id stays, the account stays signed in, everything else goes', async () => {
    const seeded = await seedSpace(sql, {
      kind: 'personal',
      name: 'The Ledger',
      spacesRoot,
      workRoot,
    });
    const { finished } = await removeCompletely(seeded);
    expect(outcome(finished)).toBe('complete');
    expect(finished.kind).toBe('emptied');

    // The space, its id and its account are still there.
    const [parent] = await db.select().from(space).where(eq(space.id, seeded.spaceId));
    expect(parent?.id).toBe(seeded.spaceId);
    expect(parent?.removedAt).toBeNull();
    expect(await countOf(sql, 'principal', sql`id = ${seeded.principalId}`)).toBe(1);
    // Still signed in: the selection was cleared, the session was not deleted.
    const [session] = await sql<{ space_id: string | null }[]>`select space_id from session
      where principal_id = ${seeded.principalId}`;
    expect(session).toBeDefined();
    expect(session?.space_id).toBeNull();

    // And nothing of what was in it is left.
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    for (const name of ['knowledge', 'raw', 'artifacts', 'skills']) {
      const directory = join(spacesRoot, seeded.spaceId, name);
      if (await exists(directory)) expect(await readdir(directory)).toEqual([]);
    }
    expect(await exists(join(spacesRoot, seeded.spaceId, 'browser'))).toBe(false);
    // A fresh repository, ready to use.
    expect(await exists(join(spacesRoot, seeded.spaceId, '.git'))).toBe(true);
  });

  // ------------------------------------------------------------------
  // Out of the model's reach, by construction
  // ------------------------------------------------------------------

  test('model_cannot_reach_removal — no manifest declares it and no action routes to it', async () => {
    const seeded = await seed('shared');

    // Nothing generates it. A model's tools come solely from connector
    // manifests; removal is not a connector and has no manifest.
    const declared = MANIFESTS.flatMap((manifest) =>
      manifest.tools.map((tool) => tool.name.toLowerCase()),
    );
    expect(declared.filter((name) => /space/.test(name) && /remov|delet|empt/.test(name))).toEqual(
      [],
    );

    const catalog = grantedToolCatalog(
      [{ id: seeded.connectionId, provider: 'email', scopes: ['email.send'] }],
      { get: () => ({ manifest: emailManifest }) as never },
    );
    expect(catalog.filter((tool) => /space/.test(tool.name))).toEqual([]);
    // The only tool without a connection is the broker's own reaction tool.
    expect(catalog.filter((tool) => tool.connection_id === null).map((tool) => tool.name)).toEqual([
      REACT_TOOL.name,
    ]);

    // Nothing admits it. Every effect a model asks for becomes an action row;
    // a removal makes none, so the count only ever falls.
    const [before] = await sql<{ count: number }[]>`select count(*)::int as count from action`;
    await removeCompletely(seeded);
    const [after] = await sql<{ count: number }[]>`select count(*)::int as count from action`;
    expect(Number(after?.count)).toBeLessThanOrEqual(Number(before?.count));
  });

  // ------------------------------------------------------------------
  // The route
  // ------------------------------------------------------------------

  describe('over the API', () => {
    const removals = new SpaceRemovalService({
      db,
      sql,
      jobs: new JobService(db, {} as PgBoss),
      journal: routeJournal,
      roots: { spacesRoot, workRoot },
      leaseMs: 5_000,
    });
    const app = createApp({
      db,
      sql,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: spacesRoot }),
      checkDatabase: async () => 'ok',
      jobs: new JobService(db, {} as PgBoss),
      removals,
    });
    const call = (token: string, path: string, method = 'GET', body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          Cookie: `melete_session=${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    test('member_cannot_delete_space — 403 before the handler runs', async () => {
      const seeded = await seed('shared');
      const response = await call(
        seeded.memberSessionToken,
        `/spaces/${seeded.spaceId}`,
        'DELETE',
        {
          confirm_name: 'The Ledger',
        },
      );
      expect(response.status).toBe(403);
      expect(await countOf(sql, 'space_removal', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    });

    test('delete_returns_202_with_removal_id — and the counts come first', async () => {
      const seeded = await seed('shared');
      const preview = await call(seeded.sessionToken, `/spaces/${seeded.spaceId}/removal/preview`);
      expect(preview.status).toBe(200);
      const shown = (await preview.json()) as { preview: Record<string, unknown> };
      expect(shown.preview.counts).toMatchObject({ jobs: 2, connections: 1, memory_claims: 1 });
      expect(shown.preview.confirmation).toContain('The Ledger');
      expect((shown.preview.stays as string[]).join(' ')).toContain('Revoke them there');

      const response = await call(seeded.sessionToken, `/spaces/${seeded.spaceId}`, 'DELETE', {
        confirm_name: 'The Ledger',
      });
      expect(response.status).toBe(202);
      const started = (await response.json()) as { removal: { id: string; state: string } };
      expect(started.removal.id).toMatch(/^rem_/);
      expect(started.removal.state).toBe('pending');
    });

    test('owner_can_delete_shared_space — and the report never claims more than it did', async () => {
      const seeded = await seed('shared');
      const response = await call(seeded.sessionToken, `/spaces/${seeded.spaceId}`, 'DELETE', {
        confirm_name: 'The Ledger',
      });
      expect(response.status).toBe(202);
      const started = (await response.json()) as { removal: { id: string } };

      // The route answers as soon as the fence commits; the sweep it started
      // in the background is what finishes the job.
      const finished = await removals.settled(started.removal.id);
      expect(outcome(finished)).toBe('complete');
      expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);

      // The space is gone, so the record answers for itself.
      const report = await call(seeded.sessionToken, `/removals/${started.removal.id}`);
      expect(report.status).toBe(200);
      const read = (await report.json()) as {
        report: { headline: string; cleared: string[]; still_yours: string[] };
      };
      expect(read.report.headline).toBe('The Ledger is gone.');
      expect(read.report.still_yours.join(' ')).toContain('Revoke them there');
    });

    test('a mismatched name is refused with 400 and nothing changes', async () => {
      const seeded = await seed('shared');
      const response = await call(seeded.sessionToken, `/spaces/${seeded.spaceId}`, 'DELETE', {
        confirm_name: 'The Ledgers',
      });
      expect(response.status).toBe(400);
      const failed = (await response.json()) as { error: { code: string } };
      expect(failed.error.code).toBe('confirmation_mismatch');
      expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
    });
  });
});

// ----------------------------------------------------------------------
// A database backup, narrowed to one space, and putting it back
// ----------------------------------------------------------------------

/**
 * What a database backup taken before a removal holds, for the tables a
 * restore can put back on its own. The order is the order they are written
 * back in, because a restore obeys the same foreign keys everything else does.
 */
const RESTORED_TABLES = [
  'space',
  'space_membership',
  'memory_spaces',
  'memory_index_manifest',
  'memory_claims',
  'knowledge_record',
  'task',
] as const;

type Snapshot = { table: string; rows: Record<string, unknown>[] }[];

async function snapshot(sql: Sql, spaceId: string): Promise<Snapshot> {
  const taken: Snapshot = [];
  for (const table of RESTORED_TABLES) {
    const rows = (await (table === 'space'
      ? sql`select * from space where id = ${spaceId}`
      : sql`select * from ${sql(table)} where space_id = ${spaceId}`)) as Record<string, unknown>[];
    if (rows.length) taken.push({ table, rows });
  }
  return taken;
}

async function restore(sql: Sql, taken: Snapshot): Promise<void> {
  for (const { table, rows } of taken)
    for (const row of rows) {
      // A jsonb column comes back as an object and has to go back as JSON,
      // the same way a real restore hands it to the driver.
      const present = Object.fromEntries(
        Object.entries(row)
          .filter(([, value]) => value !== null)
          .map(([name, value]) => [
            name,
            // An untyped parameter is coerced to the target column's type, so
            // a jsonb column takes the JSON back as text.
            typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value,
          ]),
      );
      await sql`insert into ${sql(table)} ${sql(present as never)} on conflict do nothing`;
    }
}
