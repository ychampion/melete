/**
 * Attempt workers wait for a notice instead of asking the database twice a
 * second. These follow a turn's wake through the real runner and pg-boss: the
 * notice its commit sends, the waker for one due later, the waker again for a
 * wake whose notice never came, and the recovery scan for one that never
 * reached the queue at all.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { AttemptOutcome, CreateJobRequest } from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import { attempt, space } from '../../src/db/schema.ts';
import type { Transaction } from '../../src/db/transaction.ts';
import { newId } from '../../src/ids.ts';
import {
  ATTEMPT_QUEUES,
  type AttemptWake,
  QUEUES,
  QUIET_QUEUES,
  type QueueHandle,
  startQueue,
} from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const key = 'attempt-wakes-signing-key-32-bytes!';
const runners: AttemptRunner[] = [];
let queue: QueueHandle | undefined;
let spaceId = '';

/** Long enough that a worker idle this long has had several chances to poll at the old pace. */
const SETTLE_MS = 1500;

function db() {
  if (!handle) throw new Error('Postgres unavailable');
  return handle;
}

function boss() {
  if (!queue) throw new Error('queue not started');
  return queue.boss;
}

function runner(jobs: JobService, concurrency?: number) {
  const result = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key,
    ...(concurrency ? { concurrency } : {}),
  });
  runners.push(result);
  return result;
}

function create(jobs: JobService, steps: StubStep[], options: Partial<CreateJobRequest> = {}) {
  return jobs.create({
    space_id: spaceId,
    title: 'Wake path',
    objective: 'Run when woken',
    ...options,
    constraints: { notes: JSON.stringify({ script: steps }) },
  });
}

const completed: AttemptOutcome = {
  kind: 'completed',
  summary: 'The requested result is ready.',
  evidence: [],
};

/** A first attempt that waits on a timer, and a second, once it fires, that completes. */
function timerThenDone(wakeAt: number): StubStep[] {
  return [
    {
      type: 'outcome',
      epoch: 1,
      outcome: {
        kind: 'waiting_for_event_or_time',
        wait: { kind: 'timer', wake_at: new Date(wakeAt).toISOString() },
      },
    },
    { type: 'outcome', epoch: 2, outcome: completed },
  ];
}

async function attempts(jobId: string) {
  return db().db.select().from(attempt).where(eq(attempt.jobId, jobId));
}

/** When the test first saw `count` attempts for the job, polling every 20 ms. */
async function seen(jobId: string, count: number, within: number): Promise<number | null> {
  const deadline = Date.now() + within;
  while (Date.now() < deadline) {
    if ((await attempts(jobId)).length >= count) return Date.now();
    await Bun.sleep(20);
  }
  return null;
}

async function state(jobs: JobService, jobId: string, wanted: string, within: number) {
  const deadline = Date.now() + within;
  while ((await jobs.get(jobId)).state !== wanted && Date.now() < deadline) await Bun.sleep(20);
  return (await jobs.get(jobId)).state;
}

/**
 * Commits each wake with the job, as the service does, but writes it straight
 * into the queue: no notice goes out, as when one is lost on its way.
 */
class SilentJobs extends JobService {
  override async enqueue(tx: Transaction, row: JobRow, reason: AttemptWake['reason']) {
    const wake: AttemptWake = {
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason,
    };
    await tx.execute(
      sql`insert into pgboss.job (name, data, retry_limit, expire_seconds)
        values (${QUEUES.attempt}, ${JSON.stringify(wake)}::jsonb, 0, 1800)`,
    );
  }
}

async function startQueueFor(dueScanMs: number) {
  queue = await startQueue(db().url, { dueScanMs });
  return new JobService(db().db, queue.boss);
}

beforeEach(async () => {
  if (!handle || !queue) return;
  for (const name of [...Object.values(ATTEMPT_QUEUES), QUEUES.recoveryScan])
    await queue.boss.deleteAllJobs(name);
  await resetTestRows(handle.sql);
  spaceId = newId('sp');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
});

afterEach(async () => {
  for (const worker of runners.splice(0)) await worker.stop();
});

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 15_000);

