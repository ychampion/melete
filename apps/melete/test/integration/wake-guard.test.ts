/**
 * The wake guard and what causes an attempt.
 *
 * Standing work woken thirty times within an hour, each time running the
 * model and resting again with nothing to show, is paused before the next
 * wake starts anything, and the person is told once. A finding or an effect
 * starts the count again, and so does resuming; reads alone do not. Pausing
 * loses nothing that arrives meanwhile. A wake refused at a spending limit is
 * not counted: the work rests until the limit resets, and the person is told
 * the limit. Only the person's own message, decision or start makes an
 * attempt interactive; a later wake in the same conversation is background.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  type AttemptOutcome,
  automationResponse,
  type JsonObject,
  jobBudget,
  runResponse,
} from '@melete/contracts';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import {
  attempt,
  connection,
  event,
  job,
  owner,
  pushIntent,
  space,
  trigger,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { backgroundLimitMessage, NO_LIMIT, SpendingGuard } from '../../src/gateway/spending.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import {
  attemptCause,
  WAKE_GUARD_LIMIT,
  WAKE_GUARD_MESSAGE,
  WAKE_GUARD_QUESTION,
} from '../../src/jobs/wake-guard.ts';
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
      triggers: triggers ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const mailId = newId('conn');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'wake-guard@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}`, ownerPrincipalId: ownerId });
  await handle.db
    .insert(connection)
    .values({ id: mailId, spaceId, provider: 'test', label: 'Work mail' });
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
async function start(goal: string, repeat = true) {
  const response = await request('/runs', 'POST', {
    goal,
    ...(repeat ? { repeat: { cron: '*/5 * * * *' } } : {}),
  });
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;
const row = async (id: string) => required(jobs).get(id);

/** Claims the job's next attempt if one may start; null when none does. */
async function claim(id: string, by: AttemptRunner = required(runner)) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
  const current = await row(id);
  return by.claim({
    job_id: id,
    expected_epoch: current.leaseEpoch,
    expected_version: current.stateVersion,
    reason: 'timer',
  });
}
/** The attempt called the model once, as the gateway records it. */
const ranModel = (attemptId: string) =>
  required(handle)
    .sql`update attempt set usage = usage || '{"requests": 1}'::jsonb where id = ${attemptId}`;
const done = (summary = ''): AttemptOutcome => ({ kind: 'completed', summary, evidence: [] });
const timer = (): AttemptOutcome => ({
  kind: 'waiting_for_event_or_time',
  wait: { kind: 'timer', wake_at: new Date(Date.now() + 3_600_000).toISOString() },
});
let occurrence = 0;
async function fire(id: string) {
  const [registration] = await required(handle)
    .db.select()
    .from(trigger)
    .where(and(eq(trigger.jobId, id), eq(trigger.kind, 'schedule')));
  await required(triggers).fireSchedule(required(registration).id, `occ-${++occurrence}`);
}
const mail = (key: string, payload: JsonObject) =>
  required(triggers).deliver({
    connection_id: mailId,
    event_name: 'mail.new',
    cursor: key,
    dedup_key: `${key}-${randomBytes(4).toString('hex')}`,
    payload,
  });
/** The schedule fires, the shift runs the model, finds nothing to say, and rests again. */
async function quietWake(id: string) {
  await fire(id);
  expect((await row(id)).state).toBe('queued');
  const shift = required(await claim(id));
  await ranModel(shift.claims.attempt_id);
  await required(runner).commitOutcome(shift.claims, done());
  expect((await row(id)).state).toBe('waiting_for_event_or_time');
  return shift;
}
/** A run standing on new mail, its first shift (the person's) already done. */
async function mailWatch(goal: string, by: AttemptRunner = required(runner)) {
  const run = await start(goal, false);
  const first = required(await claim(run.id, by));
  await required(runs).call(first.claims, 'run.checkpoint', {
    summary: 'Set up.',
    next: 'Look at the next mail.',
    next_shift: { kind: 'event', connection_id: mailId, event_name: 'mail.new' },
  });
  await by.commitOutcome(first.claims, done());
  return run;
}
const told = async (id: string, reason = 'wake_guard') => ({
  notices: await required(handle)
    .db.select()
    .from(event)
    .where(and(eq(event.jobId, id), sql`${event.payload}->>'reason' = ${reason}`)),
  pushes: await required(handle)
    .db.select()
    .from(pushIntent)
    .where(
      like(
        pushIntent.dedupKey,
        `${reason === 'wake_guard' ? 'wake-guard' : 'spending-limit'}:${id}:%`,
      ),
    ),
});
const classes = async (id: string) =>
  (
    await required(handle)
      .db.select({ usageClass: attempt.usageClass })
      .from(attempt)
      .where(eq(attempt.jobId, id))
      .orderBy(asc(attempt.epoch))
  ).map((entry) => entry.usageClass);
