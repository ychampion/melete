import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  type CapabilityClaims,
  runExportResponse,
  runListResponse,
  runRecordResponse,
  runResponse,
} from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { REPEAT_LIMIT, RepeatGuard } from '../../src/broker/repeats.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import { action, connection, job, owner, pushIntent, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'runs-check-fixture-signing-key-32-bytes';
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
const sandbox = newId('conn');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'runs-check@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
  await handle.db
    .insert(connection)
    .values({ id: sandbox, spaceId, label: 'Computer', provider: 'sandbox' });
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
const commit = (claims: CapabilityClaims, outcome: AttemptOutcome = done()) =>
  required(runner).commitOutcome(claims, outcome);
const done = (summary = 'Shift over.'): AttemptOutcome => ({
  kind: 'completed',
  summary,
  evidence: [],
});

/** A succeeded action of the job whose stored output is `stdout`. */
async function measured(jobId: string, attemptId: string, stdout: string) {
  const id = newId('act');
  await required(handle)
    .db.insert(action)
    .values({
      id,
      jobId,
      attemptId,
      connectionId: sandbox,
      kind: 'exec.run',
      effectClass: 'read',
      canonicalPayload: { command: 'check' },
      payloadHash: createHash('sha256').update(id).digest('hex'),
      idempotencyKey: id,
      status: 'succeeded',
      receipt: { detail: { stdout } },
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

withDb('checking a result before it is called done', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a run with a definition of done is called done only once a separate check passes', async () => {
    const run = await start({
      goal: 'Find the cheapest flight to Lisbon',
      done_when: 'A fare under $500 with a booking link',
    });
    expect(run.check).toEqual({ enabled: true, state: null, gaps: [] });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.log', {
      kind: 'plan',
      title: 'Plan',
      body: 'Compare the airline sites one by one',
    });
    const fare = await measured(
      run.id,
      shift.claims.attempt_id,
      'TAP fare 412 USD https://example.test/book',
    );
    await tool(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'TAP direct',
      value: 412,
      evidence: [fare],
    });
    const given = (await tool(shift.claims, 'run.finish', {
      summary: 'TAP at $412: https://example.test/book',
      evidence: [fare],
    })) as { status: string };
    expect(given.status).toBe('checking');
    // Nothing more starts in the shift that gave its result.
    expect(
      String(await rejectionOf(tool(shift.claims, 'run.delegate', { task: 'Look again' }))),
    ).toContain('already given');
    await commit(shift.claims);

    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');
    const checking = await view(run.id);
    expect(checking.status).toBe('waiting');
    expect(checking.status_line).toStartWith('Checking the result');
    expect(checking.check.state).toBe('checking');
    expect(checking.result).toBeNull();

    // The check starts fresh: the goal, what done means, the result and the evidence.
    const check = await claim(await checker(run.id));
    expect(check.claims.scopes).not.toContain('run.delegate');
    const brief = check.bundle.job.objective;
    expect(brief).toContain('The goal: Find the cheapest flight to Lisbon');
    expect(brief).toContain('Done when: A fare under $500 with a booking link');
    expect(brief).toContain('The result offered:\nTAP at $412: https://example.test/book');
    expect(brief).toContain('TAP direct = 412 (kept, measured)');
    expect(brief).toContain(`${fare} (exec.run, succeeded): TAP fare 412 USD`);
    expect(brief).not.toContain('Compare the airline sites');
    // A check ends with a verdict; a run's own finish does not take one.
    expect(
      String(await rejectionOf(tool(check.claims, 'run.finish', { summary: 'Looks fine.' }))),
    ).toContain('verdict');
    await tool(check.claims, 'run.finish', {
      summary: 'The fare and the link check out.',
      verdict: 'passes',
    });
    await commit(check.claims);
    expect((await row(run.id)).state).toBe('queued');

    // The run is given its result by an attempt that only records it.
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe('TAP at $412: https://example.test/book');
    expect(finished.check).toEqual({ enabled: true, state: 'passed', gaps: [] });
    expect(finished.status_line).toStartWith('Done · checked');
    const markdown = runExportResponse.parse(
      await (await request(`/runs/${run.id}/export`)).json(),
    ).markdown;
    expect(markdown).toContain('Checked');
    expect(markdown).toContain('The result checks out');
    // The person is told once, with the result.
    const pushes = await required(handle)
      .db.select({ body: pushIntent.body })
      .from(pushIntent)
      .where(sql`starts_with(${pushIntent.dedupKey}, ${`run-report:${run.id}:`})`);
    expect(pushes.map((push) => push.body)).toEqual(['TAP at $412: https://example.test/book']);
  });

  test('gaps go back to the work; after two checks with gaps the result is given with them named', async () => {
    const run = await start({
      goal: 'Write the launch questions and answers',
      done_when: 'Every question on the list is answered',
    });
    const give = async (summary: string, gaps: string[]) => {
      const shift = await claim(run.id);
      await tool(shift.claims, 'run.finish', { summary });
      await commit(shift.claims);
      const check = await claim(await checker(run.id));
      await tool(check.claims, 'run.finish', { summary: 'Not yet.', verdict: 'gaps', gaps });
      await commit(check.claims);
      return shift;
    };
    await give('All answered.', ['The pricing question has no answer']);
    expect((await row(run.id)).state).toBe('queued');
    expect((await view(run.id)).check).toEqual({
      enabled: true,
      state: 'gaps',
      gaps: ['The pricing question has no answer'],
    });

    // The next shift starts with the gaps, then the rest of its brief.
    const next = await claimNow(run.id);
    const brief = required(next).bundle.job.objective;
    expect(brief).toContain(
      'A separate check of the result you gave found it is not done yet:\n- The pricing question has no answer',
    );
    expect(brief.indexOf('found it is not done yet')).toBeLessThan(
      brief.indexOf('long work done in shifts'),
    );
    await tool(required(next).claims, 'run.finish', { summary: 'Pricing answered too.' });
    await commit(required(next).claims);
    const check = await claim(await checker(run.id));
    await tool(check.claims, 'run.finish', {
      summary: 'One left.',
      verdict: 'gaps',
      gaps: ['The refund question has no answer'],
    });
    await commit(check.claims);

    // The second check with gaps is the last: the result is given, saying what was not confirmed.
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.status).toBe('done');
    expect(finished.result).toBe(
      'Pricing answered too.\n\nWhat a separate check could not confirm:\n- The refund question has no answer',
    );
    expect(finished.check.state).toBe('not_confirmed');
    expect(finished.status_line).toStartWith('Done · not fully confirmed');
  });

  test('finishing during the check is refused; a check without a verdict says so; checks can be off', async () => {
    const run = await start({ goal: 'Summarise the contract', done_when: 'Every clause covered' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: 'Twelve clauses, summarised.' });
    await commit(shift.claims);

    // The person writes while the check runs; that shift cannot give the result again.
    await request(`/runs/${run.id}/message`, 'POST', { text: 'Also note the renewal date.' });
    const again = await claim(run.id);
    expect(
      String(await rejectionOf(tool(again.claims, 'run.finish', { summary: 'Again.' }))),
    ).toContain('being checked right now');
    await tool(again.claims, 'run.checkpoint', {
      summary: 'Waiting for the check.',
      next: 'Read what it found.',
      next_shift: 'when_helpers_finish',
    });
    await commit(again.claims);
    expect((await row(run.id)).state).toBe('waiting_for_event_or_time');

    // The check answers without a verdict: the result is given, and says it was not confirmed.
    const check = await claim(await checker(run.id));
    await commit(check.claims, done('It seems fine to me.'));
    expect((await row(run.id)).state).toBe('queued');
    expect(await claimNow(run.id)).toBeNull();
    const finished = await view(run.id);
    expect(finished.result).toBe(
      'Twelve clauses, summarised.\n\nA separate check of this could not be finished: It seems fine to me.',
    );
    expect(finished.check.state).toBe('not_confirmed');

    // The person can turn the check off for a piece of work.
    const plain = await start({ goal: 'Tidy the notes', done_when: 'The notes are tidy' });
    const set = await request(`/runs/${plain.id}/limit`, 'PUT', { check_result: false });
    expect(runResponse.parse(await set.json()).run.check.enabled).toBe(false);
    const tidy = await claim(plain.id);
    const result = (await tool(tidy.claims, 'run.finish', { summary: 'Tidied.' })) as {
      status: string;
    };
    expect(result.status).toBe('finished');
    await commit(tidy.claims);
    expect((await view(plain.id)).status).toBe('done');
    expect((await view(plain.id)).check.state).toBeNull();
  });

  test("the brief lists what was tried and didn't work", async () => {
    const run = await start({ goal: 'Speed up the build' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'Cache dependencies',
      value: 95,
      outcome: 'discarded',
      body: 'Slower on a cold cache',
    });
    await tool(shift.claims, 'run.log', {
      kind: 'experiment',
      title: 'Parallel tests',
      outcome: 'failed',
    });
    await tool(shift.claims, 'run.log', {
      kind: 'note',
      title: 'Bigger build machine',
      body: 'Not offered on this plan',
      dead_end: true,
    });
    await tool(shift.claims, 'run.log', { kind: 'note', title: 'An ordinary note' });
    await commit(shift.claims);
    const brief = (await claim(run.id)).bundle.job.objective;
    expect(brief).toContain(
      [
        "Already tried, didn't work (do not repeat these):",
        '- Bigger build machine: Not offered on this plan',
        '- Parallel tests',
        '- Cache dependencies = 95: Slower on a cold cache',
      ].join('\n'),
    );
    expect(brief).not.toContain('An ordinary note');
  });

  test('the same call a fourth time in one shift is refused with a reason', async () => {
    const broker = new BrokerService({
      sql: required(handle).sql,
      connectors: new ConnectorRegistry(),
      runs: required(runs),
    });
    const brokerApp = createBrokerApp({
      broker,
      capabilityKey: KEY,
      approvalKey: 'runs-check-fixture-approval-key-32-bytes',
    });
    const call = (claims: CapabilityClaims, name: string, args: unknown) =>
      brokerApp.request('/tools/call', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signCapability(claims, KEY)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, arguments: args }),
      });
    const run = await start({ goal: 'Loop on purpose' });
    const shift = await claim(run.id);
    for (let made = 0; made < REPEAT_LIMIT; made++)
      expect((await call(shift.claims, 'run.log', { title: 'Same', kind: 'note' })).status).toBe(
        200,
      );
    // The same arguments in another order are the same call.
    const looped = await call(shift.claims, 'run.log', { kind: 'note', title: 'Same' });
    expect(looped.status).toBe(409);
    expect(JSON.stringify(await looped.json())).toContain('change your approach');
    expect((await call(shift.claims, 'run.log', { kind: 'note', title: 'Other' })).status).toBe(
      200,
    );
    // The engine names a proposal after its arguments, so the same call made
    // again carries the same reference: that is a repeat too.
    const propose = async () =>
      JSON.stringify(
        await (
          await brokerApp.request('/actions', {
            method: 'POST',
            headers: {
              authorization: `Bearer ${signCapability(shift.claims, KEY)}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              connection_id: sandbox,
              kind: 'web.fetch',
              payload: { url: 'https://example.test/prices' },
              client_ref: `${run.id}:web.fetch:same-digest`,
            }),
          })
        ).json(),
      );
    for (let made = 0; made < REPEAT_LIMIT; made++)
      expect(await propose()).not.toContain('already made');
    expect(await propose()).toContain('already made 3 times');
    // The next shift starts its own count.
    await commit(shift.claims);
    const next = await claim(run.id);
    expect((await call(next.claims, 'run.log', { kind: 'note', title: 'Same' })).status).toBe(200);
  });

  test('a cancelled helper wakes its run; helpers ending at once wake it too', async () => {
    const run = await start({ goal: 'Ask around' });
    const lead = await claim(run.id);
    const helper = async (task: string) =>
      ((await tool(lead.claims, 'run.delegate', { task })) as { helper_id: string }).helper_id;
    const cancelled = await helper('Ask the first shop');
    await tool(lead.claims, 'run.checkpoint', {
      summary: 'Asked.',
      next: 'Read the answers.',
      next_shift: 'when_helpers_finish',
    });
    await commit(lead.claims);
    // Through the generic job API, as a person cancelling the job would.
    const response = await request(`/jobs/${cancelled}/cancel`, 'POST');
    expect(response.status).toBe(200);
    expect((await row(cancelled)).state).toBe('cancelled');
    expect((await row(run.id)).state).toBe('queued');
    const record = runRecordResponse.parse(
      await (await request(`/runs/${run.id}/record`)).json(),
    ).entries;
    expect(record.find((entry) => entry.kind === 'step_finished')?.title).toBe(
      'Ask the first shop: stopped',
    );

    // Two helpers end at the moment the run ends its shift: it is not left on its long fallback.
    const second = await claim(run.id);
    const one = (
      (await tool(second.claims, 'run.delegate', { task: 'Ask the second shop' })) as {
        helper_id: string;
      }
    ).helper_id;
    const two = (
      (await tool(second.claims, 'run.delegate', { task: 'Ask the third shop' })) as {
        helper_id: string;
      }
    ).helper_id;
    await tool(second.claims, 'run.checkpoint', {
      summary: 'Asked two more.',
      next: 'Read the answers.',
      next_shift: 'when_helpers_finish',
    });
    const first = await claim(one);
    const other = await claim(two);
    await tool(first.claims, 'run.finish', { summary: 'Open on Sundays.' });
    await tool(other.claims, 'run.finish', { summary: 'Closed on Sundays.' });
    await Promise.all([commit(second.claims), commit(first.claims), commit(other.claims)]);
    const after = await row(run.id);
    expect(
      after.state === 'queued' ||
        (after.state === 'waiting_for_event_or_time' &&
          (after.nextWakeAt?.getTime() ?? 0) < Date.now() + 60_000),
    ).toBe(true);
  });

  test('a person\'s "continue" starts the count of failures again, lost shifts included', async () => {
    const run = await start({ goal: 'Keeps getting interrupted' });
    for (let lose = 0; lose < 3; lose++) {
      const shift = await claim(run.id);
      expect(await required(runner).loseAttempt(shift.claims.attempt_id, 'lease expired')).toBe(
        true,
      );
    }
    expect((await row(run.id)).state).toBe('waiting_for_input');
    await request(`/runs/${run.id}/message`, 'POST', { text: 'continue' });
    const shift = await claim(run.id);
    await required(runner).loseAttempt(shift.claims.attempt_id, 'lease expired');
    // One loss after the answer is retried, not asked about again.
    expect((await row(run.id)).state).toBe('queued');
  });

  test('a shift lost after it gave its result completes with that result', async () => {
    const run = await start({ goal: 'Lost at the end' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.finish', { summary: 'The answer is 42.' });
    expect(await required(runner).loseAttempt(shift.claims.attempt_id, 'lease expired')).toBe(true);
    expect((await row(run.id)).state).toBe('completed');
    expect((await view(run.id)).result).toBe('The answer is 42.');
  });

  test('a helper whose action cannot be read back ends, saying so, instead of waiting', async () => {
    const run = await start({ goal: 'Unclear helper' });
    const lead = await claim(run.id);
    const id = (
      (await tool(lead.claims, 'run.delegate', { task: 'Send the form' })) as { helper_id: string }
    ).helper_id;
    await commit(lead.claims);
    const step = await claim(id);
    await commit(step.claims, {
      kind: 'unknown_check',
      check: 'parked_actions',
      reason: 'timed_out',
      message: 'The form may or may not have been sent.',
    });
    expect((await row(id)).state).toBe('failed');
    const helpers = (await view(run.id)).steps;
    expect(helpers[0]?.result).toContain('could not tell whether an action went through');
  });

  test('work keeps the conversation’s limits, and a goal the person typed is theirs', async () => {
    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        {
          space_id: spaceId,
          title: 'Research',
          objective: 'Research',
          constraints: {
            public_compartment: true,
            allowed_domains: ['example.test'],
            deliverable: { kind: 'answer' },
          },
        },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(chat.id, 'Keep looking into public prices.');
    const turn = await claim(chat.id);
    const started = (await tool(turn.claims, 'run.start', { goal: 'Track public prices' })) as {
      run_id: string;
    };
    const derived = await row(started.run_id);
    expect(derived.constraints).toMatchObject({
      public_compartment: true,
      allowed_domains: ['example.test'],
      deliverable: { kind: 'none' },
    });
    expect(derived.objectiveOrigin).toBe('derived');
    const lead = await claim(started.run_id);
    const helper = (
      (await tool(lead.claims, 'run.delegate', { task: 'One shop' })) as { helper_id: string }
    ).helper_id;
    expect((await row(helper)).constraints).toMatchObject({ public_compartment: true });

    const typed = await start({ goal: 'Something I typed' });
    expect((await row(typed.id)).objectiveOrigin).toBe('owner_request');
  });

  test('progress notifications are spaced out; the result always goes', async () => {
    const run = await start({ goal: 'Chatty work' });
    const shift = await claim(run.id);
    await tool(shift.claims, 'run.log', { kind: 'report', title: 'Halfway', body: 'Half done.' });
    await tool(shift.claims, 'run.log', { kind: 'report', title: 'Nearly', body: 'Nearly done.' });
    await tool(shift.claims, 'run.finish', { summary: 'All done.' });
    await commit(shift.claims);
    const pushes = await required(handle)
      .db.select({ body: pushIntent.body })
      .from(pushIntent)
      .where(sql`starts_with(${pushIntent.dedupKey}, ${`run-report:${run.id}:`})`)
      .orderBy(pushIntent.createdAt);
    expect(pushes.map((push) => push.body).sort()).toEqual(['All done.', 'Half done.']);
    // Both updates stay in the record.
    expect((await view(run.id)).latest_report?.title).toBe('Nearly');
  });

  test('the list reads many runs at once and agrees with each run read alone', async () => {
    const listed = runListResponse.parse(await (await request('/runs')).json()).runs;
    expect(listed.length).toBeGreaterThan(5);
    for (const entry of listed) expect(entry).toEqual(await view(entry.id));
  });
});

describe('the repeat guard', () => {
  const claims = (scopes: string[]) =>
    ({ attempt_id: newId('att'), scopes }) as unknown as CapabilityClaims;

  test('applies to long work only', () => {
    const guard = new RepeatGuard();
    const chat = claims(['run.start']);
    for (let made = 0; made < REPEAT_LIMIT + 2; made++)
      guard.note(chat, 'web.fetch', { url: 'https://example.test' });
    const run = claims(['run.log']);
    for (let made = 0; made < REPEAT_LIMIT; made++)
      guard.note(run, 'web.fetch', { url: 'https://example.test' });
    expect(() => guard.note(run, 'web.fetch', { url: 'https://example.test' })).toThrow(
      'already made 3 times',
    );
    guard.note(run, 'web.fetch', { url: 'https://example.test/other' });
  });
});
