import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { type AttemptOutcome, type CapabilityClaims, runResponse } from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import {
  action,
  approval,
  attempt,
  connection,
  job,
  owner,
  pushIntent,
  runEntry,
  space,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { attachRuns, RUN_STALL_MS, RunService, STALLED_QUESTION } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-report-back-fixture-signing-key-32';
/** The model each job's next attempt runs on, as the person's settings would say; a job here cannot reach its provider at all. */
const models = { current: 'deepseek', byJob: new Map<string, string>(), unreachable: new Set() };
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: KEY,
      resolveModel: async (_tx, row) => {
        if (models.unreachable.has(row.id)) throw new Error('provider is not configured');
        return { provider: 'fireworks', model: models.byJob.get(row.id) ?? models.current };
      },
    })
  : null;
const runs = jobs ? new RunService(jobs) : null;
if (runner && runs) attachRuns(runner, runs);
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
const web = newId('conn');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'runs-report-back@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await handle.db.insert(connection).values({ id: web, spaceId, label: 'Web', provider: 'web' });
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
async function start(body: Record<string, unknown>) {
  const response = await request('/runs', 'POST', body);
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;
const row = async (id: string) => required(jobs).get(id);
const db = () => required(handle).db;

/** Claims the job's next attempt now, as its timer would; null when no engine was started. */
async function claimNow(id: string) {
  await db()
    .update(job)
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
const claim = async (id: string) => required(await claimNow(id));
const tool = (claims: CapabilityClaims, name: string, input: unknown) =>
  required(runs).call(claims, name, input);
const commit = (claims: CapabilityClaims, outcome: AttemptOutcome = done()) =>
  required(runner).commitOutcome(claims, outcome);
const done = (summary = 'Shift over.'): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});

/** An action of the job, left in `status` by the attempt that started it. */
async function leftOut(jobId: string, attemptId: string, status: string) {
  const id = newId('act');
  await db()
    .insert(action)
    .values({
      id,
      jobId,
      attemptId,
      connectionId: web,
      kind: 'web.fetch',
      effectClass: 'read',
      canonicalPayload: { url: 'https://example.test/review' },
      payloadHash: createHash('sha256').update(id).digest('hex'),
      idempotencyKey: id,
      status,
    });
  return id;
}

/** The check of the run's latest result, still under way. */
async function checker(runId: string) {
  const steps = (await view(runId)).steps.filter(
    (step) => step.title === 'Checking the result' && step.status !== 'done',
  );
  return required(steps.at(-1)).id;
}

const pushes = async (runId: string, key = 'run-report') =>
  (
    await db()
      .select({ title: pushIntent.title, body: pushIntent.body })
      .from(pushIntent)
      .where(sql`starts_with(${pushIntent.dedupKey}, ${`${key}:${runId}:`})`)
  ).map((push) => push.title);

/** The models the job's attempts asked for, oldest first. */
const modelsOf = async (jobId: string) =>
  (
    await db()
      .select({ model: attempt.model })
      .from(attempt)
      .where(eq(attempt.jobId, jobId))
      .orderBy(attempt.epoch)
  ).map((entry) => entry.model);

const REPORT = 'Final report: the five best robot vacuums under $600 for a cat home.';