withDb('a wake sent with its commit', () => {
  // The waker looks only once a minute here, so whatever starts sooner was started by a notice.
  let jobs: JobService;
  beforeAll(async () => {
    jobs = await startQueueFor(60_000);
  });
  afterAll(async () => {
    await queue?.stop();
    queue = undefined;
  });

  test('every attempt, recovery and push queue is woken by notices', async () => {
    const names = [
      ...Object.values(ATTEMPT_QUEUES),
      QUEUES.legacyAttempt,
      QUEUES.recoveryScan,
      QUEUES.pushDispatch,
    ];
    for (const name of names) {
      expect(QUIET_QUEUES).toContain(name);
      expect((await boss().getQueue(name))?.notify).toBe(true);
    }
  });

  test('idle attempt workers stop asking the database for work', async () => {
    await runner(jobs).start();
    await Bun.sleep(SETTLE_MS);
    const fetched = () =>
      boss()
        .getWipData()
        .filter((wip) => wip.name === QUEUES.attempt)
        .map((wip) => wip.lastFetchedOn);
    const before = fetched();
    expect(before.length).toBeGreaterThan(0);
    await Bun.sleep(2500);
    // At the old half-second pace every worker would have fetched about five times by now.
    expect(fetched()).toEqual(before);
  }, 15_000);

  test('a new turn starts at once, from the notice its commit sends', async () => {
    await runner(jobs).start();
    await Bun.sleep(SETTLE_MS);
    const sent = Date.now();
    const row = await create(jobs, [{ type: 'outcome', outcome: completed }]);
    const started = await seen(row.id, 1, 5000);
    expect(started).not.toBeNull();
    expect((started ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(750);
    expect(await state(jobs, row.id, 'completed', 3000)).toBe('completed');
  }, 15_000);

  test('more turns due at once than there are workers all start without waiting for a look', async () => {
    // Committed while nothing runs them, so no notice is left to wake anyone once the
    // workers have each taken one: what is left is a backlog only they can find.
    const rows: JobRow[] = [];
    for (let i = 0; i < 5; i++)
      rows.push(await create(jobs, [{ type: 'outcome', outcome: completed }]));
    const sent = Date.now();
    // One slot, so two workers.
    await runner(jobs, 1).start();
    for (const row of rows) expect(await state(jobs, row.id, 'completed', 8000)).toBe('completed');
    // The waker looks only once a minute here, and an idle worker every half minute.
    expect(Date.now() - sent).toBeLessThan(5000);
  }, 20_000);

  test('a turn whose wake never reached the queue starts when the recovery scan is sent', async () => {
    await runner(jobs).start();
    // Only the send below may run the scan.
    await boss().unschedule(QUEUES.recoveryScan);
    // The first attempt sets a timer; its wake is then lost before it fires.
    const row = await create(jobs, timerThenDone(Date.now() + 1500));
    expect(await state(jobs, row.id, 'waiting_for_event_or_time', 5000)).toBe(
      'waiting_for_event_or_time',
    );
    await db()
      .sql`delete from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id}`;
    await Bun.sleep(2000);
    expect(await attempts(row.id)).toHaveLength(1);
    // What the schedule sends every minute.
    const sent = Date.now();
    await boss().send(QUEUES.recoveryScan, {});
    const started = await seen(row.id, 2, 5000);
    expect(started).not.toBeNull();
    expect((started ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(1500);
    expect(await state(jobs, row.id, 'completed', 3000)).toBe('completed');
  }, 20_000);
});

withDb('a wake no notice reaches', () => {
  const SCAN_MS = 1500;
  let jobs: JobService;
  beforeAll(async () => {
    jobs = await startQueueFor(SCAN_MS);
  });
  afterAll(async () => {
    await queue?.stop();
    queue = undefined;
  });

  test('a timer starts its turn when it falls due, not at the half-minute backstop', async () => {
    await runner(jobs).start();
    // Due further ahead than the waker looks, so it is found before it is due.
    const due = Date.now() + SCAN_MS + 2500;
    const row = await create(jobs, timerThenDone(due));
    const started = await seen(row.id, 2, SCAN_MS + 8000);
    expect(started).not.toBeNull();
    const late = (started ?? Number.POSITIVE_INFINITY) - due;
    expect(late).toBeGreaterThanOrEqual(-50);
    expect(late).toBeLessThan(1000);
  }, 20_000);

  test('a wake sent without a notice still starts within one look of the waker', async () => {
    await runner(jobs).start();
    await Bun.sleep(SETTLE_MS);
    const sent = Date.now();
    const row = await create(new SilentJobs(db().db, boss()), [
      { type: 'outcome', outcome: completed },
    ]);
    // The wake is in the queue, and nothing told the workers.
    expect(
      await db()
        .sql`select 1 from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id}`,
    ).toHaveLength(1);
    const started = await seen(row.id, 1, SCAN_MS + 8000);
    expect(started).not.toBeNull();
    expect((started ?? Number.POSITIVE_INFINITY) - sent).toBeLessThan(SCAN_MS + 1000);
  }, 20_000);
});
