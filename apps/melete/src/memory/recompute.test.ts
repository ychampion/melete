import { afterAll, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { EventStream } from '../events/stream.ts';
import type { Commits } from '../ops/quiet-loop.ts';
import { enqueue, provisionMemorySpace } from './db.ts';
import { startJobRecompute } from './recompute.ts';

const handle = await testDatabase();
afterAll(async () => handle?.close());
const withDb = handle ? describe : describe.skip;

/** A change source the test fires by hand, as a committed event would. */
function commits() {
  const listeners = new Set<() => void>();
  const source: Commits = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    commit: () => {
      for (const listener of listeners) listener();
    },
  };
}

const ownerId = 'own_recompute';
let owner: Promise<unknown> | undefined;

async function memorySpace() {
  if (!handle) throw new Error('Postgres unavailable');
  const sql = handle.sql;
  // An installation has one owner.
  owner ??= sql`insert into owner (id, email) values (${ownerId}, 'recompute@example.test')`;
  await owner;
  const spaceId = `sp_recompute_${crypto.randomUUID().slice(0, 8)}`;
  await sql`insert into space (id, name, git_path) values (${spaceId}, 'Recompute', '/unused')`;
  await provisionMemorySpace(handle.sql, ownerId, spaceId);
  return spaceId;
}

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(10);
  return check();
}

withDb('job recompute delivery', () => {
  test('after a quiet spell, a committed invalidation is delivered at once', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const spaceId = await memorySpace();
    const changes = commits();
    const delivered: { jobId: string; at: number }[] = [];
    const recompute = startJobRecompute(
      handle.sql,
      async (jobId) => {
        delivered.push({ jobId, at: Date.now() });
      },
      { idleMs: 60_000, wakeOn: changes.source },
    );
    try {
      // Long enough to have backed off far past the quarter-second pace.
      await Bun.sleep(2000);
      await handle.sql.begin((tx) => enqueue(tx, spaceId, 'job_recompute', 'job_announced'));
      const committed = Date.now();
      changes.commit();
      expect(await until(() => delivered.length === 1, 2000)).toBe(true);
      expect(delivered[0]?.jobId).toBe('job_announced');
      expect((delivered[0]?.at ?? Number.POSITIVE_INFINITY) - committed).toBeLessThan(500);
    } finally {
      await recompute.stop();
    }
  });

  test('an invalidation nobody announced is still delivered within the idle wait', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const spaceId = await memorySpace();
    const changes = commits();
    const delivered: string[] = [];
    const recompute = startJobRecompute(
      handle.sql,
      async (jobId) => {
        delivered.push(jobId);
      },
      { idleMs: 1000, wakeOn: changes.source },
    );
    try {
      await Bun.sleep(1500);
      await handle.sql.begin((tx) => enqueue(tx, spaceId, 'job_recompute', 'job_unannounced'));
      expect(await until(() => delivered.includes('job_unannounced'), 2500)).toBe(true);
      await recompute.stop();
      const [row] = await handle.sql`select completed_at from memory_outbox
        where space_id = ${spaceId} and target_id = 'job_unannounced'`;
      expect(row?.completed_at).not.toBeNull();
    } finally {
      await recompute.stop();
    }
  });

  test('a memory change made outside any job wakes the loops through the change notice', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const spaceId = await memorySpace();
    // The service's own change source: LISTEN, with its slow repair tick kept out of the way.
    const events = new EventStream(handle, { repairMs: 120_000 });
    const delivered: { jobId: string; at: number }[] = [];
    const recompute = startJobRecompute(
      handle.sql,
      async (jobId) => {
        delivered.push({ jobId, at: Date.now() });
      },
      { idleMs: 60_000, wakeOn: events },
    );
    try {
      // LISTEN is up and the loop has backed off far past its quarter-second pace.
      await Bun.sleep(2500);
      // A direct edit writes no job event; only its queued work says it happened.
      await handle.sql.begin((tx) => enqueue(tx, spaceId, 'job_recompute', 'job_direct_edit'));
      const committed = Date.now();
      expect(await until(() => delivered.length === 1, 3000)).toBe(true);
      expect((delivered[0]?.at ?? Number.POSITIVE_INFINITY) - committed).toBeLessThan(1000);
    } finally {
      await recompute.stop();
      await events.close();
    }
  });
});