withDb('long work reports back', () => {
  afterAll(async () => {
    runs?.stopWatchdog();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a result written while an earlier shift’s action is still out is given at once and closes when it reports back', async () => {
    const run = await start({ goal: 'Find the best robot vacuums', done_when: 'Five ranked' });
    // A shift cut off at its time limit leaves a read on its way.
    const first = await claim(run.id);
    const fetch = await leftOut(run.id, first.claims.attempt_id, 'dispatched');
    await commit(first.claims, { kind: 'budget_exhausted', summary: 'Out of time.' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: REPORT });
    await commit(shift.claims);
    const check = await claim(await checker(run.id));
    await tool(check.claims, 'run.finish', { summary: 'Holds up.', verdict: 'passes' });
    await commit(check.claims);

    // Settling it starts no engine and does not fail: before, completing over
    // the read on its way threw inside the claim, every time, and the run sat
    // "working" with no model call, Resume included.
    expect(await claimNow(run.id)).toBeNull();
    const given = await view(run.id);
    expect(given.result).toBe(REPORT);
    expect(given.status_line).toStartWith('Result ready · finishing up');
    expect(await pushes(run.id)).toContain(`${run.title}: Done`);
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // Still out: it rests again, with no shift that could rework the result.
    expect(await claimNow(run.id)).toBeNull();
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // The read reports back; the next wake closes the run, without a model.
    await db().update(action).set({ status: 'failed' }).where(eq(action.id, fetch));
    expect(await claimNow(run.id)).toBeNull();
    const closed = await view(run.id);
    expect(closed.status).toBe('done');
    expect(closed.status_line).toStartWith('Done · checked');
    expect(closed.result).toBe(REPORT);
    // One notification for the result, not one per try.
    expect((await pushes(run.id)).filter((title) => title.endsWith(': Done'))).toHaveLength(1);
  });

  test('a result given by a shift completes the run, withdrawing a permission an earlier shift left unanswered', async () => {
    const run = await start({ goal: 'Summarise three reviews' });
    const first = await claim(run.id);
    const asked = await leftOut(run.id, first.claims.attempt_id, 'needs_approval');
    await db()
      .insert(approval)
      .values({
        id: newId('apr'),
        actionId: asked,
        jobRevision: (await row(run.id)).revision,
        payloadHash: 'h',
      });
    await commit(first.claims);
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: 'Three reviews, summarised.' });
    await commit(shift.claims);
    expect((await row(run.id)).state).toBe('completed');
    expect((await view(run.id)).result).toBe('Three reviews, summarised.');
    const [withdrawn] = await db()
      .select({ status: action.status })
      .from(action)
      .where(eq(action.id, asked));
    expect(withdrawn?.status).toBe('denied');
  });

  test('a check step whose model errors still finishes, with the result as it is', async () => {
    const run = await start({ goal: 'Rank e-bikes under $2,000', done_when: 'Five ranked' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: REPORT });
    await commit(shift.claims);
    // The install switched models mid-run, and the new one refuses the check's schema.
    const id = await checker(run.id);
    models.byJob.set(id, 'glm');
    for (let retry = 0; retry < 3; retry++) {
      const check = await claim(id);
      await commit(check.claims, {
        kind: 'failed',
        retryable: true,
        reason: 'The model refused the response schema.',
      });
    }
    expect((await row(id)).state).toBe('failed');
    expect(await modelsOf(id)).toEqual(['glm', 'glm', 'glm']);
    // Back on the run's own model, the run is given its result without a shift.
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.check.state).toBe('not_confirmed');
    expect(finished.result).toStartWith(
      `${REPORT}\n\nA separate check of this could not be finished`,
    );
  });

  test('a check stopped where nobody can answer it is given up on, and the run waits on a healthy one without spending shifts', async () => {
    const run = await start({ goal: 'Compare three phone plans', done_when: 'One recommended' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: 'Plan B.' });
    await commit(shift.claims);
    const id = await checker(run.id);

    // While the check is still to run, the run's own wake starts no engine.
    expect(await claimNow(run.id)).toBeNull();
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');
    expect((await view(run.id)).status_line).toStartWith('Checking the result');

    // The check parks on an action whose outcome is unknown: it has nobody to ask.
    const check = await claim(id);
    await db().update(job).set({ state: 'needs_reconciliation' }).where(eq(job.id, id));
    await commit(check.claims);
    expect((await row(id)).state).toBe('needs_reconciliation');
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe(
      'Plan B.\n\nA separate check of this could not be finished: It stopped to wait for an answer or a permission, which a check cannot get.',
    );
    expect((await row(id)).state).toBe('cancelled');
    // One verdict for the check, though it was both given up on and stopped.
    const verdicts = await db()
      .select({ id: runEntry.id })
      .from(runEntry)
      .where(and(eq(runEntry.runJobId, run.id), eq(runEntry.kind, 'check')));
    expect(verdicts).toHaveLength(1);
  });

  test('the watchdog stops a run that cannot start and asks; resuming on another model works', async () => {
    const run = await start({ goal: 'Find a quiet dishwasher' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.log', { kind: 'finding', title: 'Bosch 800 is 42 dB' });
    await commit(shift.claims);
    // The model it ran on is gone: every claim now fails before a shift starts.
    models.unreachable.add(run.id);
    expect(String(await claimNow(run.id).catch((error) => error))).toContain(
      'provider is not configured',
    );
    // What the person saw: "Working on it", with nothing happening.
    expect((await view(run.id)).status_line).toStartWith('Working on it');

    // Not yet past the stall window: left alone. Every slot busy: left alone.
    const watchdog = required(runs);
    expect((await watchdog.watch(4)).paused).not.toContain(run.id);
    await db()
      .update(job)
      .set({ nextWakeAt: new Date(Date.now() - RUN_STALL_MS - 60_000) })
      .where(eq(job.id, run.id));
    expect((await watchdog.watch(0)).paused).not.toContain(run.id);

    expect((await watchdog.watch(4)).paused).toContain(run.id);
    const stalled = await view(run.id);
    expect(stalled.status).toBe('needs_you');
    expect(stalled.question).toBe(STALLED_QUESTION);
    expect(stalled.status_line).toBe(STALLED_QUESTION);
    expect(stalled.latest_report?.title).toBe('It stopped making progress');
    expect(await pushes(run.id, 'run-stalled')).toEqual([
      `${run.title}: It stopped making progress`,
    ]);
    // Asked once: a paused run is not stalled again.
    expect((await watchdog.watch(4)).paused).not.toContain(run.id);
    expect(await claimNow(run.id)).toBeNull();

    // The person switches the model and replies; the next shift runs on it.
    models.unreachable.delete(run.id);
    models.byJob.set(run.id, 'kimi');
    const reply = await request(`/runs/${run.id}/message`, 'POST', { text: 'continue' });
    expect(reply.status).toBe(200);
    expect((await row(run.id)).paused).toBe(false);
    expect((await view(run.id)).status).toBe('working');
    const resumed = await claim(run.id);
    expect(resumed.bundle.model.model).toBe('kimi');
    expect(resumed.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'continue',
    ]);
    expect(resumed.bundle.job.objective).toContain('Bosch 800 is 42 dB');
    await tool(resumed.claims, 'run.finish', { summary: 'The Bosch 800, at 42 dB.' });
    await commit(resumed.claims);
    expect((await view(run.id)).status).toBe('done');
  });

  test('Resume also takes a stalled run up again; a helper that cannot start is stopped and its run told', async () => {
    const run = await start({ goal: 'Plan a weekend in Big Sur' });
    const lead = await claim(run.id);
    const helper = (
      (await tool(lead.claims, 'run.delegate', { task: 'Find campsites' })) as {
        helper_id: string;
      }
    ).helper_id;
    await tool(lead.claims, 'run.checkpoint', {
      summary: 'Waiting for campsites.',
      next: 'Read what the helper found.',
      next_shift: 'when_helpers_finish',
    });
    await commit(lead.claims);
    models.unreachable.add(helper);
    await db()
      .update(job)
      .set({ nextWakeAt: new Date(Date.now() - RUN_STALL_MS - 60_000) })
      .where(eq(job.id, helper));
    expect((await required(runs).watch(4)).stopped).toContain(helper);
    expect((await row(helper)).state).toBe('cancelled');
    // Its run is woken to read why, rather than waiting the half hour out.
    expect((await row(run.id)).state).toBe('queued');
    expect((await view(run.id)).steps[0]?.status).toBe('stopped');

    models.unreachable.add(run.id);
    await db()
      .update(job)
      .set({ nextWakeAt: new Date(Date.now() - RUN_STALL_MS - 60_000) })
      .where(eq(job.id, run.id));
    expect((await required(runs).watch(4)).paused).toContain(run.id);
    models.unreachable.delete(run.id);
    expect((await request(`/runs/${run.id}/resume`, 'POST')).status).toBe(200);
    const after = await view(run.id);
    expect(after.status).toBe('working');
    expect(after.question).toBeNull();
    const shift = await claim(run.id);
    expect(shift.bundle.job.objective).toContain('Find campsites: stopped');
  });
});
