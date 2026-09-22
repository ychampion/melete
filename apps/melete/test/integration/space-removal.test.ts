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
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { artifactsManifest } from '../../src/connectors/artifacts.ts';
import { browserManifest } from '../../src/connectors/browser.ts';
import { builtinEnvironment, ensureBuiltinConnections } from '../../src/connectors/builtin.ts';
import { calendarManifest } from '../../src/connectors/calendar.ts';
import { grantedToolCatalog, REACT_TOOL } from '../../src/connectors/catalog.ts';
import { configuredConnectors } from '../../src/connectors/configured.ts';
import { emailManifest } from '../../src/connectors/email.ts';
import { execManifest } from '../../src/connectors/exec.ts';
import { filesManifest } from '../../src/connectors/files.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { webManifest } from '../../src/connectors/web.ts';
import { job, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { JobService } from '../../src/jobs/service.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { FileRestrictionJournal, restoreMemory } from '../../src/memory/restore.ts';
import { refusedForRemoval, spaceAuthority } from '../../src/principals/authority.ts';
import { PathOutsideRoot, removeConfined } from '../../src/spaces/plan.ts';
import {
  type BrowserTeardown,
  type RuntimeHomeTeardown,
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
  runtimeHomes?: RuntimeHomeTeardown;
  onPhase?: (removalId: string, phase: RemovalPhase) => void;
  connectors?: ConnectorRegistry;
  leaseMs?: number;
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
    leaseMs: overrides.leaseMs ?? 5_000,
    ...(overrides.sandboxes ? { sandboxes: overrides.sandboxes } : {}),
    ...(overrides.browser ? { browser: overrides.browser } : {}),
    ...(overrides.runtimeHomes ? { runtimeHomes: overrides.runtimeHomes } : {}),
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

/** The phases after the fence, in the order the sweep runs them. */
const SWEEP_ORDER: readonly RemovalPhase[] = [
  'sessions',
  'journal',
  'sandboxes',
  'browser',
  'runtime',
  'files',
  'operational',
  'principals',
  'memory',
  'verify',
  'space',
];

const MEMORY: readonly string[] = [
  'memory_claims',
  'memory_contexts',
  'memory_contradictions',
  'memory_dense_entries',
  'memory_derivations',
  'memory_index_entries',
  'memory_index_manifest',
  'memory_invalidations',
  'memory_outbox',
  'memory_outputs',
  'memory_prepared',
  'memory_profile',
  'memory_proposals',
  'memory_questions',
  'memory_rejections',
  'memory_repair_briefs',
  'memory_sources',
  'memory_spaces',
  'memory_streams',
  'memory_suppressions',
  'memory_work',
];

/**
 * Every table that points at a space, and the phase that empties it for that
 * space. Checked against the catalog and against what each phase really
 * removes, by `every_space_table_is_removed_by_its_named_phase`.
 */
const REMOVED_BY: Record<string, RemovalPhase> = {
  // Access ends first: the session loses its selection, the link is deleted.
  session: 'sessions',
  magic_link: 'sessions',
  // Jobs and everything below them, the rows that outlive a job, and what the
  // space holds apart from its jobs.
  job: 'operational',
  artifact: 'operational',
  browser_recipe_candidate: 'operational',
  browser_session_binding: 'operational',
  company: 'operational',
  company_message: 'operational',
  company_scan: 'operational',
  episode: 'operational',
  experience_profile: 'operational',
  experience_rule: 'operational',
  knowledge_record: 'operational',
  learning_job: 'operational',
  ledger_item: 'operational',
  procedure_candidate: 'operational',
  question: 'operational',
  skill: 'operational',
  task: 'operational',
  // After the jobs and actions that `restrict` them.
  agent: 'principals',
  connection: 'principals',
  secret: 'principals',
  ...Object.fromEntries(MEMORY.map((table) => [table, 'memory' as const])),
  // Last, with the space row.
  space_membership: 'space',
};

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

  test('every_space_table_is_removed_by_its_named_phase — measured one phase at a time, against the catalog', async () => {
    const seeded = await seed('shared');

    // The inventory is whatever the live database says points at a space: a
    // foreign key to it, or a `space_id` column with no key behind it. A table
    // a later migration adds fails here until it is named below.
    const pointing = await sql<{ name: string }[]>`select distinct conrelid::regclass::text as name
      from pg_constraint where contype = 'f' and confrelid = 'space'::regclass`;
    const inventory = new Set([
      ...pointing.map((row) => row.name),
      ...(await spaceKeyedTables(sql)),
    ]);
    inventory.delete('space_removal');
    expect([...inventory].sort()).toEqual(Object.keys(REMOVED_BY).sort());

    // And the fixture has something in every one of them, or the measurement
    // below would prove nothing about it.
    const before = await rowsLeft(sql, seeded.spaceId);
    expect(Object.keys(REMOVED_BY).filter((table) => !before[table])).toEqual([]);

    // Halt the sweep after each phase in turn and see what that phase took.
    const removedBy: Record<string, RemovalPhase> = {};
    let removalId = '';
    for (const phase of SWEEP_ORDER) {
      const halting = new AbortController();
      const removals = await service({
        onPhase: (_id, entered) => {
          if (entered === phase) halting.abort();
        },
      });
      if (!removalId)
        removalId = (await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger')).id;
      const halted = await removals.run(removalId, halting.signal);
      const left = await rowsLeft(sql, seeded.spaceId);
      for (const table of inventory)
        if (!left[table] && !removedBy[table]) removedBy[table] = phase;
      if (phase === 'space') expect(outcome(halted)).toBe('complete');
    }
    expect(removedBy).toEqual(REMOVED_BY);
  });

  test('removal_goes_round_again_after_a_late_write — a row landing behind its phase is swept on the next pass', async () => {
    const seeded = await seed('shared');
    let passes = 0;
    const browser: BrowserTeardown = {
      forgetSpace: async (spaceId) => {
        passes += 1;
        return { space_id: spaceId, profile: null, rows: passes === 1 ? 2 : 0 };
      },
    };
    const halting = new AbortController();
    const removals = await service({
      browser,
      onPhase: (_id, phase) => {
        if (phase === 'memory') halting.abort();
      },
    });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    await removals.run(fenced.id, halting.signal);

    // A write that was already under way when its table was swept, such as a
    // mailbox scan finishing a message it had read before the fence.
    await sql`insert into company_message
      (id, space_id, principal_id, message_id, subject, from_address, received_at, body)
      values (${`msg_${crypto.randomUUID()}`}, ${seeded.spaceId}, ${seeded.principalId},
        '<late@example.test>', 'Late', 'late@example.test', now(), 'Written after the sweep.')`;

    const stopped = await removals.run(fenced.id);
    expect(stopped.state).toBe('blocked');
    expect(stopped.blockedReason).toContain('company_message');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);

    // The next pass does not ask the same question again. It goes round the
    // sweep, the phase that owns the row takes it, and the removal finishes.
    const finished = await removals.run(fenced.id);
    expect(outcome(finished)).toBe('complete');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    // What the first pass cleared is still counted after the second.
    expect(passes).toBe(2);
    expect(finished.counts).toMatchObject({ cleared: { signed_in_sites: 2 } });
  });

  test('a_scan_still_reading_cannot_write_into_a_cleared_space — the emptied space stays empty', async () => {
    const seeded = await seed('personal');
    const store = new PostgresCompanyStore(db);
    const owner = { spaceId: seeded.spaceId, principalId: seeded.principalId };
    const scan = await store.openScan(owner);
    const message = (id: string) => ({
      messageId: id,
      subject: 'Invoice',
      from: 'billing@example.test',
      receivedAt: new Date().toISOString(),
      text: 'Your invoice for 148.00 is due on the first.',
    });
    const found = {
      name: 'Example',
      domain: 'example.test',
      monthly_spend_minor: null,
      currency: null,
      first_seen_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      message_count: 1,
    };
    // While the scan is open, it writes.
    await store.saveMessages(owner, scan.id, [message('<before@example.test>')]);

    // The space is emptied, and keeps its row, so no cascade would help here.
    const { finished } = await removeCompletely(seeded);
    expect(outcome(finished)).toBe('complete');
    expect(finished.kind).toBe('emptied');

    // The scan is still reading in its own time. Nothing it writes now lands.
    const refusal = (write: Promise<unknown>) =>
      write.then(
        () => 'written',
        (error: unknown) => String(error),
      );
    expect(
      await refusal(store.saveMessages(owner, scan.id, [message('<after@example.test>')])),
    ).toContain('stopped');
    expect(await refusal(store.saveCompany(owner, scan.id, found))).toContain('stopped');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
  });

  test('connector_not_served_by_a_process_that_starts_mid_removal — only the other space is served', async () => {
    const going = await seed('shared');
    const staying = await seed('shared', 'Another');
    const web = async (spaceId: string) => {
      const id = `conn_${crypto.randomUUID()}`;
      await sql`insert into connection (id, space_id, provider, label, scopes)
        values (${id}, ${spaceId}, 'web', 'Web', ${JSON.stringify(['web.fetch'])}::jsonb)`;
      return id;
    };
    const goingConnection = await web(going.spaceId);
    const stayingConnection = await web(staying.spaceId);

    // Fenced, and then nothing: a removal that is waiting on something that
    // blocked it, or one whose process died, looks exactly like this.
    const removals = await service();
    const fenced = await removals.fence(going.principalId, going.spaceId, 'The Ledger');

    const registry = await configuredConnectors({ sql, spacesRoot, workRoot, env: {} });
    try {
      expect(registry.get(goingConnection)).toBeUndefined();
      expect(registry.get(stayingConnection)).toBeDefined();
    } finally {
      await registry.close();
    }
    expect(outcome(await removals.run(fenced.id))).toBe('complete');
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

  test('an_emptied_space_is_emptied_once — what is made afterwards survives restarts, and an older backup is emptied again', async () => {
    const seeded = await seed('personal');
    const journal = await newJournal();
    const backup = await snapshot(sql, seeded.spaceId);
    const removals = await service({ journal });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    expect(outcome(await removals.run(fenced.id))).toBe('complete');

    // The person uses the space again: its memory is provisioned afresh, as
    // the first use of it does, and new work begins.
    const makeWork = async () => {
      const id = `job_${crypto.randomUUID()}`;
      await sql`insert into job (id, space_id, title, principal_id, objective, state)
        values (${id}, ${seeded.spaceId}, 'New work', ${seeded.principalId}, 'After emptying', 'queued')`;
      return id;
    };
    const restart = async () => {
      await restoreMemory(sql, journal);
      return removals.resume();
    };
    await provisionMemorySpace(sql, seeded.ownerId, seeded.spaceId);
    const made = await makeWork();

    // Two restarts, each replaying the journal and resuming what is queued.
    // Neither empties the space again.
    for (const _ of [1, 2]) expect(await restart()).toEqual([]);
    const [open] = await sql<{ removed_at: Date | null }[]>`select removed_at from space
      where id = ${seeded.spaceId}`;
    expect(open?.removed_at).toBeNull();
    expect(await countOf(sql, 'job', sql`id = ${made}`)).toBe(1);
    const [memory] = await sql<{ revoked: boolean; restore_ready: boolean }[]>`select revoked,
      restore_ready from memory_spaces where space_id = ${seeded.spaceId}`;
    expect(memory).toEqual({ revoked: false, restore_ready: true });

    // A backup from before the emptying is put back. It is the whole database,
    // so the space is as it was then, removal epoch included, and the work
    // made since is not in it.
    await sql`delete from job where id = ${made}`;
    await restore(sql, backup);
    await sql`update space set removal_epoch = 0 where id = ${seeded.spaceId}`;
    expect(Object.keys(await rowsLeft(sql, seeded.spaceId)).length).toBeGreaterThan(0);
    const again = await restart();
    expect(again.map(outcome)).toEqual(['complete']);
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});

    // And that is the last of it: what is made next survives the next restarts.
    await provisionMemorySpace(sql, seeded.ownerId, seeded.spaceId);
    const next = await makeWork();
    for (const _ of [1, 2]) expect(await restart()).toEqual([]);
    expect(await countOf(sql, 'job', sql`id = ${next}`)).toBe(1);
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

  /** A provider whose first teardown takes longer than a lease, as a slow network does. */
  const slowSandboxes = (ms: number): SandboxTeardown => {
    let calls = 0;
    return {
      providerFor: () => ({}),
      destroyWorkspacesForSpace: async () => {
        calls += 1;
        if (calls === 1) await Bun.sleep(ms);
        return { closed: [], snapshotsDeleted: [] };
      },
      listWorkspacesForSpace: async () => ({ sessions: [], snapshots: [] }),
    };
  };

  test('a_slow_phase_keeps_its_lease — no second run starts, and what the person makes afterwards stays', async () => {
    const seeded = await seed('personal');
    const first = await service({ sandboxes: slowSandboxes(2_500), leaseMs: 500 });
    const fenced = await first.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const running = first.run(fenced.id);
    await Bun.sleep(900);

    // Well past the lease, the phase is still going. Another process finds it
    // held, and this one leaves it to the run it already has.
    const other = await service({ leaseMs: 500 });
    const rival = await other.resume();
    expect(rival.map((row) => row.id)).toEqual([fenced.id]);
    expect(rival[0]?.state).toBe('running');
    expect(await first.resume()).toEqual([]);

    const finished = await running;
    expect(outcome(finished)).toBe('complete');
    expect(finished.attempts).toBe(1);

    // The space is open again and the person uses it. Nothing is still
    // running that could take that away.
    const kept = `job_${crypto.randomUUID()}`;
    await sql`insert into job (id, space_id, title, principal_id, objective, state)
      values (${kept}, ${seeded.spaceId}, 'New work', ${seeded.principalId}, 'After emptying', 'queued')`;
    await Bun.sleep(600);
    expect(await other.resume()).toEqual([]);
    expect(await countOf(sql, 'job', sql`id = ${kept}`)).toBe(1);
  });

  test('a_run_that_loses_its_lease_stops — and writes nothing after', async () => {
    const seeded = await seed('shared');
    const first = await service({ sandboxes: slowSandboxes(1_500), leaseMs: 300 });
    const fenced = await first.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const running = first.run(fenced.id);
    await Bun.sleep(400);
    // Another run has taken it, as one would after this process stalled.
    await sql`update space_removal set lease_owner = 'rem_rival',
      lease_expires_at = now() + interval '1 hour' where id = ${fenced.id}`;

    const stopped = await running;
    expect(stopped.leaseOwner).toBe('rem_rival');
    expect(stopped.state).toBe('running');
    expect(stopped.phase).toBe('sandboxes');
    // Nothing after the phase it was in: the files, the rows and the space
    // are all still there for the run that holds it.
    expect(await exists(join(spacesRoot, seeded.spaceId))).toBe(true);
    expect(await countOf(sql, 'job', sql`space_id = ${seeded.spaceId}`)).toBeGreaterThan(0);
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);

    // When that run's lease lapses in turn, the removal is finished from here.
    await sql`update space_removal set lease_expires_at = now() - interval '1 second'
      where id = ${fenced.id}`;
    expect(outcome(await (await service()).run(fenced.id))).toBe('complete');
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

  test('removal_clears_runtime_homes — by the job ids the fence kept, and listed again afterwards', async () => {
    const seeded = await seed('shared');
    const other = `job_${crypto.randomUUID()}`;
    const homes = new Set([seeded.jobId, other]);
    const runtimeHomes: RuntimeHomeTeardown = {
      removeHomesForJobs: async (jobIds) => {
        const removed = jobIds.filter((id) => homes.delete(id));
        return { removed };
      },
      listHomesForJobs: async (jobIds) => jobIds.filter((id) => homes.has(id)),
    };
    const { finished } = await removeCompletely(seeded, { runtimeHomes });
    expect(outcome(finished)).toBe('complete');
    expect(finished.counts).toMatchObject({
      providers: { runtime_homes: 0 },
      cleared: { runtime_homes_removed: 1 },
    });
    // Another job's home, in another space, is not this removal's to take.
    expect([...homes]).toEqual([other]);

    // A home that is still listed after the removal asked for it is not gone.
    const stubborn = await seed('shared');
    const { finished: held } = await removeCompletely(stubborn, {
      runtimeHomes: {
        removeHomesForJobs: async () => ({ removed: [] }),
        listHomesForJobs: async (jobIds) => [...jobIds],
      },
    });
    expect(held.state).toBe('blocked');
    expect(held.blockedReason).toContain('runtime_homes');
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

    // Stop the sweep in the window the guard exists for: the connections have
    // gone and the space row has not. A removal that ends blocked sits here for
    // as long as it takes someone to fix what blocked it, and every boot in
    // between runs the pass that furnishes every space.
    const halting = new AbortController();
    const removals = await service({
      connectors: registry,
      onPhase: (_id, phase) => {
        if (phase === 'memory') halting.abort();
      },
    });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const halted = await removals.run(fenced.id, halting.signal);
    expect(halted.state).not.toBe('complete');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
    expect(await countOf(sql, 'connection', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'secret', sql`space_id = ${seeded.spaceId}`)).toBe(0);

    // A request landing now, and the pass over every space at the next boot,
    // both refuse to furnish a space that carries a removal stamp.
    expect(await ensureBuiltinConnections(sql, environment, seeded.spaceId)).toEqual([]);
    const everySpace = await ensureBuiltinConnections(sql, environment);
    expect(everySpace.filter((made) => made.spaceId === seeded.spaceId)).toEqual([]);
    expect(await countOf(sql, 'connection', sql`space_id = ${seeded.spaceId}`)).toBe(0);

    // And nothing in this process is still answering for the ones that went.
    for (const row of [...rows, ...furnished.map((made) => ({ id: made.id }))])
      expect(registry.get(row.id)).toBeUndefined();

    const finished = await removals.run(fenced.id);
    expect(outcome(finished)).toBe('complete');
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
      expect(shown.preview.counts).toMatchObject({
        jobs: 2,
        connections: 1,
        memory_claims: 1,
        companies: 1,
        ledger_items: 1,
      });
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

    test('a_space_under_removal_admits_no_new_work — a personal space whose emptying is waiting included', async () => {
      const seeded = await seed('personal');
      const jobsBefore = await countOf(sql, 'job', sql`space_id = ${seeded.spaceId}`);
      // Stopped part way, the way an emptying that is waiting on something
      // sits: stamped and closed, and not yet finished.
      const halting = new AbortController();
      const stopping = await service({
        onPhase: (_id, phase) => {
          if (phase === 'files') halting.abort();
        },
      });
      const fenced = await stopping.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      expect((await stopping.run(fenced.id, halting.signal)).state).toBe('pending');

      // The session still resolves to this space: it is the account's own.
      // Asking it for new work is refused, by name and through a space route.
      const asked = await call(seeded.sessionToken, '/jobs', 'POST', {
        space_id: seeded.spaceId,
        title: 'Carry on',
        objective: 'Keep working here',
      });
      expect(asked.status).toBe(403);
      expect(((await asked.json()) as { error: { message: string } }).error.message).toBe(
        'This space is being cleared.',
      );
      const scan = await call(
        seeded.sessionToken,
        `/spaces/${seeded.spaceId}/companies/scan`,
        'POST',
      );
      expect(scan.status).toBe(403);

      // And by the database, for an insert written as raw SQL the way the
      // experience commands write theirs.
      for (const insert of [
        (tx: Sql) => tx`insert into job (id, space_id, title, principal_id, objective, state)
          values (${`job_${crypto.randomUUID()}`}, ${seeded.spaceId}, 'Raw', ${seeded.principalId},
            'Written directly', 'queued')`,
        (tx: Sql) => tx`insert into connection (id, space_id, provider, label, scopes)
          values (${`conn_${crypto.randomUUID()}`}, ${seeded.spaceId}, 'web', 'Web', '[]'::jsonb)`,
        (tx: Sql) => tx`insert into company_scan (id, space_id, principal_id)
          values (${`scn_${crypto.randomUUID()}`}, ${seeded.spaceId}, ${seeded.principalId})`,
      ])
        expect(await refused(insert)).toContain('space_removed');
      expect(await countOf(sql, 'job', sql`space_id = ${seeded.spaceId}`)).toBe(jobsBefore);
      // That refusal reaches a person as the same answer, whichever client
      // made the insert: the error is recognised bare and wrapped.
      const caught = (write: Promise<unknown>) =>
        write.then(
          () => undefined,
          (error) => error,
        );
      expect(
        refusedForRemoval(
          await caught(sql`insert into job (id, space_id, title, principal_id, objective, state)
            values (${`job_${crypto.randomUUID()}`}, ${seeded.spaceId}, 'Raw', ${seeded.principalId},
              'Written directly', 'queued')`),
        ),
      ).toBe(true);
      expect(
        refusedForRemoval(
          await caught(
            db.insert(job).values({
              id: `job_${crypto.randomUUID()}`,
              spaceId: seeded.spaceId,
              principalId: seeded.principalId,
              title: 'Through drizzle',
              objective: 'Written through the query builder',
            }),
          ),
        ),
      ).toBe(true);

      // The removal still answers the person who asked for it.
      expect((await call(seeded.sessionToken, `/spaces/${seeded.spaceId}/removal`)).status).toBe(
        200,
      );

      // Once the emptying finishes, the space is theirs to use again.
      expect(outcome(await stopping.run(fenced.id))).toBe('complete');
      expect((await spaceAuthority(db, seeded.spaceId, seeded.principalId)).role).toBe('owner');
    });

    test('an_insert_racing_the_fence_waits_for_it_and_is_refused', async () => {
      const seeded = await seed('shared');
      const raced = `job_${crypto.randomUUID()}`;
      // The fence holds the space for update and stamps it; an insert that
      // arrives while it is open must not pass on the version from before.
      const fencing = sql.begin(async (tx) => {
        await tx`select id from space where id = ${seeded.spaceId} for update`;
        await tx`update space set removed_at = now() where id = ${seeded.spaceId}`;
        await Bun.sleep(800);
      });
      await Bun.sleep(200);
      const racing = sql`insert into job (id, space_id, title, principal_id, objective, state)
        values (${raced}, ${seeded.spaceId}, 'Raced', ${seeded.principalId}, 'Slip in', 'running')`.then(
        () => '',
        (error: Error) => error.message,
      );
      await fencing;
      expect(await racing).toBe('space_removed');
      expect(await countOf(sql, 'job', sql`id = ${raced}`)).toBe(0);
    });

    test('the progress of a removal is shown only to the person who asked', async () => {
      const seeded = await seed('shared');
      const removals = await service();
      await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      expect(
        (await call(seeded.memberSessionToken, `/spaces/${seeded.spaceId}/removal`)).status,
      ).toBe(404);
      expect((await call(seeded.sessionToken, `/spaces/${seeded.spaceId}/removal`)).status).toBe(
        200,
      );
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
