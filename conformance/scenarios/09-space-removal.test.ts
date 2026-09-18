/**
 * Conformance 9. Deleting a space leaves nothing of it, and a restore does not
 * bring it back.
 *
 * This scenario needs no Docker. It uses a disposable database, the real
 * removal service, and fakes for the two providers that live outside the
 * installation — a sandbox host and a browser worker — because what is being
 * proved is that the removal calls them and then re-checks what they report,
 * not that either provider works. Everything else is the production path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { JobService } from '../../apps/melete/src/jobs/service.ts';
import { FileRestrictionJournal, restoreMemory } from '../../apps/melete/src/memory/restore.ts';
import {
  type BrowserTeardown,
  type SandboxTeardown,
  SpaceRemovalService,
} from '../../apps/melete/src/spaces/removal.ts';
import { testDatabase } from '../../apps/melete/test/helpers/database.ts';
import {
  type SeededSpace,
  seedFiles,
  seedSpace,
} from '../../apps/melete/test/integration/space-removal-fixture.ts';
import { scenario } from '../scenarios.ts';

/**
 * The fence cancels every job, and a cancelled job has no next wake, so the
 * queue is never reached. Naming the queue's type here would make the
 * conformance package depend on it for nothing.
 */
const noQueue = {} as ConstructorParameters<typeof JobService>[1];

const s = scenario(9);
const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

const root = await mkdtemp(join(tmpdir(), 'melete-conformance-9-'));
const spacesRoot = join(root, 'spaces');
const workRoot = join(root, 'work');
await mkdir(spacesRoot, { recursive: true });
await mkdir(workRoot, { recursive: true });

/** A sandbox host that really forgets, so the re-listing it is checked against is its own. */
function fakeSandboxes(): SandboxTeardown & { held: { sessions: string[]; snapshots: string[] } } {
  const held = { sessions: ['sbx_one'], snapshots: ['snap_one'] };
  return {
    held,
    providerFor: (adapter, connectionId) => ({ adapter, connectionId }),
    destroyWorkspacesForSpace: async () => {
      const closed = [...held.sessions];
      const snapshotsDeleted = [...held.snapshots];
      held.sessions = [];
      held.snapshots = [];
      return { closed, snapshotsDeleted };
    },
    listWorkspacesForSpace: async () => ({ ...held }),
  };
}

/**
 * A browser worker that removes the profile it is asked to forget and leaves
 * the space root alone, as the real one does.
 */
function fakeBrowser(): BrowserTeardown & { forgot: string[] } {
  const forgot: string[] = [];
  return {
    forgot,
    forgetSpace: async (spaceId) => {
      forgot.push(spaceId);
      const profile = join(spacesRoot, spaceId, 'browser');
      await rm(profile, { recursive: true, force: true });
      return { space_id: spaceId, profile, rows: 1 };
    },
  };
}

async function newJournal(): Promise<FileRestrictionJournal> {
  const journal = new FileRestrictionJournal(join(root, `journal-${crypto.randomUUID()}.jsonl`));
  await journal.initializeNew();
  return journal;
}

/** Every base table that keys rows to a space, read from the live catalog. */
async function rowsLeft(sql: Sql, spaceId: string): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }[]>`select c.table_name
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'space_id' and t.table_type = 'BASE TABLE'
    order by c.table_name`;
  const held: Record<string, number> = {};
  for (const row of tables) {
    const table = String(row.table_name);
    if (table === 'space_removal') continue;
    const [count] = await sql<{ count: number }[]>`select count(*)::int as count
      from ${sql(table)} where space_id = ${spaceId}`;
    if (Number(count?.count ?? 0) > 0) held[table] = Number(count?.count);
  }
  return held;
}