/** Whether a claimed attempt was given this text, in its brief or its new events. */
const given = (claimed: { bundle: unknown }, text: string) =>
  JSON.stringify(claimed.bundle).includes(text);

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
    // The person started the run, so its first shift is theirs.
    expect(woken[0]?.usageClass).toBe('interactive');
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
    await ranModel(resumed.claims.attempt_id);
    await required(runner).commitOutcome(resumed.claims, done());
    await quietWake(run.id);
    expect((await row(run.id)).paused).toBe(false);
  });

  test('one wake with a finding starts the count again; notes and reads alone do not', async () => {
    const run = await start('Watch the walnut price and tell me when it moves');
    const first = required(await claim(run.id));
    await required(runs).call(first.claims, 'run.log', { kind: 'report', title: 'Walnut is $60' });
    await required(runner).commitOutcome(first.claims, done('Baseline recorded.'));
    for (let wake = 0; wake < WAKE_GUARD_LIMIT - 1; wake++) await quietWake(run.id);
    // This wake records a finding.
    await fire(run.id);
    const found = required(await claim(run.id));
    await ranModel(found.claims.attempt_id);
    await required(runs).call(found.claims, 'run.log', {
      kind: 'finding',
      title: 'Walnut is up 4%',
    });
    await required(runner).commitOutcome(found.claims, done());
    for (let wake = 0; wake < WAKE_GUARD_LIMIT - 1; wake++) await quietWake(run.id);
    expect((await row(run.id)).paused).toBe(false);
    expect((await told(run.id)).notices).toHaveLength(0);

    // One more quiet wake, this time writing a note and reading the mail: neither is progress.
    await fire(run.id);
    const reading = required(await claim(run.id));
    await ranModel(reading.claims.attempt_id);
    await required(runs).call(reading.claims, 'run.log', { kind: 'note', title: 'Nothing new' });
    await required(handle)
      .sql`insert into action (id, job_id, attempt_id, connection_id, kind, effect_class,
          canonical_payload, payload_hash, idempotency_key, status)
        values (${newId('act')}, ${run.id}, ${reading.claims.attempt_id}, ${mailId}, 'mail.read',
          'read', '{}'::jsonb, ${'0'.repeat(64)}, ${newId('op')}, 'succeeded')`;
    await required(runner).commitOutcome(reading.claims, done());
    await fire(run.id);
    expect(await claim(run.id)).toBeNull();
    expect((await row(run.id)).paused).toBe(true);
  });

  test('wakes that ran no model are not counted', async () => {
    const run = await start('Watch the cherry price and tell me when it moves');
    const first = required(await claim(run.id));
    await required(runs).call(first.claims, 'run.log', { kind: 'report', title: 'Cherry is $70' });
    await required(runner).commitOutcome(first.claims, done('Baseline recorded.'));
    for (let wake = 0; wake < WAKE_GUARD_LIMIT + 1; wake++) {
      await fire(run.id);
      const shift = required(await claim(run.id));
      await required(runner).commitOutcome(shift.claims, done());
    }
    expect((await row(run.id)).paused).toBe(false);
    expect((await told(run.id)).notices).toHaveLength(0);
  });

  test('mail that arrives while a watch is paused reaches it once it is resumed', async () => {
    const run = await mailWatch('Pay the invoice from Bob when it arrives');
    // Junk that each wakes the run, runs the model and finds nothing.
    let quiet = 0;
    for (let n = 0; n < WAKE_GUARD_LIMIT + 2; n++) {
      await mail(`junk${n}`, { from: `x${n}@sender.example`, subject: `Hello ${n}` });
      const shift = await claim(run.id);
      if (!shift) break;
      quiet++;
      await ranModel(shift.claims.attempt_id);
      await required(runner).commitOutcome(shift.claims, done());
    }
    expect(quiet).toBe(WAKE_GUARD_LIMIT);
    expect((await row(run.id)).paused).toBe(true);
    // The watch itself stays on, with its cursor where it was.
    const watches = await required(handle)
      .db.select({ enabled: trigger.enabled })
      .from(trigger)
      .where(and(eq(trigger.jobId, run.id), eq(trigger.kind, 'event')));
    expect(watches.map((watch) => watch.enabled)).toEqual([true]);

    // The real mail arrives while the run is paused.
    await mail('bob', { from: 'bob@supplier.example', subject: 'Invoice 7731 from Bob' });
    expect((await request(`/runs/${run.id}/resume`, 'POST')).status).toBe(200);
    // The held wake runs, rests, and the next wake brings Bob's mail.
    let saw = false;
    for (let shift = 0; shift < 3 && !saw; shift++) {
      const resumed = await claim(run.id);
      if (!resumed) break;
      saw = given(resumed, 'Invoice 7731');
      await required(runner).commitOutcome(resumed.claims, done());
    }
    expect(saw).toBe(true);
  });

  test('wakes refused at the background limit are not counted; the work rests until the limit resets and the person is told the limit', async () => {
    const window = (usd: number | null) => ({ usd, tokens: null });
    const guard = new SpendingGuard(required(handle).sql, {
      installation: { day: NO_LIMIT, month: NO_LIMIT },
      person: { day: NO_LIMIT, month: NO_LIMIT },
      background: { day: window(0.5), month: window(null) },
      noticePercent: 80,
    });
    const limited = new AttemptRunner(required(jobs), new StubRuntimeAdapter(), {
      key: KEY,
      spendingLimit: (jobId, usageClass) => guard.limitForJob(jobId, usageClass),
    });
    attachRuns(limited, required(runs));
    const run = await mailWatch('File supplier mail', limited);
    await required(handle)
      .sql`insert into model_usage (id, created_at, space_id, principal_id, purpose, provider, model,
          status, cost_usd, class, tier)
        values (${randomUUID()}, now(), ${spaceId}, ${ownerId}, 'memory', 'x', 'y', 'succeeded', 1,
          'background', 'service')`;
    for (let n = 0; n < WAKE_GUARD_LIMIT + 1; n++) {
      await mail(`order${n}`, { from: `p${n}@supplier.example`, subject: `Order ${n}` });
      const current = await row(run.id);
      if (current.state !== 'queued') continue;
      expect(await claim(run.id, limited)).toBeNull();
    }
    const after = await row(run.id);
    expect(after.paused).toBe(false);
    expect((await told(run.id)).notices).toHaveLength(0);
    // It rests until the day's limit resets, keeping the mail for then.
    const midnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
    const reset = new Date(midnight.getTime() + 86_400_000);
    expect(after.state).toBe('waiting_for_event_or_time');
    expect(after.wait).toEqual({ kind: 'timer', wake_at: reset.toISOString() });
    const limit = await told(run.id, 'spending_limit');
    expect(limit.notices).toHaveLength(1);
    expect(limit.notices[0]?.payload).toMatchObject({
      reason: 'spending_limit',
      message: backgroundLimitMessage('day', reset),
    });
    expect(limit.pushes).toHaveLength(1);
    // Once the limit resets, the work runs and the mail that came meanwhile reaches it.
    await required(handle).sql`delete from model_usage where principal_id = ${ownerId}`;
    await Bun.sleep(2_100);
    let saw = false;
    for (let shift = 0; shift < 3 && !saw; shift++) {
      const woke = await claim(run.id, limited);
      if (!woke) break;
      saw = given(woke, 'Order 0');
      await limited.commitOutcome(woke.claims, done());
    }
    expect(saw).toBe(true);
    await limited.stop();
  });

  test('a later wake in a conversation the person spoke in is background, and is stopped at thirty', async () => {
    const created = await required(jobs).create({
      space_id: spaceId,
      title: 'Watch the shared inbox',
      objective: 'Watch the shared inbox for the signed lease',
    });
    // A conversation turn the person started stays current until they write again.
    await required(handle)
      .db.update(job)
      .set({
        principalId: ownerId,
        currentTurnId: newId('turn'),
        budget: { ...jobBudget.parse(created.budget), max_attempts: 1000 },
      })
      .where(eq(job.id, created.id));
    const opening = required(await claim(created.id));
    await required(runner).commitOutcome(opening.claims, {
      kind: 'waiting_for_input',
      question: 'Which inbox?',
    });
    await required(jobs).input(
      created.id,
      'The shared one; tell me when the lease comes back signed',
    );
    const asked = required(await claim(created.id));
    await ranModel(asked.claims.attempt_id);
    await required(runner).commitOutcome(asked.claims, timer());
    for (let wake = 0; wake < WAKE_GUARD_LIMIT; wake++) {
      const shift = required(await claim(created.id));
      await ranModel(shift.claims.attempt_id);
      await required(runner).commitOutcome(shift.claims, timer());
    }
    const seen = await classes(created.id);
    expect(seen.slice(0, 2)).toEqual(['background', 'interactive']);
    for (const wake of seen.slice(2)) expect(wake).toBe('background');

    expect(await claim(created.id)).toBeNull();
    const stopped = await row(created.id);
    expect(stopped.state).toBe('waiting_for_input');
    expect(stopped.paused).toBe(false);
    expect(stopped.wait).toEqual({ kind: 'user_input', question: WAKE_GUARD_QUESTION });
    const once = await told(created.id);
    expect(once.notices).toHaveLength(1);
    expect(once.pushes).toHaveLength(1);
    expect(once.pushes[0]).toMatchObject({
      body: WAKE_GUARD_QUESTION,
      url: `/#/chat/${created.id}`,
    });
    // The person's answer runs, and the work goes on from a fresh count.
    await required(jobs).input(created.id, 'Yes, keep going');
    const answered = required(await claim(created.id));
    expect((await classes(created.id)).at(-1)).toBe('interactive');
    await ranModel(answered.claims.attempt_id);
    await required(runner).commitOutcome(answered.claims, timer());
    const next = required(await claim(created.id));
    expect((await classes(created.id)).at(-1)).toBe('background');
    await required(runner).commitOutcome(next.claims, timer());
    expect((await told(created.id)).notices).toHaveLength(1);
  });

  test("a routine's test run is the person's, and its scheduled runs are background", async () => {
    const response = await request('/automations', 'POST', {
      title: 'Morning check',
      instruction: 'Check the overnight orders',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      at: '08:30',
    });
    expect(response.status).toBe(200);
    const routine = automationResponse.parse(await response.json()).automation;
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const routineJob = required(registration).jobId;
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    const tried = required(await claim(routineJob));
    await required(runner).commitOutcome(tried.claims, done('Three orders overnight.'));
    await required(triggers).fireSchedule(routine.id, `occ-${++occurrence}`);
    const scheduled = required(await claim(routineJob));
    await required(runner).commitOutcome(scheduled.claims, done('Two orders overnight.'));
    expect(await classes(routineJob)).toEqual(['interactive', 'background']);
  });
  test("a routine's test that is put off leaves its next scheduled run background", async () => {
    const response = await request('/automations', 'POST', {
      title: 'Evening check',
      instruction: 'Check the day of orders',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      at: '18:30',
    });
    const routine = automationResponse.parse(await response.json()).automation;
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const routineJob = required(registration).jobId;
    // The routine is being checked less often, so the next occurrence is put off.
    await required(handle)
      .db.update(job)
      .set({ scheduleSkipRemaining: 1 })
      .where(eq(job.id, routineJob));
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    expect((await row(routineJob)).state).toBe('waiting_for_event_or_time');
    await required(triggers).fireSchedule(routine.id, `occ-${++occurrence}`);
    const scheduled = required(await claim(routineJob));
    await required(runner).commitOutcome(scheduled.claims, done('Nothing new.'));
    expect(await classes(routineJob)).toEqual(['background']);
  });

  test('only a turn cut off to be tried again carries the person on; a final failure does not', async () => {
    const created = await required(jobs).create({
      space_id: spaceId,
      title: 'Cause check',
      objective: 'Check what an attempt is caused by',
    });
    const turnId = newId('turn');
    await required(handle)
      .db.update(job)
      .set({ currentTurnId: turnId })
      .where(eq(job.id, created.id));
    const failed = (retryable: boolean) => ({
      turnId,
      usageClass: 'interactive',
      outcome: 'failed',
      outcomeDetail: { kind: 'failed', reason: 'x', retryable },
      endedAt: new Date(),
      leaseStatus: 'ended',
    });
    const cause = (previous: ReturnType<typeof failed>) =>
      required(jobs).transaction((tx) =>
        attemptCause(tx, { id: created.id, currentTurnId: turnId }, previous, 1e12),
      );
    expect((await cause(failed(true))).usageClass).toBe('interactive');
    expect((await cause(failed(false))).usageClass).toBe('background');
    expect((await cause({ ...failed(true), usageClass: 'background' })).usageClass).toBe(
      'background',
    );
  });
});
