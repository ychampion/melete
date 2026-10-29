/**
 * Updating when quiet, through the real runner and queue: a drain lets running
 * work finish but claims nothing new, never reads as drained while an action
 * is on its way, and holds a timer that falls due until the drain is
 * cancelled or the service restarts. The busy report counts a running attempt
 * and a live process in an agent's computer.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AttemptOutcome, CreateJobRequest } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { action, attempt, connection, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { ATTEMPT_QUEUES, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { busyReport, Drain, dispatchingActions } from '../../src/operator/drain.ts';
import { StubRuntimeAdapter, type StubStep } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
// The waker looks often, so a held wake that is let go is seen at once.
const queue = handle ? await startQueue(handle.url, { dueScanMs: 500 }) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'drain-test-signing-key-32-bytes-long';
const runners: AttemptRunner[] = [];
let spaceId = '';
/** Gates for stalled attempts, by job title. */
const gates = new Map<string, () => void>();

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

function runner() {
  const result = new AttemptRunner(
    fixture().jobs,
    new StubRuntimeAdapter({
      onStall: (_key, bundle) =>
        new Promise<void>((resolve) => gates.set(bundle.job.title, resolve)),
    }),
    { key },
  );
  runners.push(result);
  return result;
}

function drainFor(runner: AttemptRunner) {
  return new Drain({ runner, dispatching: () => dispatchingActions(fixture().handle.sql) });
}

const completed: AttemptOutcome = { kind: 'completed', summary: 'Done.', evidence: [] };

function create(title: string, steps: StubStep[], options: Partial<CreateJobRequest> = {}) {
  return fixture().jobs.create({
    space_id: spaceId,
    title,
    objective: 'Run when woken',
    ...options,
    constraints: { notes: JSON.stringify({ script: steps }) },
  });
}

async function attempts(jobId: string) {
  return fixture().handle.db.select().from(attempt).where(eq(attempt.jobId, jobId));
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, within = 8000) {
  const deadline = Date.now() + within;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(50);
    value = await read();
  }
  return value;
}

const stateOf = async (jobId: string) => (await fixture().jobs.get(jobId)).state;

beforeEach(async () => {
  if (!handle || !queue) return;
  for (const name of [...Object.values(ATTEMPT_QUEUES), QUEUES.recoveryScan])
    await queue.boss.deleteAllJobs(name);
  await resetTestRows(handle.sql);
  gates.clear();
  spaceId = newId('sp');
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
});

afterEach(async () => {
  for (const gate of gates.values()) gate();
  for (const worker of runners.splice(0)) await worker.stop();
});

afterAll(async () => {
  await queue?.stop();
  await handle?.close();
}, 15_000);

