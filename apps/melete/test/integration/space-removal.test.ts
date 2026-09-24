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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { JobService } from '../../src/jobs/service.ts';
import { standingProhibition, standingProhibitions } from '../../src/learning/engine-skills.ts';
import { provisionMemorySpace } from '../../src/memory/db.ts';
import { FileRestrictionJournal, restoreMemory } from '../../src/memory/restore.ts';
import { replayForNewMemory } from '../../src/memory/start.ts';
import { refusedForRemoval, spaceAuthority } from '../../src/principals/authority.ts';
import { sandboxTeardownProviders } from '../../src/sandbox/connection.ts';
import { FakeSandboxProvider } from '../../src/sandbox/fake.ts';
import { sessionSpec } from '../../src/sandbox/session-fixtures.ts';
import { SandboxSessions, sessionHandle } from '../../src/sandbox/sessions.ts';
import { sandboxKeyChange, sandboxRemovalTeardown } from '../../src/sandbox/wiring.ts';
import { PathOutsideRoot, removeConfined, sweepMemory } from '../../src/spaces/plan.ts';
import {
  type BrowserTeardown,
  type RuntimeHomeTeardown,
  type SandboxTeardown,
  SpaceRemovalService,
} from '../../src/spaces/removal.ts';
import { BrowserSiteService } from '../../src/workers/browser/sites.ts';
import { FakeStdioLauncher } from '../fixtures/stdio-launcher.ts';
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
  retryMs?: number;
  stopJobs?: (jobIds: readonly string[]) => Promise<void>;
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
    ...(overrides.retryMs ? { retryMs: overrides.retryMs } : {}),
    ...(overrides.stopJobs ? { stopJobs: overrides.stopJobs } : {}),
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

/**
 * The service's own browser sites over a worker that no test here starts.
 * Stopping one is recorded; the rows and the profile directory are removed by
 * the real service.
 */
function browserSites(released: string[] = []): BrowserTeardown {
  if (!handle) throw new Error('Postgres unavailable');
  return {
    sites: new BrowserSiteService(handle.sql, {
      spacesRoot,
      get: async () => {
        throw new Error('no browser worker is started in these tests');
      },
      release: async (spaceId) => {
        released.push(spaceId);
      },
    }),
  };
}

/**
 * Hold a directory the way a job that is still running does, so it cannot be
 * removed until the hold is let go. On Windows that is a process working in
 * it, which is what holds a job's workspace there. Elsewhere a process's
 * working directory holds nothing, so a directory whose entries cannot be
 * removed stands in for it.
 */
async function holdDirectory(directory: string): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  let released = false;
  if (process.platform === 'win32') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: directory,
      stdio: 'ignore',
    });
    await Bun.sleep(300);
    return async () => {
      if (released) return;
      released = true;
      child.kill();
      await once(child, 'exit');
      await Bun.sleep(100);
    };
  }
  const inner = join(directory, 'held');
  await mkdir(inner, { recursive: true });
  await writeFile(join(inner, 'open'), 'in use');
  await chmod(inner, 0o555);
  return async () => {
    if (released) return;
    released = true;
    await chmod(inner, 0o755);
  };
}

