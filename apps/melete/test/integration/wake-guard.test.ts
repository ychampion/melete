/**
 * The wake guard: standing work woken thirty times within an hour, each time
 * resting again with nothing to show, is paused before the next wake starts
 * anything, and the person is told once. A wake that shows something starts
 * the count again, and so does resuming the work.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { type AttemptOutcome, runResponse } from '@melete/contracts';
import { and, eq, like, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { attempt, event, job, owner, pushIntent, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { WAKE_GUARD_LIMIT, WAKE_GUARD_MESSAGE } from '../../src/jobs/wake-guard.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'wake-guard-fixture-signing-key-32-bytes!';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
const runs = jobs ? new RunService(jobs) : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
if (runner && runs) attachRuns(runner, runs);
if (runs && triggers) runs.triggers = triggers;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      runs: runs ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'wake-guard@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}`, ownerPrincipalId: ownerId });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function start(goal: string) {
  const response = await request('/runs', 'POST', { goal, repeat: { cron: '*/5 * * * *' } });
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;
const row = async (id: string) => required(jobs).get(id);

/** Claims the run's next shift if one may start; null when none does. */
async function claim(id: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await row(id);
  return required(runner).claim({
    job_id: id,
    expected_epoch: current.leaseEpoch,
    expected_version: current.stateVersion,
    reason: 'timer',
  });
}
const done = (summary = ''): AttemptOutcome => ({ kind: 'completed', summary, evidence: [] });
let occurrence = 0;
async function fire(id: string) {
  const [registration] = await required(handle)
    .db.select()
    .from(trigger)
    .where(eq(trigger.jobId, id));
  await required(triggers).fireSchedule(required(registration).id, `occ-${++occurrence}`);
}
/** The schedule fires, the shift looks, finds nothing to say, and rests again. */
async function quietWake(id: string) {
  await fire(id);
  expect((await row(id)).state).toBe('queued');
  const shift = required(await claim(id));
  await required(runner).commitOutcome(shift.claims, done());
  expect((await row(id)).state).toBe('waiting_for_event_or_time');
  return shift;
}
const told = async (id: string) => ({
  notices: await required(handle)
    .db.select()
    .from(event)
    .where(and(eq(event.jobId, id), sql`${event.payload}->>'reason' = 'wake_guard'`)),
  pushes: await required(handle)
    .db.select()
    .from(pushIntent)
    .where(like(pushIntent.dedupKey, `wake-guard:${id}:%`)),
});

withDb('the wake guard', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a run woken thirty times an hour with nothing to show is paused and the person told once', async () => {
    const run = await start('Watch the supplier price list and tell me when oak changes');
    // The first shift reports what it found, which the person sees.
    const first = required(await claim(run.id));
    await required(runs).call(first.claims, 'run.log', {
      kind: 'report',
      title: 'Oak panels are $51',
    });
    await required(runner).commitOutcome(first.claims, done('Baseline recorded.'));

    for (let wake = 0; wake < WAKE_GUARD_LIMIT; wake++) await quietWake(run.id);
    const woken = await required(handle)
      .db.select({ usageClass: attempt.usageClass, outcome: attempt.outcome })
      .from(attempt)
      .where(eq(attempt.jobId, run.id))
      .orderBy(attempt.epoch);
    expect(woken.slice(1)).toHaveLength(WAKE_GUARD_LIMIT);
    for (const shift of woken.slice(1))
      expect(shift).toEqual({ usageClass: 'background', outcome: 'waiting_for_event_or_time' });
    expect((await told(run.id)).notices).toHaveLength(0);

    // The next wake starts nothing: the run is paused, its schedule is off,
    // and the person is told, once, in plain words.
    await fire(run.id);
    expect(await claim(run.id)).toBeNull();
    const paused = await row(run.id);
    expect(paused.paused).toBe(true);
    const schedules = await required(handle)
      .db.select({ enabled: trigger.enabled })
      .from(trigger)
      .where(eq(trigger.jobId, run.id));
    expect(schedules.map((schedule) => schedule.enabled)).toEqual([false]);
    const shown = await view(run.id);
    expect(shown.status_line).toStartWith('Paused');
    const once = await told(run.id);
    expect(once.notices).toHaveLength(1);
    expect(once.notices[0]?.payload).toMatchObject({
      kind: 'run_paused',
      reason: 'wake_guard',
      message: WAKE_GUARD_MESSAGE,
    });
    expect(once.pushes).toHaveLength(1);
    expect(once.pushes[0]).toMatchObject({
      principalId: ownerId,
      kind: 'progress',
      body: WAKE_GUARD_MESSAGE,
      url: `/#/runs/${run.id}`,
    });

    // Asked again, it still starts nothing and says nothing more.
    expect(await claim(run.id)).toBeNull();
    await fire(run.id);
    expect(await claim(run.id)).toBeNull();
    const still = await told(run.id);
    expect([still.notices.length, still.pushes.length]).toEqual([1, 1]);
    const count = await required(handle)
      .db.select({ id: attempt.id })
      .from(attempt)
      .where(eq(attempt.jobId, run.id));
    expect(count).toHaveLength(WAKE_GUARD_LIMIT + 1);

    // Resumed, it runs again from a fresh count.
    expect((await request(`/runs/${run.id}/resume`, 'POST')).status).toBe(200);
    const resumed = required(await claim(run.id));
    await required(runner).commitOutcome(resumed.claims, done());
    await quietWake(run.id);
    expect((await row(run.id)).paused).toBe(false);
  });

  test('one wake that shows something starts the count again', async () => {
    const run = await start('Watch the walnut price and tell me when it moves');
    const first = required(await claim(run.id));
    await required(runs).call(first.claims, 'run.log', {
      kind: 'report',
      title: 'Walnut is $60',
    });
    await required(runner).commitOutcome(first.claims, done('Baseline recorded.'));
    for (let wake = 0; wake < WAKE_GUARD_LIMIT - 1; wake++) await quietWake(run.id);
    // This wake reports a finding to the person.
    await fire(run.id);
    const shown = required(await claim(run.id));
    await required(runs).call(shown.claims, 'run.log', {
      kind: 'report',
      title: 'Walnut is up 4%',
    });
    await required(runner).commitOutcome(shown.claims, done());
    for (let wake = 0; wake < WAKE_GUARD_LIMIT - 1; wake++) await quietWake(run.id);
    expect((await row(run.id)).paused).toBe(false);
    expect((await told(run.id)).notices).toHaveLength(0);
  });
});