withDb('a drain', () => {
  test('stops new claims while a running attempt finishes, then reports drained', async () => {
    const worker = runner();
    await worker.start();
    const running = await create('running', [
      { type: 'stall', key: 'go' },
      { type: 'outcome', outcome: completed },
    ]);
    await eventually(async () => gates.has('running'), Boolean);
    const [first] = await attempts(running.id);
    const drain = drainFor(worker);
    const started = await drain.start(10);
    expect(started.state).toBe('draining');
    expect(started.running_attempts).toEqual([first?.id ?? '']);

    // A message arriving now queues, and nothing claims it.
    const later = await create('later', [{ type: 'outcome', outcome: completed }]);
    await Bun.sleep(1500);
    expect(await attempts(later.id)).toHaveLength(0);
    expect(await stateOf(later.id)).toBe('queued');
    expect((await drain.status()).state).toBe('draining');

    // The running attempt finishes, and the drain says so.
    gates.get('running')?.();
    expect(
      await eventually(
        () => stateOf(running.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
    const drained = await eventually(
      () => drain.status(),
      (status) => status.state === 'drained',
    );
    expect(drained.state).toBe('drained');
    expect(drained.running_attempts).toEqual([]);
    expect(await attempts(later.id)).toHaveLength(0);

    // Cancelled, the held message starts.
    expect((await drain.cancel()).state).toBe('off');
    expect(
      await eventually(
        () => stateOf(later.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
  }, 30_000);

  test('past its limit reports timed_out with what still runs, and stops nothing', async () => {
    let now = new Date();
    const worker = runner();
    await worker.start();
    const running = await create('long', [
      { type: 'stall', key: 'go' },
      { type: 'outcome', outcome: completed },
    ]);
    await eventually(async () => gates.has('long'), Boolean);
    const drain = new Drain({
      runner: worker,
      dispatching: () => dispatchingActions(fixture().handle.sql),
      now: () => now,
    });
    await drain.start(1);
    now = new Date(now.getTime() + 61_000);
    const status = await drain.status();
    expect(status.state).toBe('timed_out');
    expect(status.running_attempts).toHaveLength(1);
    expect(await stateOf(running.id)).toBe('running');
    gates.get('long')?.();
    expect(
      await eventually(
        () => stateOf(running.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
  }, 30_000);

  test('is never drained while an action is dispatching', async () => {
    const { handle } = fixture();
    const worker = runner();
    await worker.start();
    // An action sent by an attempt that has ended, whose service has not answered yet.
    const row = await create('sent', [{ type: 'outcome', outcome: completed }]);
    expect(
      await eventually(
        () => stateOf(row.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
    const [ended] = await attempts(row.id);
    const connectionId = newId('conn');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Mail', scopes: [] });
    const actionId = newId('act');
    await handle.db.insert(action).values({
      id: actionId,
      jobId: row.id,
      attemptId: ended?.id ?? '',
      connectionId,
      kind: 'test.send',
      effectClass: 'write_reversible',
      canonicalPayload: { to: 'someone' },
      payloadHash: 'a'.repeat(64),
      idempotencyKey: newId('act'),
      status: 'dispatched',
      dispatchedAt: new Date(),
    });
    const drain = drainFor(worker);
    const status = await drain.start(10);
    expect(worker.inFlight()).toEqual({ attempts: [], starting: [] });
    expect(status.state).toBe('draining');
    expect(status.dispatching_actions).toEqual([actionId]);
    await handle.db.update(action).set({ status: 'succeeded' }).where(eq(action.id, actionId));
    expect((await drain.status()).state).toBe('drained');
  }, 30_000);
});

withDb('a timer that falls due during a drain', () => {
  /** A first attempt that waits on a timer, and a second, once it fires, that completes. */
  const timer = (wakeAt: number): StubStep[] => [
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

  async function heldTimer(worker: AttemptRunner) {
    await worker.start();
    const row = await create('timer', timer(Date.now() + 1500));
    expect(
      await eventually(
        () => stateOf(row.id),
        (state) => state === 'waiting_for_event_or_time',
      ),
    ).toBe('waiting_for_event_or_time');
    const drain = drainFor(worker);
    await drain.start(10);
    // Due, and sent to the queue by the waker and the recovery scan, and still held.
    await Bun.sleep(2500);
    await fixture().queue.boss.send(QUEUES.recoveryScan, {});
    await Bun.sleep(1000);
    expect(await attempts(row.id)).toHaveLength(1);
    expect(await stateOf(row.id)).toBe('waiting_for_event_or_time');
    expect((await drain.status()).state).toBe('drained');
    return { row, drain };
  }

  test('runs once the drain is cancelled', async () => {
    const { row, drain } = await heldTimer(runner());
    await drain.cancel();
    expect(
      await eventually(
        () => stateOf(row.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
    expect(await attempts(row.id)).toHaveLength(2);
  }, 30_000);

  test('runs after the service restarts, whose drain is gone', async () => {
    const before = runner();
    const { row } = await heldTimer(before);
    await before.stop();
    // A new process: its runner holds nothing, and its recovery finds the due timer.
    await runner().start();
    expect(
      await eventually(
        () => stateOf(row.id),
        (state) => state === 'completed',
      ),
    ).toBe('completed');
    expect(await attempts(row.id)).toHaveLength(2);
  }, 30_000);
});

withDb('the busy report', () => {
  test('counts a running attempt and a live process in an agent’s computer', async () => {
    const { handle } = fixture();
    const worker = runner();
    await worker.start();
    const row = await create('busy', [
      { type: 'stall', key: 'go' },
      { type: 'outcome', outcome: completed },
    ]);
    await eventually(async () => gates.has('busy'), Boolean);
    const [running] = await attempts(row.id);
    const connectionId = newId('conn');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'sandbox', label: 'Computer', scopes: [] });
    const agentId = newId('agent');
    await handle.sql`insert into agent (id, space_id, name, role, colour, surface, eye_colour, tone,
        standing_instruction)
      values (${agentId}, ${spaceId}, 'Scout', 'Researcher', '#6FA3C7', 'octagon', '#12293A', 'Curious', 'Cite')`;
    const processId = 'prc_dev_server';
    await handle.sql`insert into sandbox_process (id, space_id, agent_id, connection_id,
        command_redacted, command_digest, cwd, name, state, expires_at)
      values (${processId}, ${spaceId}, ${agentId}, ${connectionId}, 'npm run dev', 'digest', '.',
        'dev server', 'running', now() + interval '1 hour')`;

    const busy = await busyReport(handle.sql, 'off');
    expect(busy.running_attempts).toEqual({ count: 1, ids: [running?.id ?? ''] });
    expect(busy.live_processes).toEqual({ count: 1, ids: [processId] });
    expect(busy.actions_dispatching.count).toBe(0);
    expect(busy.runs_mid_shift.count).toBe(0);
    expect(busy.time_zone).toBe('UTC');
    gates.get('busy')?.();
  }, 30_000);
});