/** Root can remove what a read-only directory holds, so there the hold does not hold. */
const canHold = process.platform === 'win32' || process.getuid?.() !== 0;

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
  'memory_capture',
  'memory_claims',
  'memory_contexts',
  'memory_contradictions',
  'memory_dense_entries',
  'memory_derivations',
  'memory_index_entries',
  'memory_index_manifest',
  'memory_invalidations',
  'memory_model_calls',
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
  // With a browser worker, the browser phase takes these with the profile;
  // this test runs without one, so they go with the space's other rows.
  browser_site_profile: 'operational',
  browser_session_binding: 'operational',
  company: 'operational',
  company_message: 'operational',
  company_scan: 'operational',
  episode: 'operational',
  experience_profile: 'operational',
  experience_rule: 'operational',
  knowledge_record: 'operational',
  learning_evaluation_lease: 'operational',
  learning_job: 'operational',
  learning_notice: 'operational',
  learned_change: 'operational',
  // Not removed: its record of where it was said is cleared, and it stands on.
  engine_skill_prohibition: 'operational',
  ledger_item: 'operational',
  procedure_candidate: 'operational',
  question: 'operational',
  sandbox_session: 'operational',
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
      'epoch',
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

  test('the_browser_workers_space_is_not_removed — refused plainly, and nothing changes', async () => {
    const seeded = await seed('shared');
    const removals = new SpaceRemovalService({
      db,
      sql,
      jobs: new JobService(db, {} as PgBoss),
      journal: await newJournal(),
      roots: { spacesRoot, workRoot },
      browserSpace: seeded.spaceId,
    });
    const refusal = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ServiceError);
    expect((refusal as ServiceError).code).toBe('space_in_use');
    expect((refusal as ServiceError).message).toContain('MELETE_BROWSER_SPACE');
    expect(await countOf(sql, 'space_removal', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId} and removed_at is null`)).toBe(1);
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

  test('a_prohibition_outlives_its_space — removal completes, and the person’s "don’t do this" stands on', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const seeded = await seed('shared');
    const [placed] = await sql<{ id: string }[]>`select id from engine_skill_prohibition
      where space_id = ${seeded.spaceId}`;
    if (!placed) throw new Error('No prohibition was seeded');

    const { finished } = await removeCompletely(seeded);
    expect(outcome(finished)).toBe('complete');

    // Only the record of where it was said went with the space.
    const [row] = await sql`select space_id, principal_id, skill_name, lifted_at
      from engine_skill_prohibition where id = ${placed.id}`;
    expect(row).toMatchObject({
      space_id: null,
      principal_id: seeded.principalId,
      skill_name: 'weekly-digest',
      lifted_at: null,
    });
    // A prohibition is checked by person, not by space, so it still refuses that
    // skill at intake and keeps it out of delivery in every other space of theirs.
    await handle.db.transaction(async (tx) => {
      expect(
        await standingProhibition(tx, seeded.principalId, {
          name: 'weekly-digest',
          body: 'Other.',
        }),
      ).toMatchObject({ id: placed.id });
      expect((await standingProhibitions(tx, seeded.principalId)).names.has('weekly-digest')).toBe(
        true,
      );
    });
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
    // A sandbox session already closed at its provider, so the sandboxes phase
    // has nothing to end and the row is left for the phase that deletes it.
    await sql`insert into sandbox_session (id, connection_id, space_id, adapter,
        provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at,
        closed_at)
      values (${`sbx_${seeded.spaceId}`}, ${seeded.connectionId}, ${seeded.spaceId}, 'fake',
        'sbx_provider', 'base', '{"kind":"deny_all"}'::jsonb, 'ephemeral', 'closed', now(), now())`;
    const sandboxes = sandboxRemovalTeardown(
      new SandboxSessions(sql, { leaseSeconds: 300, workspaceRetentionSeconds: 3_600 }),
      () => new FakeSandboxProvider(),
    );

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
        sandboxes,
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
    const released: string[] = [];
    const halting = new AbortController();
    const removals = await service({
      browser: browserSites(released),
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
    // The fixture's one signed-in site went on the first pass, none on the second.
    expect(released).toEqual([seeded.spaceId, seeded.spaceId]);
    expect(finished.counts).toMatchObject({ cleared: { signed_in_sites: 1 } });
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
    // What a restart resumes for this space. The database holds other
    // tests' removals too, and a restart resumes those as well.
    const restart = async () => {
      await restoreMemory(sql, journal);
      return (await removals.resume()).filter((row) => row.spaceId === seeded.spaceId);
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

  test('memory_provisioned_after_emptying_is_not_suppressed_by_the_removal_record', async () => {
    const seeded = await seed('personal');
    const journal = await newJournal();
    const { finished } = await removeCompletely(seeded, { journal });
    expect(outcome(finished)).toBe('complete');
    expect((await journal.read()).some((entry) => entry.operation === 'remove_space')).toBe(true);

    // The first use of the emptied space provisions its memory and replays the
    // journal for it, as a new space's memory always does.
    await provisionMemorySpace(sql, seeded.ownerId, seeded.spaceId);
    await replayForNewMemory(sql, journal, seeded.ownerId, seeded.spaceId);
    expect(await countOf(sql, 'memory_suppressions', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    const [memory] = await sql<{ revoked: boolean; restore_ready: boolean }[]>`select revoked,
      restore_ready from memory_spaces where space_id = ${seeded.spaceId}`;
    expect(memory).toEqual({ revoked: false, restore_ready: true });
  });

  test('a_restored_space_is_closed_like_a_fenced_one — memory or not, for the person who asked', async () => {
    const seeded = await seed('shared');
    // This space never held memory: nothing of it is in memory_spaces.
    await sweepMemory(sql, seeded.spaceId);
    const journal = await newJournal();
    const backup = await snapshot(sql, seeded.spaceId);
    await removeCompletely(seeded, { journal });
    const [record] = (await journal.read()).filter((entry) => entry.space_id === seeded.spaceId);
    expect(record).toMatchObject({
      operation: 'remove_space',
      removal_epoch: 1,
      requested_by: seeded.principalId,
    });

    // The backup comes back, and with it live work and a connection.
    await restore(sql, backup);
    const [before] = await sql<{ policy_generation: number }[]>`select policy_generation from space
      where id = ${seeded.spaceId}`;
    const live = `job_${crypto.randomUUID()}`;
    await sql`insert into job (id, space_id, title, principal_id, objective, state)
      values (${live}, ${seeded.spaceId}, 'Restored', ${seeded.principalId}, 'Came back', 'running')`;
    const restored = `conn_${crypto.randomUUID()}`;
    await sql`insert into connection (id, space_id, provider, label, scopes)
      values (${restored}, ${seeded.spaceId}, 'web', 'Web', '[]'::jsonb)`;

    await restoreMemory(sql, journal);
    const [queued] = await sql<{ id: string; requested_by: string; phase: string }[]>`select id,
      requested_by, phase from space_removal where space_id = ${seeded.spaceId} and state <> 'complete'`;
    expect(queued).toMatchObject({ requested_by: seeded.principalId, phase: 'fence' });

    // Its run closes the space the way the fence does before anything goes.
    const halting = new AbortController();
    const removals = await service({
      journal,
      onPhase: (_id, phase) => {
        if (phase === 'sessions') halting.abort();
      },
    });
    const closed = await removals.run(String(queued?.id), halting.signal);
    const [job] = await sql<{ state: string; lease_epoch: number }[]>`select state, lease_epoch
      from job where id = ${live}`;
    expect(job?.state).toBe('cancelled');
    expect(job?.lease_epoch).toBeGreaterThan(0);
    const [after] = await sql<{ policy_generation: number }[]>`select policy_generation from space
      where id = ${seeded.spaceId}`;
    expect(after?.policy_generation).toBeGreaterThan(before?.policy_generation ?? 0);
    expect(closed.jobIds).toContain(live);
    expect(closed.connectionIds).toContain(restored);

    // And the person who asked still sees it through.
    expect(outcome(await removals.run(closed.id))).toBe('complete');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'job', sql`id = ${live}`)).toBe(0);
  });

  test('a_replayed_removal_answers_to_the_person_who_asked — not to the memory owner', async () => {
    const seeded = await seed('shared');
    const journal = await newJournal();
    const backup = await snapshot(sql, seeded.spaceId);
    await removeCompletely(seeded, { journal });
    const [record] = (await journal.read()).filter((entry) => entry.space_id === seeded.spaceId);
    // The memory belongs to the installation owner; the removal was asked for
    // by the space's owner, who is someone else.
    expect(record?.owner_id).toBe(seeded.ownerId);
    expect(seeded.principalId).not.toBe(seeded.ownerId);

    await restore(sql, backup);
    await restoreMemory(sql, journal);
    const [queued] = await sql<{ requested_by: string }[]>`select requested_by from space_removal
      where space_id = ${seeded.spaceId} and state <> 'complete'`;
    expect(queued?.requested_by).toBe(seeded.principalId);
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
    await sql`insert into sandbox_session (id, connection_id, space_id, adapter,
        provider_sandbox_id, image_ref, egress_policy, persistence, status, lease_expires_at)
      values (${`sbx_${seeded.spaceId}`}, ${seeded.connectionId}, ${seeded.spaceId}, 'e2b',
        'sbx_provider', 'base', '{"kind":"deny_all"}'::jsonb, 'ephemeral', 'ready', now())`;
    const removals = await service();
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const finished = await removals.run(fenced.id);
    expect(finished.state).toBe('blocked');
    expect(finished.counts).toMatchObject({ omitted: { sandboxes: 'capability_absent' } });
    expect(finished.blockedReason).toContain('sandboxes');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(1);
  });

  test('removal_destroys_sandboxes — a space with a sandbox session ends it at the provider and finishes', async () => {
    const seeded = await seed('shared');
    // The fixture's connection, installed as a sandbox connection.
    await sql`update connection set provider = 'sandbox', secret_ref = ${seeded.secretId},
        configuration = ${JSON.stringify({
          kind: 'sandbox',
          sandbox: {
            adapter: 'e2b',
            image: 'base',
            egress: 'deny_all',
            persistence: 'pause',
            lifetime_seconds: 600,
          },
        })}::jsonb
      where id = ${seeded.connectionId}`;
    const provider = new FakeSandboxProvider({ capabilities: { adapter: 'e2b' } });
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const spec = sessionSpec('removal-test', seeded.spaceId, seeded.connectionId);
    const running = await sessions.open(
      {
        connectionId: seeded.connectionId,
        spaceId: seeded.spaceId,
        jobId: seeded.jobId,
        attemptId: null,
        agentId: null,
      },
      provider,
      spec,
      AbortSignal.timeout(30_000),
    );
    const workspace = await sessions.openWorkspace(
      {
        connectionId: seeded.connectionId,
        spaceId: seeded.spaceId,
        jobId: seeded.jobId,
        attemptId: null,
        agentId: seeded.agentId,
        persistence: 'pause',
      },
      provider,
      spec,
      AbortSignal.timeout(30_000),
    );
    await sessions.suspendWorkspace(workspace.id, provider, AbortSignal.timeout(30_000));
    // What the service wires: providers built from the connection rows, since
    // a space under removal serves no connectors.
    const teardown = sandboxTeardownProviders({
      sql,
      secrets: { withSecret: async () => Promise.reject(new Error('no key is read')) },
      project: 'removal-test',
      open: () => ({ provider, close: async () => {} }),
    });
    const { finished } = await removeCompletely(seeded, {
      sandboxes: sandboxRemovalTeardown(sessions, teardown.providerFor),
    });
    expect(finished.state).toBe('complete');
    for (const sandbox of [running, workspace])
      expect(await provider.inspect(sessionHandle(sandbox), AbortSignal.timeout(10_000))).toBe(
        'gone',
      );
    expect(await countOf(sql, 'sandbox_session', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);
    await teardown.close();
  });

  test("removal_after_revocation — a revoked connection's deleted snapshots do not hold the removal", async () => {
    const seeded = await seed('shared');
    await sql`update connection set provider = 'sandbox', secret_ref = ${seeded.secretId},
        configuration = ${JSON.stringify({
          kind: 'sandbox',
          sandbox: {
            adapter: 'modal',
            image: 'debian:bookworm-slim',
            egress: 'deny_all',
            persistence: 'snapshot',
            lifetime_seconds: 600,
          },
        })}::jsonb
      where id = ${seeded.connectionId}`;
    const provider = new FakeSandboxProvider({ capabilities: { adapter: 'modal' } });
    const sessions = new SandboxSessions(sql, {
      leaseSeconds: 300,
      workspaceRetentionSeconds: 3_600,
    });
    const workspace = await sessions.openWorkspace(
      {
        connectionId: seeded.connectionId,
        spaceId: seeded.spaceId,
        jobId: seeded.jobId,
        attemptId: null,
        agentId: seeded.agentId,
        persistence: 'snapshot',
      },
      provider,
      sessionSpec('removal-test', seeded.spaceId, seeded.connectionId),
      AbortSignal.timeout(30_000),
    );
    const snapshot =
      (await sessions.suspendWorkspace(workspace.id, provider, AbortSignal.timeout(30_000)))
        .resumeRef ?? '';
    expect(provider.engine.snapshots.has(snapshot)).toBe(true);
    const teardown = sandboxTeardownProviders({
      sql,
      secrets: { withSecret: async () => Promise.reject(new Error('no key is read')) },
      project: 'removal-test',
      open: () => ({ provider, close: async () => {} }),
    });
    // The revocation deletes the snapshot while the key is still held, then
    // drops the key: nothing can ask Modal about this connection afterwards.
    const [row] = await sql`select generation from connection where id = ${seeded.connectionId}`;
    await new PolicyService(new JobService(db, {} as PgBoss), undefined, {
      beforeKeyChange: sandboxKeyChange({
        sessions,
        providerFor: teardown.providerFor,
        log: () => {},
      }),
    }).changeConnection(seeded.connectionId, {
      kind: 'revoke',
      expected_generation: Number(row?.generation),
    });
    expect(provider.engine.snapshots.has(snapshot)).toBe(false);

    const { finished } = await removeCompletely(seeded, {
      sandboxes: sandboxRemovalTeardown(sessions, teardown.providerFor),
    });
    expect(finished.state).toBe('complete');
    expect(await countOf(sql, 'space', sql`id = ${seeded.spaceId}`)).toBe(0);
    await teardown.close();
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
    const mine = (rows: { id: string }[]) => rows.filter((row) => row.id === fenced.id);
    expect(mine(await other.resume())).toEqual([]);
    expect(mine(await first.resume())).toEqual([]);
    const held = await other.byId(fenced.id);
    expect(held?.state).toBe('running');
    expect(held?.leaseOwner).not.toBeNull();

    const finished = await running;
    expect(outcome(finished)).toBe('complete');
    expect(finished.attempts).toBe(1);

    // The space is open again and the person uses it. Nothing is still
    // running that could take that away.
    const kept = `job_${crypto.randomUUID()}`;
    await sql`insert into job (id, space_id, title, principal_id, objective, state)
      values (${kept}, ${seeded.spaceId}, 'New work', ${seeded.principalId}, 'After emptying', 'queued')`;
    await Bun.sleep(600);
    expect(mine(await other.resume())).toEqual([]);
    expect(await countOf(sql, 'job', sql`id = ${kept}`)).toBe(1);
  });

  test('a_removal_is_swept_once_in_this_process — even when its lease looks lapsed', async () => {
    const seeded = await seed('shared');
    let sweeps = 0;
    const counting: SandboxTeardown = {
      providerFor: () => ({}),
      destroyWorkspacesForSpace: async (spaceId) => {
        // Other tests' removals are resumed too; only this space's sweeps count.
        if (spaceId !== seeded.spaceId) return { closed: [], snapshotsDeleted: [] };
        sweeps += 1;
        await Bun.sleep(1_000);
        return { closed: [], snapshotsDeleted: [] };
      },
      listWorkspacesForSpace: async () => ({ sessions: [], snapshots: [] }),
    };
    // A lease long enough that the heartbeat does not renew it during the test.
    const removals = await service({ sandboxes: counting, leaseMs: 60_000 });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const running = removals.run(fenced.id);
    await Bun.sleep(300);
    // The lease reads as lapsed, as it would after the event loop stalled.
    // The timer's pass in this same process must not start a second sweep.
    await sql`update space_removal set lease_expires_at = now() - interval '1 second'
      where id = ${fenced.id}`;
    await removals.resume();
    const finished = await running;
    expect(outcome(finished)).toBe('complete');
    expect(sweeps).toBe(1);
    expect(finished.attempts).toBe(1);
  });

  test('an_emptying_stops_the_job_holding_its_workspace_first — and then removes it', async () => {
    const seeded = await seed('personal');
    const workspace = join(workRoot, seeded.jobId);
    const release = await holdDirectory(workspace);
    const stopped: string[][] = [];
    try {
      const removals = await service({
        // The runner's stop, here letting go of the hold as a stopped job does.
        stopJobs: async (jobIds) => {
          stopped.push([...jobIds]);
          await release();
        },
      });
      const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      const finished = await removals.run(fenced.id);
      expect(outcome(finished)).toBe('complete');
      expect(stopped[0]).toContain(seeded.jobId);
      expect(await exists(workspace)).toBe(false);
    } finally {
      await release();
    }
  });

  test.if(canHold)(
    'a_held_workspace_does_not_lock_the_person_out — the emptied space opens again, and the workspace goes when let go',
    async () => {
      const seeded = await seed('personal');
      const workspace = join(workRoot, seeded.jobId);
      const release = await holdDirectory(workspace);
      const removals = await service({ retryMs: 60_000 });
      const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      const made = join(spacesRoot, seeded.spaceId, 'knowledge', 'after-emptying.md');
      try {
        const left = await removals.run(fenced.id);
        // Everything of the space has gone but a workspace a job still holds.
        expect(left.state).toBe('cleaning');
        expect(left.blockedReason).toContain(seeded.jobId);
        expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
        // The space is open again, and its owner can work in it.
        const [open] = await sql<{ removed_at: Date | null }[]>`select removed_at from space
          where id = ${seeded.spaceId}`;
        expect(open?.removed_at).toBeNull();
        expect((await spaceAuthority(db, seeded.spaceId, seeded.principalId)).role).toBe('owner');
        await mkdir(join(spacesRoot, seeded.spaceId, 'knowledge'), { recursive: true });
        await writeFile(made, 'written after the space opened again');

        // Tried again while still held: still cleaning, and only the workspace
        // was touched, never the space directory that is in use.
        const again = await removals.run(fenced.id);
        expect(again.state).toBe('cleaning');
        expect(await exists(made)).toBe(true);
      } finally {
        await release();
      }
      const finished = await removals.run(fenced.id);
      expect(outcome(finished)).toBe('complete');
      expect(await exists(workspace)).toBe(false);
      expect(await exists(made)).toBe(true);
    },
  );

  test.if(canHold)("a cleaning retry leaves a newly created job's workspace alone", async () => {
    const seeded = await seed('personal');
    const release = await holdDirectory(join(workRoot, seeded.jobId));
    const removals = await service({ retryMs: 60_000 });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    // A job the person starts once the space is open again, with its own workspace.
    const fresh = join(workRoot, `job_${crypto.randomUUID().replaceAll('-', '')}`);
    try {
      expect((await removals.run(fenced.id)).state).toBe('cleaning');
      await mkdir(fresh, { recursive: true });
      await writeFile(join(fresh, 'notes.md'), 'new work');

      const again = await removals.run(fenced.id);
      expect(again.state).toBe('cleaning');
      expect(again.blockedReason ?? '').not.toContain(fresh);
      expect(await exists(join(fresh, 'notes.md'))).toBe(true);
    } finally {
      await release();
    }
    const finished = await removals.run(fenced.id);
    expect(outcome(finished)).toBe('complete');
    expect(await exists(join(workRoot, seeded.jobId))).toBe(false);
    expect(await exists(join(fresh, 'notes.md'))).toBe(true);
  });

  test.if(canHold)(
    'a_removal_that_could_not_finish_is_tried_again_soon — by the running service, without a restart',
    async () => {
      const seeded = await seed('personal');
      const release = await holdDirectory(join(workRoot, seeded.jobId));
      const removals = await service({ retryMs: 1_000 });
      const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
      try {
        expect((await removals.run(fenced.id)).state).toBe('cleaning');
        // Not tried again before its pause is up.
        expect((await removals.resume()).map((row) => row.id)).not.toContain(fenced.id);
      } finally {
        await release();
      }
      // The service's own timer tries it again once it is due.
      removals.start();
      try {
        let state = '';
        for (let tick = 0; tick < 40 && state !== 'complete'; tick += 1) {
          await Bun.sleep(250);
          state = (await removals.byId(fenced.id))?.state ?? '';
        }
        expect(state).toBe('complete');
      } finally {
        removals.stop();
        await removals.drain();
      }
    },
  );

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
    await sql`insert into browser_site_profile (space_id, domain, label)
      values (${seeded.spaceId}, 'mail.test', 'mail.test')`;
    const profile = join(spacesRoot, seeded.spaceId, 'browser');
    await mkdir(join(profile, 'Default'), { recursive: true });
    await writeFile(join(profile, 'Default', 'Cookies'), 'session=signed-in');
    const released: string[] = [];

    // Stopped straight after the browser phase: what is gone by then went
    // through the browser's own teardown, not the filesystem sweep after it.
    const halting = new AbortController();
    const removals = await service({
      browser: browserSites(released),
      onPhase: (_id, phase) => {
        if (phase === 'browser') halting.abort();
      },
    });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    await removals.run(fenced.id, halting.signal);
    expect(released).toEqual([seeded.spaceId]);
    expect(await exists(profile)).toBe(false);
    expect(await countOf(sql, 'browser_site_profile', sql`space_id = ${seeded.spaceId}`)).toBe(0);
    // The space root is the filesystem phase's, and it has not run yet.
    expect(await exists(join(spacesRoot, seeded.spaceId))).toBe(true);

    const finished = await removals.run(fenced.id);
    expect(outcome(finished)).toBe('complete');
    // The fixture's site and this one, both cleared on the first pass.
    expect(finished.counts).toMatchObject({ cleared: { signed_in_sites: 2 } });
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

  test('plugin_servers_go_with_the_space — a running one is retired, and a stopped one’s data goes too', async () => {
    const seeded = await seed('shared');
    const served = newId('conn');
    const unserved = newId('conn');
    for (const id of [served, unserved])
      await sql`insert into connection (id, space_id, provider, label, scopes)
        values (${id}, ${seeded.spaceId}, 'mcp', 'A plugin', '[]'::jsonb)`;
    // The service's own wiring: a launcher that keeps volumes, and a registry that releases them.
    const launcher = new FakeStdioLauncher();
    const registry = new ConnectorRegistry().addReleaser((id) => launcher.destroy(id));
    const retired: string[] = [];
    registry.register(served, {
      manifest: emailManifest,
      retire: async () => {
        retired.push(served);
      },
    } as never);

    const removals = await service({ connectors: registry });
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'The Ledger');
    const finished = await removals.run(fenced.id);
    expect(outcome(finished)).toBe('complete');
    // The running server is retired, which stops its container, and both connections' kept
    // volumes are released, the one no connector was serving included.
    expect(retired).toEqual([served]);
    // Every connection the space had is released; these two are the plugin's.
    expect(launcher.destroyed).toEqual(expect.arrayContaining([served, unserved]));
    expect(registry.get(served)).toBeUndefined();
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

  test('resuming_holds_nothing_up — start returns at once, and a shutdown waits for what it started', async () => {
    const seeded = await seed('shared');
    const fencing = await service();
    const fenced = await fencing.fence(seeded.principalId, seeded.spaceId, 'The Ledger');

    // A process starting while that removal is pending, with a provider slow
    // to answer. Starting does not wait for the sweep.
    const removals = await service({ sandboxes: slowSandboxes(1_000) });
    const began = performance.now();
    removals.start();
    expect(performance.now() - began).toBeLessThan(200);
    try {
      // A shutdown waits for the sweep the timer started, not only for ones a
      // request did, so the database is not closed under it.
      await removals.drain();
      expect(outcome(await removals.byId(fenced.id))).toBe('complete');
    } finally {
      removals.stop();
    }
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

    test('deleting_a_space_tells_nobody_whether_it_exists — the same answer as every other route', async () => {
      const target = await seed('shared', 'Secret');
      const outsider = await seed('shared', 'Mine');
      const remove = (id: string) =>
        call(outsider.memberSessionToken, `/spaces/${id}`, 'DELETE', { confirm_name: 'Secret' });
      const existing = await remove(target.spaceId);
      const missing = await remove(`sp_${crypto.randomUUID().replaceAll('-', '')}`);
      const other = await call(
        outsider.memberSessionToken,
        `/spaces/${target.spaceId}/removal/preview`,
      );
      expect([existing.status, missing.status, other.status]).toEqual([403, 403, 403]);
      expect(await missing.json()).toEqual(await existing.json());
      expect(await countOf(sql, 'space_removal', sql`space_id = ${target.spaceId}`)).toBe(0);
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
