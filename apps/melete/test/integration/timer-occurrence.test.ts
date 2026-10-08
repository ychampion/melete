/**
 * A reminder set in a conversation is the conversation waiting on a timer
 * (`job.wait`). When the timer comes due, the attempt it starts is that
 * moment, and is told so: otherwise it reads the request that set the timer
 * ("remind me at 14:44 to stretch") and answers by setting it up again.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { renderInput } from '@melete/runtime-hermes';
import { eq } from 'drizzle-orm';
import { requestRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { job, space } from '../../src/db/schema.ts';
import { appendEvent } from '../../src/events/store.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const KEY = 'timer-occurrence-signing-key-32-bytes!';
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY, scopes: ['job.wait'] })
  : null;

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

async function claimNow(row: JobRow) {
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'timer',
    }),
  );
}

/** A conversation that asked for a reminder: its first turn sets the timer and rests. */
async function waitingOnTimer(wakeAt: string, restored = false) {
  const spaceId = newId('sp');
  await required(handle).db.insert(space).values({ id: spaceId, name: 'Timer', gitPath: spaceId });
  const created = await required(jobs).create({
    space_id: spaceId,
    title: 'Stretch reminder',
    objective: 'At 14:44 UTC today, send me a one-time reminder to stretch my back.',
  });
  const first = await claimNow(created);
  // The first turn is the setting up, so nothing tells it a time has come.
  expect(first.bundle.inputs.trigger_events).toEqual([]);
  const wait = { kind: 'timer' as const, wake_at: wakeAt };
  if (restored)
    // A turn that ended without choosing a wait gets back the one it was told was cancelled.
    await required(jobs).transaction((tx) =>
      appendEvent(tx, {
        jobId: created.id,
        attemptId: first.claims.attempt_id,
        type: 'notice',
        payload: { kind: 'wait_restored', wait },
        dedupKey: `${first.claims.attempt_id}:wait-restored`,
      }),
    );
  else await requestRuntimeWait(required(handle).sql, first.claims, wait);
  await required(runner).commitOutcome(first.claims, { kind: 'waiting_for_event_or_time', wait });
  const rested = await required(jobs).get(created.id);
  expect(rested.state).toBe('waiting_for_event_or_time');
  return rested;
}

withDb('a timer the agent set', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('coming due starts an attempt that is told this is the moment to remind', async () => {
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const rested = await waitingOnTimer(wakeAt);
    // The clock reaches the timer.
    await required(handle)
      .db.update(job)
      .set({ nextWakeAt: new Date(Date.now() - 1000) })
      .where(eq(job.id, rested.id));
    const fired = await claimNow(await required(jobs).get(rested.id));
    expect(fired.bundle.inputs.trigger_events).toEqual([{ kind: 'timer_fired', wake_at: wakeAt }]);
    const input = renderInput(fired.bundle);
    expect(input).toContain(
      `## The time you were waiting for has come\n\nThis turn was started by the timer you set with job.wait for ${wakeAt}.`,
    );
    expect(input).toContain('a reminder is given to the person now, as the reminder itself');
    await required(runner).commitOutcome(fired.claims, {
      kind: 'waiting_for_input',
      question: 'Time to stretch your back. Want another one later?',
    });

    // A later wake for another reason is not the timer again.
    await required(jobs).input(rested.id, 'Thanks!');
    const later = await claimNow(await required(jobs).get(rested.id));
    expect(later.bundle.inputs.trigger_events).toEqual([]);
    expect(renderInput(later.bundle)).not.toContain('The time you were waiting for has come');
  });

  test('a timer put back after a later turn is that moment too when it comes due', async () => {
    const wakeAt = new Date(Date.now() + 60_000).toISOString();
    const rested = await waitingOnTimer(wakeAt, true);
    await required(handle)
      .db.update(job)
      .set({ nextWakeAt: new Date(Date.now() - 1000) })
      .where(eq(job.id, rested.id));
    const fired = await claimNow(await required(jobs).get(rested.id));
    expect(fired.bundle.inputs.trigger_events).toEqual([{ kind: 'timer_fired', wake_at: wakeAt }]);
  });
});
