/**
 * Standing work: a run that rests on a schedule or a watch between shifts,
 * wakes only when that fires, says why it woke, and never stops for being
 * quiet. Pause turns its trigger off, resume back on, stop removes it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  type JsonObject,
  RUN_IDLE_SHIFT_LIMIT,
  runResponse,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { createBrokerApp } from '../../src/broker/http.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { session } from '../../src/db/auth-schema.ts';
import {
  connection,
  experienceProfile,
  job,
  owner,
  pushIntent,
  runEntry,
  runState,
  space,
  trigger,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'standing-fixture-signing-key-32-bytes';
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
const mailId = newId('conn');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'standing@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
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
async function triggerOf(id: string) {
  const [registration] = await triggersOf(id);
  return required(registration);
}

/** Claims the job's next shift; the bundle is what the engine would be given. */
async function claim(id: string) {
  await required(handle)
    .db.update(job)
    .set({ nextWakeAt: new Date(Date.now() - 1000) })
    .where(eq(job.id, id));
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
const done = (summary = ''): AttemptOutcome => ({ kind: 'completed', summary, evidence: [] });
/** A shift that wakes, looks, finds nothing to say, and ends. */
async function quietShift(id: string) {
  const shift = await claim(id);
  await required(runner).commitOutcome(shift.claims, done());
  return shift;
}
const resting = async (id: string) => {
  const current = await row(id);
  expect(current.state).toBe('waiting_for_event_or_time');
  expect(current.wait).toMatchObject({ kind: 'event' });
};
let occurrence = 0;
const fire = async (id: string) =>
  required(triggers).fireSchedule((await triggerOf(id)).id, `occ-${++occurrence}`);
const mail = (key: string, payload: JsonObject) =>
  required(triggers).deliver({
    connection_id: mailId,
    event_name: 'mail.new',
    cursor: key,
    dedup_key: `${key}-${randomBytes(4).toString('hex')}`,
    payload,
  });
const notices = async (id: string) =>
  required(handle)
    .db.select()
    .from(pushIntent)
    .where(eq(pushIntent.url, `/#/runs/${id}`));

withDb('standing work', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('work that repeats rests on its schedule, wakes on it, and says why it woke', async () => {
    const run = await start({
      goal: 'Every weekday morning, check the supplier price list and tell me what changed',
      repeat: { cron: '0 9 * * 1-5' },
    });
    expect(run.standing).toMatchObject({ kind: 'schedule', description: 'Every weekday at 9:00' });
    expect(Date.parse(required(run.standing?.next_wake_at))).toBeGreaterThan(Date.now());

    // The first shift starts now, records a baseline, and rests on the schedule.
    const first = await claim(run.id);
    expect(first.bundle.job.objective).toContain(
      'This work stands: it wakes every weekday at 9:00',
    );
    await tool(first.claims, 'run.log', { kind: 'finding', title: 'Oak panels are $51' });
    await required(runner).commitOutcome(first.claims, done('Baseline recorded.'));
    await resting(run.id);
    const rested = await view(run.id);
    expect(rested.status).toBe('waiting');
    expect(rested.status_line).toBe('Waiting until next time');
    expect(rested.next_shift_at).toBe(rested.standing?.next_wake_at ?? 'missing');
    const handoff = await required(handle)
      .db.select()
      .from(runEntry)
      .where(and(eq(runEntry.runJobId, run.id), eq(runEntry.kind, 'checkpoint')));
    expect(handoff.at(-1)?.data).toMatchObject({ next_shift: 'on_trigger', automatic: true });

    // Nothing wakes it until the schedule does.
    await fire(run.id);
    expect((await row(run.id)).state).toBe('queued');
    const woke = await claim(run.id);
    expect(woke.bundle.job.objective).toContain(
      'Why this shift started: it is the scheduled time (every weekday at 9:00)',
    );
    await required(runner).commitOutcome(woke.claims, done());
    await resting(run.id);

    // A shift woken by the person's message rests again too, and has no schedule reason.
    expect((await request(`/runs/${run.id}/message`, 'POST', { text: 'Add posts' })).status).toBe(
      200,
    );
    expect((await row(run.id)).state).toBe('queued');
    const asked = await claim(run.id);
    expect(asked.bundle.job.objective).not.toContain('Why this shift started');
    await required(runner).commitOutcome(asked.claims, done());
    await resting(run.id);
  });

  test('quiet wakes are never idle and tell the person nothing; reports still do', async () => {
    const run = await start({ goal: 'Check the list each morning', repeat: { cron: '0 9 * * *' } });
    await quietShift(run.id);
    // A day old with nothing reported: ordinary work would get a daily summary.
    await required(handle)
      .db.update(runState)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(runState.jobId, run.id));
    for (let wake = 0; wake < RUN_IDLE_SHIFT_LIMIT + 2; wake++) {
      await fire(run.id);
      await quietShift(run.id);
      await resting(run.id);
    }
    expect((await view(run.id)).status).toBe('waiting');
    expect(await notices(run.id)).toHaveLength(0);
    const reports = await required(handle)
      .db.select()
      .from(runEntry)
      .where(and(eq(runEntry.runJobId, run.id), eq(runEntry.kind, 'report')));
    expect(reports).toHaveLength(0);

    await fire(run.id);
    const news = await claim(run.id);
    await tool(news.claims, 'run.log', { kind: 'report', title: 'Posts went up 4%' });
    await required(runner).commitOutcome(news.claims, done());
    expect(await notices(run.id)).toHaveLength(1);
    await resting(run.id);

    // Handing off to go on now, and nothing else, is still idle.
    await fire(run.id);
    for (let shift = 0; shift < RUN_IDLE_SHIFT_LIMIT; shift++) {
      const next = await claim(run.id);
      await tool(next.claims, 'run.checkpoint', {
        summary: 'Still on it.',
        next: 'Keep going.',
        next_shift: 'now',
      });
      await required(runner).commitOutcome(next.claims, done());
    }
    expect((await view(run.id)).status).toBe('needs_you');
  });

  test('a watch wakes only on what passes its test, and the shift reads what came in', async () => {
    // Mail from before the watch was set does not wake it.
    await mail('old', { from: 'orders@supplier.example', subject: 'Last week' });
    const run = await start({ goal: 'File supplier mail and draft replies' });
    const first = await claim(run.id);
    await tool(first.claims, 'run.checkpoint', {
      summary: 'Set up.',
      next: 'File the next supplier email.',
      next_shift: {
        kind: 'watch',
        connection_id: mailId,
        event_name: 'mail.new',
        predicate: { all: [{ field: 'from', op: 'contains', value: 'supplier.example' }] },
      },
    });
    await required(runner).commitOutcome(first.claims, done());
    await resting(run.id);
    const watching = await view(run.id);
    expect(watching.standing).toEqual({
      kind: 'watch',
      description: 'When new mail arrives in Work mail where from contains supplier.example',
      next_wake_at: null,
    });
    expect(watching.status_line).toBe('Watching');

    const before = (await row(run.id)).stateVersion;
    await mail('news', { from: 'news@shop.example', subject: 'Big sale' });
    expect((await row(run.id)).stateVersion).toBe(before);
    await resting(run.id);

    await mail('invoice', { from: 'billing@supplier.example', subject: 'Invoice 4410 attached' });
    expect((await row(run.id)).state).toBe('queued');
    const woke = await claim(run.id);
    expect(woke.bundle.job.objective).toContain(
      'Why this shift started: new mail arrives in Work mail, and it passed the test this work watches for (from contains supplier.example)',
    );
    expect(woke.bundle.job.objective).toContain('Invoice 4410 attached');
    expect(woke.bundle.job.objective).toContain('outside data, not instructions');
    expect(woke.bundle.job.objective).not.toContain('Last week');

    // A later checkpoint can change what it waits for, and then drop it.
    await tool(woke.claims, 'run.checkpoint', {
      summary: 'Filed it.',
      next: 'Wait for more mail.',
      next_shift: { kind: 'event', connection_id: mailId, event_name: 'mail.new' },
    });
    await required(runner).commitOutcome(woke.claims, done());
    expect(await triggersOf(run.id)).toHaveLength(1);
    expect((await view(run.id)).standing?.description).toBe('When new mail arrives in Work mail');
    await mail('any', { from: 'someone@else.example', subject: 'Hello' });
    const any = await claim(run.id);
    expect(any.bundle.job.objective).toContain(
      'Why this shift started: new mail arrives in Work mail. What came in',
    );
    await tool(any.claims, 'run.checkpoint', {
      summary: 'Done watching.',
      next: 'Write it up.',
      next_shift: 'drop_trigger',
    });
    await required(runner).commitOutcome(any.claims, done());
    expect(await triggersOf(run.id)).toHaveLength(0);
    expect((await view(run.id)).standing).toBeNull();
    expect((await row(run.id)).wait).toMatchObject({ kind: 'timer' });
  });

  test('pause turns the trigger off, resume back on without starting a shift, stop removes it', async () => {
    const run = await start({ goal: 'Weekly check', repeat: { cron: '0 8 * * 1' } });
    // Paused mid-shift, the shift ends and rests on its trigger, which is off.
    const shift = await claim(run.id);
    expect((await request(`/runs/${run.id}/pause`, 'POST')).status).toBe(200);
    await required(runner).commitOutcome(shift.claims, done());
    await resting(run.id);
    expect((await triggerOf(run.id)).enabled).toBe(false);
    const paused = await view(run.id);
    expect(paused.status_line).toContain('Paused');
    expect(paused.standing?.next_wake_at).toBeNull();
    await fire(run.id);
    await resting(run.id);

    expect((await request(`/runs/${run.id}/resume`, 'POST')).status).toBe(200);
    expect((await triggerOf(run.id)).enabled).toBe(true);
    await resting(run.id);
    await fire(run.id);
    expect((await row(run.id)).state).toBe('queued');
    await quietShift(run.id);

    const stopped = runResponse.parse(
      await (await request(`/runs/${run.id}/stop`, 'POST')).json(),
    ).run;
    expect(stopped.status).toBe('stopped');
    expect(stopped.standing).toBeNull();
    expect(await triggersOf(run.id)).toHaveLength(0);
  });

  test('finishing ends the standing, and limits the person set still stop it to ask', async () => {
    const finishing = await start({ goal: 'Until the price drops', repeat: { cron: '0 * * * *' } });
    expect((await view(finishing.id)).standing?.description).toBe('Every hour');
    const last = await claim(finishing.id);
    await tool(last.claims, 'run.finish', { summary: 'It dropped to $45.' });
    await required(runner).commitOutcome(last.claims, done());
    expect((await view(finishing.id)).status).toBe('done');
    expect(await triggersOf(finishing.id)).toHaveLength(0);

    const limited = await start({
      goal: 'Daily check, twice',
      repeat: { cron: '0 9 * * *' },
      limit: { max_shifts: 2 },
    });
    await quietShift(limited.id);
    await fire(limited.id);
    await quietShift(limited.id);
    const stopped = await view(limited.id);
    expect(stopped.status).toBe('needs_you');
    expect(stopped.question).toContain('limit you set');
  });

  test('a wake that could not work as meant is refused', async () => {
    const tooOften = await request('/runs', 'POST', {
      goal: 'Check constantly',
      repeat: { cron: '* * * * *' },
    });
    expect(tooOften.status).toBe(400);
    const nonsense = await request('/runs', 'POST', {
      goal: 'Check at no time',
      repeat: { cron: 'not a cron' },
    });
    expect(nonsense.status).toBe(400);

    const run = await start({ goal: 'Lead work' });
    const lead = await claim(run.id);
    expect(
      String(
        await rejectionOf(
          tool(lead.claims, 'run.checkpoint', {
            summary: 'Watch.',
            next: 'Wait.',
            next_shift: { kind: 'event', connection_id: newId('conn'), event_name: 'mail.new' },
          }),
        ),
      ),
    ).toContain('active connection');
    const helper = (await tool(lead.claims, 'run.delegate', { task: 'Side task' })) as {
      helper_id: string;
    };
    const side = await claim(helper.helper_id);
    expect(
      String(
        await rejectionOf(
          tool(side.claims, 'run.checkpoint', {
            summary: 'Wait.',
            next: 'Later.',
            next_shift: { kind: 'schedule', cron: '0 9 * * *' },
          }),
        ),
      ),
    ).toContain('helper cannot wait');
  });

  test('a schedule the work sets wakes it at most hourly, and the person is told each change', async () => {
    // The person may still have work wake every 5 minutes.
    const often = await start({ goal: 'Check often', repeat: { cron: '*/5 * * * *' } });
    expect((await request(`/runs/${often.id}/stop`, 'POST')).status).toBe(200);
    const told = async (id: string) =>
      (
        await required(handle)
          .db.select()
          .from(runEntry)
          .where(and(eq(runEntry.runJobId, id), eq(runEntry.kind, 'report')))
          .orderBy(runEntry.seq)
      ).map((entry) => entry.title);

    const run = await start({ goal: 'Keep an eye on the price list' });
    const first = await claim(run.id);
    const tooOften = String(
      await rejectionOf(
        tool(first.claims, 'run.checkpoint', {
          summary: 'Set up.',
          next: 'Look again.',
          next_shift: { kind: 'schedule', cron: '*/30 * * * *' },
        }),
      ),
    );
    expect(tooOften).toContain('at most once an hour');
    const weekdays = { kind: 'schedule', cron: '0 9 * * 1-5' };
    await tool(first.claims, 'run.checkpoint', {
      summary: 'Set up.',
      next: 'Look again.',
      next_shift: weekdays,
    });
    await required(runner).commitOutcome(first.claims, done());
    expect(await told(run.id)).toEqual(["I'll check this every weekday at 9:00."]);
    expect(await notices(run.id)).toHaveLength(1);

    // The same wake again is no news.
    await fire(run.id);
    const same = await claim(run.id);
    await tool(same.claims, 'run.checkpoint', {
      summary: 'Nothing new.',
      next: 'Look again.',
      next_shift: weekdays,
    });
    await required(runner).commitOutcome(same.claims, done());
    expect(await told(run.id)).toHaveLength(1);

    // A change, and dropping it, are each told at once, however soon after.
    await fire(run.id);
    const watch = await claim(run.id);
    await tool(watch.claims, 'run.checkpoint', {
      summary: 'Mail is quicker.',
      next: 'Read the next price mail.',
      next_shift: { kind: 'event', connection_id: mailId, event_name: 'mail.new' },
    });
    await required(runner).commitOutcome(watch.claims, done());
    await mail('prices', { from: 'prices@supplier.example', subject: 'New list' });
    const drop = await claim(run.id);
    await tool(drop.claims, 'run.checkpoint', {
      summary: 'Read it.',
      next: 'Write it up.',
      next_shift: 'drop_trigger',
    });
    await required(runner).commitOutcome(drop.claims, done());
    expect(await told(run.id)).toEqual([
      "I'll check this every weekday at 9:00.",
      "I'll check this when new mail arrives in Work mail.",
      "I'll stop checking on this by myself and carry on with it now.",
    ]);
    expect(await notices(run.id)).toHaveLength(3);
    expect((await request(`/runs/${run.id}/stop`, 'POST')).status).toBe(200);

    // A conversation starting work that repeats is held to the same hour.
    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: spaceId, title: 'Prices', objective: 'Prices' },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(chat.id, 'Keep checking the price list for me.');
    const turn = await claim(chat.id);
    expect(
      String(
        await rejectionOf(
          tool(turn.claims, 'run.start', {
            goal: 'Check the price list',
            repeat: { cron: '*/15 * * * *' },
          }),
        ),
      ),
    ).toContain('at most once an hour');
    const started = (await tool(turn.claims, 'run.start', {
      goal: 'Check the price list',
      repeat: { cron: '0 * * * *' },
    })) as { run_id: string };
    expect(await told(started.run_id)).toEqual(["I'll check this every hour."]);
    expect((await request(`/runs/${started.run_id}/stop`, 'POST')).status).toBe(200);
  });

  test('a report from a shift its trigger woke always reaches the person', async () => {
    const run = await start({ goal: 'Tell me about price changes', repeat: { cron: '0 9 * * *' } });
    await quietShift(run.id);
    const progress = async () =>
      (await notices(run.id)).filter((push) => push.dedupKey.startsWith(`run-report:${run.id}:`));
    for (const title of ['Posts went up 4%', 'Posts went up again']) {
      await fire(run.id);
      const woke = await claim(run.id);
      await tool(woke.claims, 'run.log', { kind: 'report', title });
      await required(runner).commitOutcome(woke.claims, done());
    }
    expect(await progress()).toHaveLength(2);
    // A shift the person's message started is spaced as before.
    await request(`/runs/${run.id}/message`, 'POST', { text: 'And panels?' });
    const asked = await claim(run.id);
    await tool(asked.claims, 'run.log', { kind: 'report', title: 'Panels are unchanged' });
    await required(runner).commitOutcome(asked.claims, done());
    expect(await progress()).toHaveLength(2);
    expect((await request(`/runs/${run.id}/stop`, 'POST')).status).toBe(200);
  });

  test('a weekly routine started from a conversation stands on its schedule, in the person’s time zone', async () => {
    const broker = new BrokerService({
      sql: required(handle).sql,
      connectors: new ConnectorRegistry(),
      runs: required(runs),
    });
    const brokerApp = createBrokerApp({
      broker,
      capabilityKey: KEY,
      approvalKey: 'standing-fixture-approval-key-32-bytes!',
    });
    await required(handle)
      .db.insert(experienceProfile)
      .values({ spaceId, timeZone: 'America/Los_Angeles' })
      .onConflictDoUpdate({
        target: experienceProfile.spaceId,
        set: { timeZone: 'America/Los_Angeles' },
      });
    const chat = await required(jobs).transaction((tx) =>
      required(jobs).createInTransaction(
        tx,
        { space_id: spaceId, title: 'Routine', objective: 'Routine' },
        { kind: 'chat' },
      ),
    );
    await required(jobs).input(
      chat.id,
      'Set up a routine called smoke-routine that checks in with me every Monday at 9am',
    );
    const turn = await claim(chat.id);
    // The call as the engine forwards it: the broker route, then the run service.
    const call = (args: Record<string, unknown>) =>
      required(brokerApp).request('/tools/call', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${signCapability(turn.claims, KEY)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'run.start', arguments: args }),
      });
    const refusal = async (args: Record<string, unknown>) => {
      const response = await call(args);
      expect(response.status).toBe(409);
      return ((await response.json()) as { error: { message: string } }).error.message;
    };
    const goal = 'Check in with the person every Monday at 9:00';

    // Without a time zone, the person's own is used.
    const plain = await call({ goal, title: 'smoke-routine', repeat: { cron: '0 9 * * 1' } });
    expect(plain.status).toBe(200);
    const { run_id } = (await plain.json()) as { run_id: string };
    expect((await triggerOf(run_id)).spec).toEqual({
      kind: 'schedule',
      cron: '0 9 * * 1',
      timezone: 'America/Los_Angeles',
    });
    const standing = (await view(run_id)).standing;
    expect(standing).toMatchObject({ kind: 'schedule', description: 'Every Monday at 9:00' });
    expect(Date.parse(required(standing?.next_wake_at))).toBeGreaterThan(Date.now());
    expect((await request(`/runs/${run_id}/stop`, 'POST')).status).toBe(200);

    // A zone the model names is kept.
    const named = await call({
      goal,
      title: 'smoke-routine',
      repeat: { cron: '0 9 * * 1', timezone: 'Europe/Berlin' },
    });
    expect(named.status).toBe(200);
    const namedRun = ((await named.json()) as { run_id: string }).run_id;
    expect((await triggerOf(namedRun)).spec).toMatchObject({ timezone: 'Europe/Berlin' });
    expect((await request(`/runs/${namedRun}/stop`, 'POST')).status).toBe(200);

    // A refusal says what to fix.
    const empty = await refusal({ goal, repeat: {} });
    expect(empty).toContain('repeat.cron: missing');
    expect(empty).toContain('"0 9 * * 1" is Mondays at 9:00');
    expect(await refusal({ goal, repeat: { cron: 'every Monday at 9' } })).toContain(
      '"every Monday at 9" is not a cron this can follow. Write it as five fields',
    );
    expect(await refusal({ goal, repeat: { cron: '0 9 * * 1', timezone: 'Pacific' } })).toContain(
      '"Pacific" is not a time zone',
    );
    expect(await refusal({ goal, repeat: { cron: '0 9 * * 1', every: 'week' } })).toContain(
      'repeat: Unrecognized key: "every"',
    );
  });
});
