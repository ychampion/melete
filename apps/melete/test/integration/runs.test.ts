import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  RUN_IDLE_SHIFT_LIMIT,
  runExportResponse,
  runListResponse,
  runRecordResponse,
  runResponse,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import {
  action,
  budgetLedger,
  connection,
  job,
  owner,
  runState,
  space,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { bestExperiment, textOf, valueShown } from '../../src/runs/record.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-fixture-signing-key-32-bytes-long';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
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
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'runs@example.test' });
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

/** Lets the next shift be claimed now, as its timer would. */
async function due(id: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
}

/** Claims the job's next shift; the bundle is what the engine would be given. */
async function claim(id: string) {
  await due(id);
  const current = await row(id);
  return required(
    await required(runner).claim({
      job_id: id,
      expected_epoch: current.leaseEpoch,
      expected_version: current.stateVersion,
      reason: 'timer',
    }),
  );
}
const tool = (claims: Parameters<RunService['call']>[0], name: string, input: unknown) =>
  required(runs).call(claims, name, input);
const done = (summary = 'Shift over.'): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});

withDb('long work in shifts', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a run continues from its handoff, shift after shift, until it says it is done', async () => {
    const run = await start({
      goal: 'Find the fastest sort for our data',
      done_when: 'One approach is clearly fastest',
      metric: { name: 'ms', direction: 'lower' },
      // The check of a result is covered in runs-check.test.ts.
      check_result: false,
    });
    expect(run.status).toBe('working');
    expect(run.shifts).toBe(0);

    const first = await claim(run.id);
    expect(first.claims.scopes).toEqual(
      expect.arrayContaining(['run.log', 'run.delegate', 'run.checkpoint', 'run.finish']),
    );
    expect(first.claims.scopes).not.toContain('run.start');
    expect(first.bundle.job.objective).toContain('long work done in shifts');
    expect(first.bundle.job.objective).toContain('Done when: One approach is clearly fastest');
    await tool(first.claims, 'run.log', {
      kind: 'plan',
      title: 'Plan',
      body: '1. Measure\n2. Compare',
    });
    const unchecked = (await tool(first.claims, 'run.log', {
      kind: 'experiment',
      title: 'Quicksort',
      value: 41,
      evidence: ['act_00000000000000000000000000'],
    })) as { checked: boolean; note?: string };
    expect(unchecked.checked).toBe(false);
    expect(unchecked.note).toContain('not found');
    await tool(first.claims, 'run.log', { kind: 'experiment', title: 'Radix sort', value: 12 });
    await tool(first.claims, 'run.checkpoint', {
      summary: 'Measured two sorts.',
      next: 'Try timsort on the large file.',
    });
    await required(runner).commitOutcome(first.claims, done());

    const resting = await row(run.id);
    expect(resting.state).toBe('waiting_for_event_or_time');
    expect(resting.wait).toMatchObject({ kind: 'timer' });
    const afterOne = await view(run.id);
    expect(afterOne.shifts).toBe(1);
    expect(afterOne.plan).toContain('Measure');
    expect(afterOne.next).toBe('Try timsort on the large file.');
    expect(afterOne.experiments.count).toBe(2);
    // Lower is better here: 12 beats 41.
    expect(afterOne.experiments.best?.value).toBe(12);

    const second = await claim(run.id);
    expect(second.bundle.job.objective).toContain(
      'Where the last shift left off: Measured two sorts.',
    );
    expect(second.bundle.job.objective).toContain('Next: Try timsort on the large file.');
    expect(second.bundle.job.objective).toContain('Experiments so far: 2, measured by ms');
    expect(second.bundle.job.objective).toContain('Best: Radix sort = 12');
    await tool(second.claims, 'run.finish', { summary: 'Radix sort is fastest at 12 ms.' });
    await required(runner).commitOutcome(second.claims, done('Finished.'));

    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe('Radix sort is fastest at 12 ms.');
    expect(finished.status_line).toBe('Done · 2 tries, best ms 12');
    expect(finished.shifts).toBe(2);
  });

  test('a shift that stops without a handoff gets one, and idle shifts stop to ask', async () => {
    const run = await start({ goal: 'Keep looking into it' });
    const first = await claim(run.id);
    await tool(first.claims, 'run.log', { kind: 'finding', title: 'Found a lead' });
    await required(runner).commitOutcome(first.claims, done('I looked at the logs.'));
    const record = runRecordResponse.parse(
      await (await request(`/runs/${run.id}/record`)).json(),
    ).entries;
    const handoff = record.find((entry) => entry.kind === 'checkpoint');
    expect(handoff?.body).toBe('I looked at the logs.');
    expect(handoff?.data.automatic).toBe(true);

    for (let shift = 0; shift < RUN_IDLE_SHIFT_LIMIT; shift++) {
      const next = await claim(run.id);
      await required(runner).commitOutcome(next.claims, done(''));
    }
    const stuck = await view(run.id);
    expect(stuck.status).toBe('needs_you');
    expect(stuck.question).toContain("haven't made progress");

    // The person's answer starts the next shift, which reads it.
    const answered = await request(`/runs/${run.id}/message`, 'POST', {
      text: 'Try the other server.',
    });
    expect(answered.status).toBe(200);
    expect((await row(run.id)).state).toBe('queued');
    const resumed = await claim(run.id);
    expect(JSON.stringify(resumed.bundle.inputs)).toContain('Try the other server.');
    await tool(resumed.claims, 'run.finish', { summary: 'Done.' });
    await required(runner).commitOutcome(resumed.claims, done());
    expect((await view(run.id)).status).toBe('done');
  });

  test('helpers work in parallel, report into the run, and wake it when they are done', async () => {
    const run = await start({ goal: 'Compare three vendors' });
    const lead = await claim(run.id);
    const one = (await tool(lead.claims, 'run.delegate', {
      task: 'Price vendor A',
      title: 'Vendor A',
    })) as { helper_id: string };
    const two = (await tool(lead.claims, 'run.delegate', {
      task: 'Price vendor B',
      title: 'Vendor B',
    })) as { helper_id: string };
    // Finishing now would leave the helpers' findings behind.
    expect(
      String(await rejectionOf(tool(lead.claims, 'run.finish', { summary: 'Too soon.' }))),
    ).toContain('2 helpers are still working');
    await tool(lead.claims, 'run.checkpoint', {
      summary: 'Asked two helpers.',
      next: 'Compare their prices.',
      next_shift: 'when_helpers_finish',
    });
    await required(runner).commitOutcome(lead.claims, done());
    const [waiting] = await required(handle)
      .db.select()
      .from(runState)
      .where(eq(runState.jobId, run.id));
    expect(waiting?.waitingOnSteps).toBe(true);
    expect((await row(run.id)).nextWakeAt?.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect((await view(run.id)).status_line).toContain('Waiting for 2 helpers');

    // A helper is offered its own tools, not more helpers.
    const helperA = await claim(one.helper_id);
    expect(helperA.claims.scopes).toContain('run.finish');
    expect(helperA.claims.scopes).not.toContain('run.delegate');
    expect(helperA.bundle.job.objective).toContain('The whole work: Compare three vendors');
    expect(
      await rejectionOf(tool(helperA.claims, 'run.delegate', { task: 'More help' })),
    ).toBeDefined();
    await tool(helperA.claims, 'run.finish', { summary: 'Vendor A costs $40.' });
    await required(runner).commitOutcome(helperA.claims, done());
    expect((await row(one.helper_id)).state).toBe('completed');
    // One helper is still working, so the run sleeps on.
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // A helper that answers without a handoff is done with that answer.
    const helperB = await claim(two.helper_id);
    await required(runner).commitOutcome(helperB.claims, done('Vendor B costs $35.'));
    expect((await row(two.helper_id)).state).toBe('completed');
    expect((await row(run.id)).state).toBe('queued');

    const compare = await claim(run.id);
    expect(compare.bundle.job.objective).toContain('Vendor A: done — Vendor A costs $40.');
    expect(compare.bundle.job.objective).toContain('Vendor B: done — Vendor B costs $35.');
    const steps = (await view(run.id)).steps;
    expect(steps.map((step) => step.status)).toEqual(['done', 'done']);
    await tool(compare.claims, 'run.finish', { summary: 'B is cheaper.' });
    await required(runner).commitOutcome(compare.claims, done());

    const markdown = runExportResponse.parse(
      await (await request(`/runs/${run.id}/export`)).json(),
    ).markdown;
    expect(markdown).toContain('# Compare three vendors');
    expect(markdown).toContain('Helper started');
    expect(markdown).not.toMatch(/step_started|checkpoint|experiment/);
    expect(markdown).toContain('(helper: Vendor A)');
    expect(markdown).toContain('B is cheaper.');
  });

  test('failing shifts retry, then stop to ask instead of ending the work', async () => {
    const run = await start({ goal: 'Something flaky' });
    for (const attemptNumber of [1, 2]) {
      const shift = await claim(run.id);
      await required(runner).commitOutcome(shift.claims, {
        kind: 'failed',
        reason: `The provider timed out (${attemptNumber}).`,
        retryable: true,
      });
      expect((await row(run.id)).state).toBe('queued');
    }
    const third = await claim(run.id);
    await required(runner).commitOutcome(third.claims, {
      kind: 'failed',
      reason: 'The provider timed out (3).',
      retryable: true,
    });
    const asking = await view(run.id);
    expect(asking.status).toBe('needs_you');
    expect(asking.question).toContain('The provider timed out (3).');

    // Many good shifts never count against it.
    await request(`/runs/${run.id}/message`, 'POST', { text: 'continue' });
    for (let shift = 0; shift < 5; shift++) {
      const next = await claim(run.id);
      await tool(next.claims, 'run.log', { kind: 'note', title: `Step ${shift}` });
      await required(runner).commitOutcome(next.claims, done());
      expect((await row(run.id)).state).toBe('waiting_for_event_or_time');
    }
  });

  test('a limit the person sets stops it to ask; without one it keeps going', async () => {
    const run = await start({ goal: 'Bounded work', limit: { max_shifts: 2 } });
    for (const expected of ['waiting_for_event_or_time', 'waiting_for_input']) {
      const shift = await claim(run.id);
      await tool(shift.claims, 'run.log', { kind: 'note', title: 'Worked' });
      await required(runner).commitOutcome(shift.claims, done());
      expect((await row(run.id)).state).toBe(expected);
    }
    expect((await view(run.id)).question).toContain('limit you set (2 rounds of work)');
    const cleared = await request(`/runs/${run.id}/limit`, 'PUT', { limit: null });
    expect(runResponse.parse(await cleared.json()).run.limit).toBeNull();
  });

  test('a shift budget is its own: earlier shifts do not use up later ones', async () => {
    const run = await start({ goal: 'Long and wordy' });
    const first = await claim(run.id);
    // As if the first shift spent almost all of a shift's output allowance.
    await required(handle)
      .db.insert(budgetLedger)
      .values({
        id: `led_${newId('op').slice(3)}`,
        jobId: run.id,
        attemptId: first.claims.attempt_id,
        kind: 'tokens',
        reserved: 399_000,
        settled: 399_000,
      } as typeof budgetLedger.$inferInsert);
    await tool(first.claims, 'run.log', { kind: 'note', title: 'Wrote a lot' });
    await required(runner).commitOutcome(first.claims, done());
    const second = await claim(run.id);
    const [used] = await required(handle).sql`
      select coalesce(sum(coalesce(settled, reserved)), 0)::float8 as n from budget_ledger
      where job_id = ${run.id} and attempt_id = ${second.claims.attempt_id}`;
    expect(Number(used?.n)).toBe(0);
    expect(second.claims.budget.max_output_tokens).toBe(400_000);
  });

  test('pause rests the work, resume starts the next shift, stop ends it and its helpers', async () => {
    const run = await start({ goal: 'Pausable' });
    const lead = await claim(run.id);
    const helper = (await tool(lead.claims, 'run.delegate', { task: 'Side task' })) as {
      helper_id: string;
    };
    await tool(lead.claims, 'run.log', { kind: 'note', title: 'Started' });
    await required(runner).commitOutcome(lead.claims, done());
    const paused = runResponse.parse(
      await (await request(`/runs/${run.id}/pause`, 'POST')).json(),
    ).run;
    expect(paused.status_line).toContain('Paused');
    expect((await row(helper.helper_id)).paused).toBe(true);
    const resumed = runResponse.parse(
      await (await request(`/runs/${run.id}/resume`, 'POST')).json(),
    ).run;
    expect(resumed.status).toBe('working');
    expect((await row(run.id)).state).toBe('queued');
    const stopped = runResponse.parse(
      await (await request(`/runs/${run.id}/stop`, 'POST')).json(),
    ).run;
    expect(stopped.status).toBe('stopped');
    expect((await row(helper.helper_id)).state).toBe('cancelled');
  });

  test('a helper never waits on the person: where it would ask, it ends and its run hears why', async () => {
    const run = await start({ goal: 'Compare three suppliers' });
    const lead = await claim(run.id);
    const helper = async (title: string) =>
      (
        (await tool(lead.claims, 'run.delegate', { task: `Price ${title}`, title })) as {
          helper_id: string;
        }
      ).helper_id;
    const asks = await helper('Supplier A');
    const fails = await helper('Supplier B');
    const lost = await helper('Supplier C');
    await tool(lead.claims, 'run.checkpoint', {
      summary: 'Asked three helpers.',
      next: 'Compare.',
      next_shift: 'when_helpers_finish',
    });
    await required(runner).commitOutcome(lead.claims, done());

    // A question of its own.
    const a = await claim(asks);
    await required(runner).commitOutcome(a.claims, {
      kind: 'waiting_for_input',
      question: 'Which currency should I quote in?',
    });
    expect((await row(asks)).state).toBe('failed');
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // Failing shifts in a row.
    for (const attemptNumber of [1, 2, 3]) {
      const b = await claim(fails);
      await required(runner).commitOutcome(b.claims, {
        kind: 'failed',
        reason: `The price page timed out (${attemptNumber}).`,
        retryable: true,
      });
    }
    expect((await row(fails)).state).toBe('failed');
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // Shifts lost in a row; the last helper's end wakes the run.
    for (let lose = 0; lose < 3; lose++) {
      const c = await claim(lost);
      expect(await required(runner).loseAttempt(c.claims.attempt_id, 'lease expired')).toBe(true);
    }
    expect((await row(lost)).state).toBe('failed');
    expect((await row(run.id)).state).toBe('queued');

    const next = await claim(run.id);
    expect(next.bundle.job.objective).toContain(
      'Supplier A: failed — It stopped to ask: Which currency should I quote in?',
    );
    expect(next.bundle.job.objective).toContain(
      'Supplier B: failed — It kept running into a problem: The price page timed out (3).',
    );
    expect(next.bundle.job.objective).toContain('Supplier C: failed');
    // With no helper left out, the run can finish.
    await tool(next.claims, 'run.finish', { summary: 'No supplier could be priced.' });
    await required(runner).commitOutcome(next.claims, done());
    expect((await view(run.id)).status).toBe('done');
  });

  test('handing off to go on now and nothing else is idle; resting on helpers is not', async () => {
    const spinning = await start({ goal: 'Hand off and nothing else' });
    for (let shift = 0; shift < RUN_IDLE_SHIFT_LIMIT; shift++) {
      const next = await claim(spinning.id);
      await tool(next.claims, 'run.checkpoint', { summary: 'Still on it.', next: 'Keep going.' });
      await required(runner).commitOutcome(next.claims, done());
    }
    expect((await view(spinning.id)).status).toBe('needs_you');

    const resting = await start({ goal: 'Wait on a slow helper' });
    const lead = await claim(resting.id);
    await tool(lead.claims, 'run.delegate', { task: 'Something slow' });
    const wait = {
      summary: 'Waiting for the helper.',
      next: 'Read its result.',
      next_shift: 'when_helpers_finish',
    };
    await tool(lead.claims, 'run.checkpoint', wait);
    await required(runner).commitOutcome(lead.claims, done());
    for (let wake = 0; wake < RUN_IDLE_SHIFT_LIMIT + 1; wake++) {
      const next = await claim(resting.id);
      await tool(next.claims, 'run.checkpoint', wait);
      await required(runner).commitOutcome(next.claims, done());
      expect((await row(resting.id)).state).toBe('waiting_for_event_or_time');
    }
  });

  test('work that finished while paused is taken up again by a message', async () => {
    const run = await start({ goal: 'Finish under a pause' });
    const shift = await claim(run.id);
    expect((await request(`/runs/${run.id}/pause`, 'POST')).status).toBe(200);
    await tool(shift.claims, 'run.finish', { summary: 'All done.' });
    await required(runner).commitOutcome(shift.claims, done());
    expect((await row(run.id)).state).toBe('completed');
    const again = await request(`/runs/${run.id}/message`, 'POST', { text: 'One more thing.' });
    expect(again.status).toBe(200);
    const reopened = await row(run.id);
    expect(reopened.state).toBe('queued');
    expect(reopened.paused).toBe(false);
  });

  test('stop also ends a helper started while it was stopping', async () => {
    const run = await start({ goal: 'Stopped mid-delegation' });
    const lead = await claim(run.id);
    const service = required(jobs);
    const cancel = service.cancel.bind(service);
    let late = null as string | null;
    // The shift starts a helper just as the person presses Stop.
    service.cancel = async (id, reason) => {
      if (id === run.id && late === null)
        late = (
          (await tool(lead.claims, 'run.delegate', { task: 'Late helper' })) as {
            helper_id: string;
          }
        ).helper_id;
      return cancel(id, reason);
    };
    try {
      expect((await request(`/runs/${run.id}/stop`, 'POST')).status).toBe(200);
    } finally {
      service.cancel = cancel;
    }
    expect((await row(required(late))).state).toBe('cancelled');
  });

  test('pausing does not deadlock with a helper writing to the record', async () => {
    const run = await start({ goal: 'Pause while a helper writes' });
    const lead = await claim(run.id);
    const helper = (
      (await tool(lead.claims, 'run.delegate', { task: 'Write things down' })) as {
        helper_id: string;
      }
    ).helper_id;
    await tool(lead.claims, 'run.log', { kind: 'note', title: 'Started' });
    await required(runner).commitOutcome(lead.claims, done());
    let pausing = null as Promise<Response> | null;
    // As a helper's own transaction does: its row first, then an entry under the run.
    await required(handle).sql.begin(async (tx) => {
      await tx`select id from job where id = ${helper} for update`;
      pausing = request(`/runs/${run.id}/pause`, 'POST');
      await Bun.sleep(500);
      await tx`insert into run_entry (id, run_job_id, step_job_id, kind, title)
        values (${newId('rune')}, ${run.id}, ${helper}, 'note', 'From the helper')`;
    });
    expect((await required(pausing)).status).toBe(200);
    expect((await row(helper)).paused).toBe(true);
    expect((await row(run.id)).paused).toBe(true);
  });

  test('an experiment is checked against the output of the action it cites', async () => {
    const run = await start({
      goal: 'Tune the model',
      metric: { name: 'accuracy', direction: 'higher' },
    });
    const shift = await claim(run.id);
    const sandbox = newId('conn');
    await required(handle).db.insert(connection).values({
      id: sandbox,
      spaceId,
      label: 'Computer',
      provider: 'sandbox',
    });
    const evaluation = newId('act');
    await required(handle)
      .db.insert(action)
      .values({
        id: evaluation,
        jobId: run.id,
        attemptId: shift.claims.attempt_id,
        connectionId: sandbox,
        kind: 'exec.run',
        effectClass: 'read',
        canonicalPayload: { command: 'python eval.py' },
        payloadHash: 'c'.repeat(64),
        idempotencyKey: evaluation,
        status: 'succeeded',
        receipt: { detail: { stdout: 'epoch 3\naccuracy: 0.8731\n' } },
      });
    const checked = (await tool(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'Lower learning rate',
      hypothesis: 'A smaller step stops the loss bouncing.',
      value: 0.873,
      evidence: [evaluation],
    })) as { checked: boolean };
    expect(checked.checked).toBe(true);
    // A higher value nobody measured does not win over the checked one.
    const claimed = (await tool(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'Bigger model',
      value: 0.95,
      evidence: [evaluation],
    })) as { checked: boolean };
    expect(claimed.checked).toBe(false);
    await tool(shift.claims, 'run.checkpoint', { summary: 'Two tries.', next: 'More.' });
    await required(runner).commitOutcome(shift.claims, done());
    const tuned = await view(run.id);
    expect(tuned.experiments.best).toMatchObject({ title: 'Lower learning rate', checked: true });
    expect(tuned.status_line).toContain('best accuracy 0.873');
  });

  test('through the broker: a chat may start work, a run gets its tools, a helper fewer', async () => {
    const broker = new BrokerService({
      sql: required(handle).sql,
      connectors: new ConnectorRegistry(),
      runs: required(runs),
    });
    const brokerApp = createBrokerApp({
      broker,
      capabilityKey: KEY,
      approvalKey: 'runs-fixture-approval-key-32-bytes!',
    });
    const as = (claims: Parameters<RunService['call']>[0]) => ({
      authorization: `Bearer ${signCapability(claims, KEY)}`,
      'content-type': 'application/json',
    });
    const tools = async (claims: Parameters<RunService['call']>[0]) =>
      (
        (await (await brokerApp.request('/tools', { headers: as(claims) })).json()) as {
          tools: { name: string }[];
        }
      ).tools.map((entry) => entry.name);
    const call = (claims: Parameters<RunService['call']>[0], name: string, args: unknown) =>
      brokerApp.request('/tools/call', {
        method: 'POST',
        headers: as(claims),
        body: JSON.stringify({ name, arguments: args }),
      });

    // A conversation, with the person asking for something big.
    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: spaceId, title: 'Research', objective: 'Research' },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(
      chat.id,
      'Keep testing caching ideas until one halves the load time.',
    );
    const turn = await claim(chat.id);
    expect(turn.claims.scopes).toContain('run.start');
    expect(await tools(turn.claims)).toContain('run.start');
    expect(await tools(turn.claims)).not.toContain('run.log');
    const started = await call(turn.claims, 'run.start', {
      goal: 'Halve the load time with caching',
      metric: { name: 'load ms', direction: 'lower' },
    });
    expect(started.status).toBe(200);
    const { run_id } = (await started.json()) as { run_id: string };
    const listed = runListResponse.parse(
      await (await request(`/runs?conversation_id=${chat.id}`)).json(),
    ).runs;
    expect(listed.map((entry) => entry.id)).toEqual([run_id]);
    expect(listed[0]?.metric).toEqual({ name: 'load ms', direction: 'lower' });

    // The run's own shift is offered its tools, pinned in the core catalog.
    const shift = await claim(run_id);
    const offered = await tools(shift.claims);
    expect(offered).toEqual(
      expect.arrayContaining(['run.log', 'run.delegate', 'run.checkpoint', 'run.finish']),
    );
    expect(offered).not.toContain('run.start');
    const logged = await call(shift.claims, 'run.log', {
      kind: 'finding',
      title: 'Images dominate',
    });
    expect(logged.status).toBe(200);
    // A wrong argument comes back as something the model can read and fix.
    const wrong = await call(shift.claims, 'run.log', { kind: 'diary', title: 'x' });
    expect(wrong.status).toBe(409);
    expect(JSON.stringify(await wrong.json())).toContain('kind');
    const helper = (await (
      await call(shift.claims, 'run.delegate', { task: 'Measure the images' })
    ).json()) as { helper_id: string };
    const helperShift = await claim(helper.helper_id);
    expect(await tools(helperShift.claims)).not.toContain('run.delegate');
    const refused = await call(helperShift.claims, 'run.delegate', { task: 'More' });
    expect(refused.status).toBe(409);
  });

  test('the list shows runs, newest first, and a conversation sees the ones it started', async () => {
    const all = runListResponse.parse(await (await request('/runs')).json());
    expect(all.runs.length).toBeGreaterThan(3);
    const none = runListResponse.parse(
      await (await request(`/runs?conversation_id=${newId('job')}`)).json(),
    );
    expect(none.runs).toEqual([]);
  });
});