async function present(path: string): Promise<boolean> {
  try {
    await Bun.file(path).exists();
    const { access } = await import('node:fs/promises');
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The tables a database backup can put back on its own, in foreign-key order. */
const RESTORED = [
  'space',
  'space_membership',
  'memory_spaces',
  'memory_index_manifest',
  'memory_claims',
  'knowledge_record',
  'task',
] as const;

async function snapshot(sql: Sql, spaceId: string) {
  const taken: { table: string; rows: Record<string, unknown>[] }[] = [];
  for (const table of RESTORED) {
    const rows = (await (table === 'space'
      ? sql`select * from space where id = ${spaceId}`
      : sql`select * from ${sql(table)} where space_id = ${spaceId}`)) as Record<string, unknown>[];
    if (rows.length) taken.push({ table, rows });
  }
  return taken;
}

async function putBack(sql: Sql, taken: Awaited<ReturnType<typeof snapshot>>) {
  for (const { table, rows } of taken)
    for (const row of rows) {
      // A jsonb column comes back as an object and has to go back as JSON,
      // the same way a real restore hands it to the driver.
      const set = Object.fromEntries(
        Object.entries(row)
          .filter(([, value]) => value !== null)
          .map(([name, value]) => [
            name,
            // An untyped parameter is coerced to the target column's type, so
            // a jsonb column takes the JSON back as text.
            typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value,
          ]),
      );
      await sql`insert into ${sql(table)} ${sql(set as never)} on conflict do nothing`;
    }
}

withDb(`conformance 9: ${s.title}`, () => {
  if (!handle) return;
  const { sql } = handle;
  const sandboxes = fakeSandboxes();
  const browser = fakeBrowser();
  let seeded: SeededSpace;
  let journal: FileRestrictionJournal;
  let removals: SpaceRemovalService;
  let backup: Awaited<ReturnType<typeof snapshot>>;
  let finished: Awaited<ReturnType<SpaceRemovalService['run']>>;
  let filled: Record<string, number>;

  afterAll(async () => {
    await handle.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    seeded = await seedSpace(sql, {
      kind: 'shared',
      name: 'Conformance',
      spacesRoot,
      workRoot,
    });
    journal = await newJournal();
    removals = new SpaceRemovalService({
      db: handle.db,
      sql,
      // A cancelled job has no next wake, so the fence never reaches the queue.
      jobs: new JobService(handle.db, noQueue),
      journal,
      roots: { spacesRoot, workRoot },
      sandboxes,
      browser,
      leaseMs: 5_000,
    });
    filled = await rowsLeft(sql, seeded.spaceId);
    backup = await snapshot(sql, seeded.spaceId);
    const fenced = await removals.fence(seeded.principalId, seeded.spaceId, 'Conformance');
    finished = await removals.run(fenced.id);
  }, 120_000);

  test(s.assertions[0] ?? '', async () => {
    // The claim is only worth making against a space that had something
    // everywhere to begin with.
    expect(Object.keys(filled).length).toBeGreaterThan(20);
    expect(finished.state).toBe('complete');
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    const [space] = await sql`select id from space where id = ${seeded.spaceId}`;
    expect(space).toBeUndefined();
  });

  test(s.assertions[1] ?? '', async () => {
    for (const [table, where] of [
      ['submission', 'submission_id'],
      ['acceptance_journal', 'submission_id'],
      ['reply_obligation', 'submission_id'],
    ] as const) {
      const [row] = await sql`select 1 from ${sql(table)}
        where ${sql(where)} = ${seeded.submissionId}`;
      expect(row).toBeUndefined();
    }
    const [note] = await sql`select 1 from notification where id = ${seeded.notificationId}`;
    expect(note).toBeUndefined();
  });

  test(s.assertions[2] ?? '', async () => {
    expect(await present(join(spacesRoot, seeded.spaceId))).toBe(false);
    expect(await present(join(spacesRoot, seeded.spaceId, '.git'))).toBe(false);
    expect(browser.forgot).toEqual([seeded.spaceId]);
    expect(finished.counts).toMatchObject({ cleared: { signed_in_sites: 1 } });
  });

  test(s.assertions[3] ?? '', async () => {
    expect(await present(join(workRoot, seeded.jobId))).toBe(false);
  });

  test(s.assertions[4] ?? '', async () => {
    expect(sandboxes.held).toEqual({ sessions: [], snapshots: [] });
    expect(finished.counts).toMatchObject({
      providers: { sandbox_sessions: 0, sandbox_snapshots: 0 },
    });
  });

  test(s.assertions[5] ?? '', async () => {
    // read() re-verifies the chain and throws if a link does not match.
    const records = await journal.read();
    const mine = records.filter((record) => record.space_id === seeded.spaceId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.operation).toBe('remove_space');
  });

  test(s.assertions[6] ?? '', async () => {
    await putBack(sql, backup);
    await seedFiles(spacesRoot, workRoot, seeded.spaceId, seeded.jobId);
    const [restored] = await sql`select id from space where id = ${seeded.spaceId}`;
    expect(restored).toBeDefined();

    // The journal is retained apart from database snapshots, so the replay
    // still finds the record after the database has been rolled back.
    await restoreMemory(sql, journal);
    const [memory] = await sql<{ restore_ready: boolean; revoked: boolean }[]>`select restore_ready,
      revoked from memory_spaces where space_id = ${seeded.spaceId}`;
    expect(memory?.revoked).toBe(true);
    expect(memory?.restore_ready).toBe(false);
    const [queued] = await sql<{ state: string }[]>`select state from space_removal
      where space_id = ${seeded.spaceId} and state <> 'complete'`;
    expect(queued?.state).toBe('pending');
  });

  test(s.assertions[7] ?? '', async () => {
    const again = await removals.resume();
    expect(again.every((row) => row.state === 'complete')).toBe(true);
    expect(await rowsLeft(sql, seeded.spaceId)).toEqual({});
    expect(await present(join(spacesRoot, seeded.spaceId))).toBe(false);
    const [space] = await sql`select id from space where id = ${seeded.spaceId}`;
    expect(space).toBeUndefined();
  });

  test(s.assertions[8] ?? '', async () => {
    const other = await seedSpace(sql, {
      kind: 'shared',
      name: 'Refused',
      spacesRoot,
      workRoot,
    });
    const refusing = new SpaceRemovalService({
      db: handle.db,
      sql,
      jobs: new JobService(handle.db, noQueue),
      journal: await newJournal(),
      roots: { spacesRoot, workRoot },
      sandboxes: {
        providerFor: () => ({}),
        destroyWorkspacesForSpace: async () => {
          throw new Error('the sandbox provider could not be reached');
        },
        listWorkspacesForSpace: async () => ({ sessions: ['sbx_two'], snapshots: [] }),
      },
      leaseMs: 5_000,
    });
    const fenced = await refusing.fence(other.principalId, other.spaceId, 'Refused');
    const blocked = await refusing.run(fenced.id);
    expect(blocked.state).toBe('blocked');
    expect(blocked.state).not.toBe('complete');
    expect(blocked.finishedAt).toBeNull();
    const [space] = await sql`select id from space where id = ${other.spaceId}`;
    expect(space).toBeDefined();
  });

  test(s.assertions[9] ?? '', async () => {
    const personal = await seedSpace(sql, {
      kind: 'personal',
      name: 'Personal',
      spacesRoot,
      workRoot,
    });
    const service = new SpaceRemovalService({
      db: handle.db,
      sql,
      jobs: new JobService(handle.db, noQueue),
      journal: await newJournal(),
      roots: { spacesRoot, workRoot },
      leaseMs: 5_000,
    });
    const fenced = await service.fence(personal.principalId, personal.spaceId, 'Personal');
    const emptied = await service.run(fenced.id);
    expect(emptied.state).toBe('complete');
    expect(emptied.kind).toBe('emptied');

    const [space] = await sql<{ id: string; removed_at: string | null }[]>`select id, removed_at
      from space where id = ${personal.spaceId}`;
    expect(space?.id).toBe(personal.spaceId);
    expect(space?.removed_at).toBeNull();
    const [session] = await sql<{ space_id: string | null }[]>`select space_id from session
      where principal_id = ${personal.principalId}`;
    expect(session).toBeDefined();
    expect(session?.space_id).toBeNull();
    expect(await rowsLeft(sql, personal.spaceId)).toEqual({});
  });

  test(s.assertions[10] ?? '', async () => {
    const shared = await seedSpace(sql, {
      kind: 'shared',
      name: 'Guarded',
      spacesRoot,
      workRoot,
    });
    const service = new SpaceRemovalService({
      db: handle.db,
      sql,
      jobs: new JobService(handle.db, noQueue),
      journal: await newJournal(),
      roots: { spacesRoot, workRoot },
      leaseMs: 5_000,
    });
    await expect(service.fence(shared.memberId, shared.spaceId, 'Guarded')).rejects.toThrow(
      /owner/i,
    );

    // Nothing generates a tool that reaches this: a model's tools come from
    // connector manifests, and removal is not a connector.
    const { grantedToolCatalog, REACT_TOOL } = await import(
      '../../apps/melete/src/connectors/catalog.ts'
    );
    const { emailManifest } = await import('../../apps/melete/src/connectors/email.ts');
    const catalog = grantedToolCatalog(
      [{ id: shared.connectionId, provider: 'email', scopes: ['email.send'] }],
      { get: () => ({ manifest: emailManifest }) as never },
    );
    expect(catalog.filter((tool) => /space/.test(tool.name))).toEqual([]);
    expect(catalog.filter((tool) => tool.connection_id === null).map((tool) => tool.name)).toEqual([
      REACT_TOOL.name,
    ]);
  });
});
