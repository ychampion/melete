/**
 * Standing work, checked results and the repeat guard, together: a standing
 * run whose result is being checked waits for the check rather than its
 * trigger, is given its result once the check ends, and then stands on
 * nothing, however it ended.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { type AttemptOutcome, type CapabilityClaims, runResponse } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { job, owner, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-together-fixture-signing-key-32b';
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'runs-together@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
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
async function start(body: Record<string, unknown>) {
  const response = await request('/runs', 'POST', body);
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
const view = async (id: string) =>
  runResponse.parse(await (await request(`/runs/${id}`)).json()).run;
const row = async (id: string) => required(jobs).get(id);
const triggersOf = (id: string) =>
  required(handle).db.select().from(trigger).where(eq(trigger.jobId, id));

/** Claims the job's next attempt now, as its timer would; null when there was nothing to run. */
async function claimNow(id: string) {
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
const claim = async (id: string) => required(await claimNow(id));
const tool = (claims: CapabilityClaims, name: string, input: unknown) =>
  required(runs).call(claims, name, input);
const done = (summary = 'Shift over.'): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});
const commit = (claims: CapabilityClaims, outcome: AttemptOutcome = done()) =>
  required(runner).commitOutcome(claims, outcome);

/** The check of the run's latest result, still under way. */
async function checker(runId: string) {
  const steps = (await view(runId)).steps.filter(
    (step) => step.title === 'Checking the result' && step.status !== 'done',
  );
  return required(steps.at(-1)).id;
}

/** A run that gave its result, with the check of it under way and a shift started meanwhile. */
async function givenThenWoken(body: Record<string, unknown>) {
  const run = await start(body);
  const first = await claim(run.id);
  const given = (await tool(first.claims, 'run.finish', { summary: 'Supplier B at $38.' })) as {
    status: string;
  };
  expect(given.status).toBe('checking');
  await commit(first.claims);
  // The person writes while the check runs, which starts a shift now.
  await request(`/runs/${run.id}/message`, 'POST', { text: 'Also look at supplier C.' });
  const between = await claim(run.id);
  return { run, between, check: await checker(run.id) };
}

withDb('standing work with a checked result', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a shift during the check waits for the check, not the schedule, and the result is given', async () => {
    const { run, between, check } = await givenThenWoken({
      goal: 'Find a supplier under $40',
      done_when: 'A supplier price under $40 with its page',
      repeat: { cron: '0 9 * * *' },
    });
    await commit(between.claims);
    const waiting = await row(run.id);
    expect(waiting.state).toBe('waiting_for_event_or_time');
    expect(waiting.wait).toMatchObject({ kind: 'timer' });
    expect((await view(run.id)).status_line).toStartWith('Checking the result');

    const checking = await claim(check);
    await tool(checking.claims, 'run.finish', { summary: 'Confirmed.', verdict: 'passes' });
    await commit(checking.claims);
    expect((await row(run.id)).state).toBe('queued');
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe('Supplier B at $38.');
    expect(finished.check.state).toBe('passed');
    expect(finished.standing).toBeNull();
    expect(await triggersOf(run.id)).toHaveLength(0);
  });

  test('a check that ends while a shift is under way gives the result right after that shift', async () => {
    const { run, between, check } = await givenThenWoken({
      goal: 'Find a supplier under $35',
      done_when: 'A supplier price under $35 with its page',
      repeat: { cron: '0 9 * * *' },
    });
    const checking = await claim(check);
    await tool(checking.claims, 'run.finish', { summary: 'Confirmed.', verdict: 'passes' });
    await commit(checking.claims);
    await commit(between.claims);
    expect((await row(run.id)).wait).toMatchObject({ kind: 'timer' });
    expect(await claimNow(run.id)).toBeNull();
    expect((await view(run.id)).status).toBe('done');
    expect(await triggersOf(run.id)).toHaveLength(0);
  });

  test('work that does not stand rests while its result is checked instead of going again now', async () => {
    const { run, between } = await givenThenWoken({
      goal: 'Find a supplier under $30',
      done_when: 'A supplier price under $30 with its page',
    });
    await commit(between.claims);
    const waiting = await row(run.id);
    expect(waiting.state).toBe('waiting_for_event_or_time');
    expect(required(waiting.nextWakeAt).getTime() - Date.now()).toBeGreaterThan(60_000);
  });

  test('an answer given while the result was checked is read before the result is given', async () => {
    const { run, between, check } = await givenThenWoken({
      goal: 'Find a supplier under $45',
      done_when: 'A supplier price under $45 with its page',
    });
    await commit(between.claims, {
      kind: 'waiting_for_input',
      question: 'Which supplier C do you mean?',
    });
    const checking = await claim(check);
    await tool(checking.claims, 'run.finish', { summary: 'Confirmed.', verdict: 'passes' });
    await commit(checking.claims);
    expect((await row(run.id)).state).toBe('waiting_for_input');

    // The answer starts a shift that reads it, with the checked result in its brief.
    await request(`/runs/${run.id}/message`, 'POST', { text: 'C is the one in Porto.' });
    const reads = await claim(run.id);
    expect(reads.bundle.job.objective).toContain(
      'Your result has been through its check and is ready to be given to the person:\nSupplier B at $38.',
    );
    expect(JSON.stringify(reads.bundle.inputs.new_user_messages)).toContain(
      'C is the one in Porto.',
    );
    expect((await view(run.id)).status).not.toBe('done');
    await commit(reads.claims, done('Porto is no cheaper.'));
    // Read, and nothing changed: the checked result is given.
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe('Supplier B at $38.');
    expect(finished.check.state).toBe('passed');
  });

  test('standing work stopped any way stands on nothing', async () => {
    const run = await start({
      goal: 'Each morning, read the prices',
      repeat: { cron: '0 9 * * *' },
    });
    expect(await triggersOf(run.id)).toHaveLength(1);
    await required(jobs).cancel(run.id, 'stopped from the job list');
    expect(await triggersOf(run.id)).toHaveLength(0);
  });
});
