import { afterAll, describe, expect, test } from 'bun:test';
import { testDatabase } from '../../test/helpers/database.ts';
import { brokerQueueOptions } from '../broker/start.ts';
import { startQueue } from './queue.ts';
import { workQuiet } from './quiet.ts';

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
