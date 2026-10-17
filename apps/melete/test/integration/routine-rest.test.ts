/**
 * Standing work for people who stopped coming, and the most routines one
 * person may keep. Both are operator settings, off unless set: with them off
 * nothing rests and nothing is refused.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  agentResponse,
  homeResponse,
  type JsonObject,
  runResponse,
} from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { connection, event, owner, principal, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { forgetSeen, markSeen, ROUTINES_BACK_LINE } from '../../src/jobs/resting.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'rest-fixture-signing-key-32-bytes' })
  : null;
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'rest@example.test' });
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
const row = async (id: string) => required(jobs).get(id);
async function triggerOf(id: string) {
  const [registration] = await required(handle)
    .db.select()
    .from(trigger)
    .where(eq(trigger.jobId, id));
  return required(registration);
}
async function claim(id: string) {
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
const done = (): AttemptOutcome => ({ kind: 'completed', summary: '', evidence: [] });
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
const waiting = async (id: string) =>
  expect((await row(id)).state).toBe('waiting_for_event_or_time');
/** The person was last seen this many days ago; no request may follow, or they are seen again. */
const away = (days: number) =>
  required(handle)
    .db.update(principal)
    .set({ lastSeenAt: sql`now() - make_interval(days => ${days})` })
    .where(eq(principal.id, ownerId));
/** Standing work set up and through its first shift, resting on its schedule. */
async function daily(goal: string) {
  const run = await start({ goal, repeat: { cron: '0 9 * * *' } });
  const first = await claim(run.id);
  await required(runner).commitOutcome(first.claims, done());
  await waiting(run.id);
  return run.id;
}

withDb('standing work for people who stopped coming', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('it rests while the person is away and comes back on without running what was missed', async () => {
    required(jobs).standingWork = { restAfterDays: 14 };
    const scheduled = await daily('Every morning, check the supplier prices');
    // Work that waits for mail.
    const watching = (await start({ goal: 'File supplier invoices as they come' })).id;
    const shift = await claim(watching);
    await required(runs).call(shift.claims, 'run.checkpoint', {
      summary: 'Ready.',
      next: 'Wait for mail.',
      next_shift: { kind: 'event', connection_id: mailId, event_name: 'mail.new' },
    });
    await required(runner).commitOutcome(shift.claims, done());
    await waiting(watching);

    await away(20);
    await fire(scheduled);
    await mail('away', { from: 'billing@supplier.example', subject: 'Sent while away' });
    // Neither woke, and the missed time left nothing behind to run later.
    await waiting(scheduled);
    await waiting(watching);
    const missed = await required(handle)
      .db.select()
      .from(event)
      .where(
        and(
          sql`${event.payload}->>'kind' = 'schedule_event'`,
          sql`${event.payload}->>'trigger_id' = ${(await triggerOf(scheduled)).id}`,
        ),
      );
    expect(missed).toHaveLength(0);

    // Seen again: back on, counting from now.
    forgetSeen();
    expect(await markSeen(required(handle).db, ownerId, 14)).toBe(true);
    await waiting(scheduled);
    await waiting(watching);
    const [person] = await required(handle)
      .db.select()
      .from(principal)
      .where(eq(principal.id, ownerId));
    expect(required(person).routinesResumedAt).not.toBeNull();
    expect(Date.now() - required(person).lastSeenAt.getTime()).toBeLessThan(60_000);

    // What arrives now wakes it; what came while away does not.
    await mail('back', { from: 'billing@supplier.example', subject: 'Sent after coming back' });
    expect((await row(watching)).state).toBe('queued');
    const woke = await claim(watching);
    expect(woke.bundle.job.objective).toContain('Sent after coming back');
    expect(woke.bundle.job.objective).not.toContain('Sent while away');
    await required(runner).commitOutcome(woke.claims, done());
    await fire(scheduled);
    expect((await row(scheduled)).state).toBe('queued');

    // The person reads one plain line where they look first.
    const home = homeResponse.parse(await (await request('/home')).json());
    expect(home.routines_back).toBe(ROUTINES_BACK_LINE);
  });

  test('a person seen recently, or an installation without the setting, never rests', async () => {
    required(jobs).standingWork = { restAfterDays: 14 };
    const recent = await daily('Every morning, read the news');
    await away(3);
    await fire(recent);
    expect((await row(recent)).state).toBe('queued');

    required(jobs).standingWork = {};
    const unset = await daily('Every morning, read the weather');
    await away(400);
    await fire(unset);
    expect((await row(unset)).state).toBe('queued');
    // Seen again with nothing resting, nobody is told anything.
    await required(handle)
      .db.update(principal)
      .set({ routinesResumedAt: null })
      .where(eq(principal.id, ownerId));
    forgetSeen();
    expect(await markSeen(required(handle).db, ownerId, undefined)).toBe(false);
    const home = homeResponse.parse(await (await request('/home')).json());
    expect(home.routines_back).toBeUndefined();
  });

  test('a routine past the limit is refused with a sentence to pass on', async () => {
    const [kept] = await required(handle).sql`select count(*)::int as n from job j
      where j.principal_id = ${ownerId} and j.state not in ('completed', 'failed', 'cancelled')
        and (j.kind = 'routine' or (j.kind = 'run' and exists (select 1 from trigger t where t.job_id = j.id)))`;
    const limit = Number(required(kept).n) + 1;
    required(jobs).standingWork = { routinesPerPerson: limit };
    await daily('Every morning, check the garden forecast');

    const refused = await request('/runs', 'POST', {
      goal: 'Every evening, list tomorrow',
      repeat: { cron: '0 18 * * *' },
    });
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('too_many_routines');
    expect(body.error.message).toBe(
      `You already have ${limit} routines, the most this installation keeps for one person. Delete or end one you no longer need, then add this one.`,
    );

    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const routine = await request('/automations', 'POST', {
      title: 'Weekday check',
      instruction: 'Check today',
      weekdays: [1, 2, 3, 4, 5],
      at: '08:30',
      agent_id: persona.id,
    });
    expect(routine.status).toBe(409);

    // Work that does not repeat is not a routine, and is still taken.
    await start({ goal: 'Find a plumber once' });
    // Without the setting, nothing is refused.
    required(jobs).standingWork = {};
    await start({ goal: 'Every evening, list tomorrow', repeat: { cron: '0 18 * * *' } });
  });
});
