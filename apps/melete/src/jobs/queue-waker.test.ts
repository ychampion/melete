import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { brokerQueueOptions } from '../broker/start.ts';
import { databaseNow } from '../db/clock.ts';
import { type AttemptWake, enqueueWake, QUEUES, startQueue } from './queue.ts';
import { DUE_SCAN_MS, DUE_WAKE_CHANNEL, startDueWaker, workQuiet } from './quiet.ts';

const handle = await testDatabase();
afterAll(async () => handle?.close());
const withDb = handle ? describe : describe.skip;

async function until(check: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  return check();
}

test('the broker leaves waking due jobs to the service', () => {
  expect(brokerQueueOptions({}).dueWaker).toBe(false);
  expect(brokerQueueOptions({}).createSchema).toBe(true);
  expect(brokerQueueOptions({ MELETE_EFFECTS_DATABASE_URL: 'postgres://x/y' }).createSchema).toBe(
    false,
  );
});

withDb('the due-job waker', () => {
  test('a short future attempt inserted after an empty scan starts within a second of due', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const queue = await startQueue(handle.url, { dueWaker: false });
    const db = queue.boss.getDb();
    const execute = db.executeSql.bind(db);
    let emptyScan = false;
    const query = spyOn(db, 'executeSql').mockImplementation(async (text, values) => {
      const result = await execute(text, values);
      if (text.includes('extract(epoch from min(start_after)')) {
        expect(result.rows).toHaveLength(0);
        emptyScan = true;
      }
      return result;
    });
    let ran: number | undefined;
    let waker: ReturnType<typeof startDueWaker> | undefined;
    try {
      const id = await workQuiet<AttemptWake>(
        queue.boss,
        QUEUES.attempt,
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
        async () => {
          ran = Date.now();
        },
      );
      // lastFetchedOn is set after the real empty fetch completes, before the worker sleeps.
      expect(
        await until(
          () =>
            queue.boss
              .getWipData()
              .some((worker) => worker.id === id && worker.lastFetchedOn !== null),
          2000,
        ),
      ).toBe(true);
      waker = startDueWaker(queue.boss);
      expect(await until(() => emptyScan, 2000)).toBe(true);
      // Let the scan's promise continuations arm the normal five-second fallback.
      await Bun.sleep(0);
      query.mockRestore();
      const due = Date.now() + 250;
      await handle.db.transaction((tx) =>
        enqueueWake(
          queue.boss,
          tx,
          {
            job_id: 'job_short_future',
            expected_epoch: 0,
            expected_version: 0,
            reason: 'timer',
          },
          new Date(due),
        ),
      );
      expect(await until(() => ran !== undefined, DUE_SCAN_MS + 1500)).toBe(true);
      const late = (ran ?? Number.POSITIVE_INFINITY) - due;
      console.info(`short future wake: ${late} ms after due`);
      // Date.now and the pg-boss millisecond timestamp may differ by one millisecond.
      expect(late).toBeGreaterThanOrEqual(-2);
      expect(late).toBeLessThan(1000);
    } finally {
      query.mockRestore();
      await waker?.stop();
      await queue.stop();
    }
  }, 15_000);

  test('rollback publishes no wake or hint; immediate work uses its existing notice', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const queue = await startQueue(handle.url, { dueScanMs: 100 });
    let hints = 0;
    let ran = 0;
    const listener = await queue.boss.getDb().listen?.(
      DUE_WAKE_CHANNEL,
      () => {
        hints++;
      },
      () => {},
    );
    expect(listener).toBeDefined();
    const wake: AttemptWake = {
      job_id: 'job_rollback',
      expected_epoch: 0,
      expected_version: 0,
      reason: 'timer',
    };
    try {
      await workQuiet(
        queue.boss,
        QUEUES.attempt,
        { batchSize: 1, pollingIntervalSeconds: 0.5 },
        async () => {
          ran++;
        },
      );
      await expect(
        handle.db.transaction(async (tx) => {
          await enqueueWake(queue.boss, tx, wake, new Date(Date.now() + 250));
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await Bun.sleep(600);
      expect(hints).toBe(0);
      expect(ran).toBe(0);
      await handle.db.transaction(async (tx) =>
        enqueueWake(queue.boss, tx, wake, await databaseNow(tx)),
      );
      expect(await until(() => ran === 1, 1000)).toBe(true);
      expect(hints).toBe(0);
    } finally {
      await listener?.close();
      await queue.stop();
    }
  });

  test('two instances and repeated hints execute each future wake once across queues', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const first = await startQueue(handle.url);
    const second = await startQueue(handle.url);
    const runs: { id: string; at: number }[] = [];
    try {
      for (const queue of [first, second])
        for (const name of [QUEUES.background, QUEUES.quiet]) {
          await workQuiet<AttemptWake>(
            queue.boss,
            name,
            { batchSize: 1, pollingIntervalSeconds: 0.5 },
            async (jobs) => {
              for (const job of jobs) runs.push({ id: job.data.job_id, at: Date.now() });
            },
          );
        }
      const due = Date.now() + 250;
      for (const scheduling of ['background', 'quiet'] as const) {
        await handle.db.transaction((tx) =>
          enqueueWake(
            first.boss,
            tx,
            {
              job_id: `job_${scheduling}`,
              expected_epoch: 0,
              expected_version: 0,
              reason: 'timer',
            },
            new Date(due),
            scheduling,
          ),
        );
      }
      for (let i = 0; i < 8; i++) await handle.sql`select pg_notify(${DUE_WAKE_CHANNEL}, '')`;
      expect(await until(() => runs.length === 2, 1500)).toBe(true);
      await Bun.sleep(300);
      expect(runs.map((r) => r.id).sort()).toEqual(['job_background', 'job_quiet']);
      for (const run of runs) {
        expect(run.at - due).toBeGreaterThanOrEqual(-2);
        expect(run.at - due).toBeLessThan(1000);
      }
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  /** Runs one job due shortly on a queue started with `options`; answers whether it ran in time. */
  async function ranInTime(name: string, options: { dueWaker?: boolean }) {
    if (!handle) throw new Error('Postgres unavailable');
    const queue = await startQueue(handle.url, { ...options, dueScanMs: 200 });
    let ran = false;
    try {
      await workQuiet(queue.boss, name, { batchSize: 1, pollingIntervalSeconds: 0.5 }, async () => {
        ran = true;
      });
      await queue.boss.send(name, {}, { startAfter: new Date(Date.now() + 300) });
      return await until(() => ran, 2500);
    } finally {
      await queue.stop();
    }
  }

  test('a queue started without one sends no notice when a job falls due', async () => {
    expect(await ranInTime('test.waker.off', { dueWaker: false })).toBe(false);
  });

  test('a queue started with one wakes its workers when the job falls due', async () => {
    expect(await ranInTime('test.waker.on', {})).toBe(true);
  });
});