describe('reading measured values', () => {
  test('a value counts as shown when the output has it, or it rounded', () => {
    expect(valueShown(0.873, 'accuracy: 0.8731\nloss 0.2')).toBe(true);
    expect(valueShown(12, '{"stdout":"took 12 ms"}')).toBe(true);
    expect(valueShown(12, '{"stdout":"took 121 ms"}')).toBe(false);
    expect(valueShown(0.9, 'accuracy 0.873')).toBe(false);
  });

  test('a number is read whole, not out of a longer number, an id, a date or a version', () => {
    expect(valueShown(9, 'released in 1990')).toBe(false);
    expect(valueShown(9, 'act_9f3a2c and job_01H9')).toBe(false);
    expect(valueShown(-9, 'on 2026-09-01')).toBe(false);
    expect(valueShown(3, 'version 1.9.3')).toBe(false);
    expect(valueShown(9, 'hash 9f3a')).toBe(false);
    expect(valueShown(9, 'took 9 ms')).toBe(true);
    expect(valueShown(12, 'took 12ms')).toBe(true);
    expect(valueShown(-0.5, 'delta:-0.5')).toBe(true);
    expect(valueShown(0.873, 'accuracy=0.8731.')).toBe(true);
    // Output read from its stored form, where a line break is not a letter n.
    expect(valueShown(0.87, textOf({ stdout: 'epoch 3\n0.87\n' }))).toBe(true);
  });

  test('the best experiment prefers checked results, then the better value', () => {
    const entry = (value: number, checked: boolean, outcome = 'kept') =>
      ({ data: { value, checked, outcome } }) as unknown as Parameters<
        typeof bestExperiment
      >[0][number];
    expect(bestExperiment([entry(0.9, false), entry(0.8, true)], 'higher')?.data).toMatchObject({
      value: 0.8,
    });
    expect(
      bestExperiment([entry(0.9, true), entry(0.95, true, 'failed')], 'higher')?.data,
    ).toMatchObject({
      value: 0.9,
    });
    expect(bestExperiment([entry(5, true), entry(3, true)], 'lower')?.data).toMatchObject({
      value: 3,
    });
  });
});
