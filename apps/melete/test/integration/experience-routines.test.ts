import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  automationResponse,
  conversationResponse,
  experienceOperations,
  homeResponse,
  profileResponse,
  triggerSpec,
  turnList,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { owner, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { buildAttemptSkeleton } from '../../src/jobs/bundle.ts';
import { QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'routines-fixture-signing-key-32-bytes',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : undefined;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      triggers,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'routines@example.test' });
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
const profile = async () => profileResponse.parse(await (await request('/profile')).json()).profile;
const hours = { start: '08:00', end: '22:00' };

/** Fires a routine now and ends its run with the outcome given. */
async function run(
  routineId: string,
  outcome:
    | { kind: 'completed'; summary: string; evidence: [] }
    | { kind: 'failed'; reason: string; retryable: false },
) {
  expect((await request(`/automations/${routineId}/test`, 'POST')).status).toBe(200);
  const [registration] = await required(handle)
    .db.select()
    .from(trigger)
    .where(eq(trigger.id, routineId));
  const row = await required(jobs).get(required(registration).jobId);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'event',
    }),
  );
  await required(runner).commitOutcome(claimed.claims, outcome);
  return row.id;
}

withDb('routines, time zone and setup as the person sees them', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a new account is not set up and its time zone is only a default', async () => {
    const fresh = await profile();
    expect(fresh.onboarded).toBe(false);
    expect(fresh.time_zone).toBe('UTC');
    expect(fresh.time_zone_confirmed).toBe(false);
    // Saving the default without choosing it does not count as a choice.
    await request('/profile', 'PATCH', { name: 'Sam', time_zone: 'UTC', day_hours: hours });
    expect((await profile()).time_zone_confirmed).toBe(false);
    await request('/profile', 'PATCH', {
      name: 'Sam',
      time_zone: 'UTC',
      day_hours: hours,
      time_zone_confirmed: true,
      onboarded: true,
    });
    const saved = await profile();
    expect(saved.time_zone_confirmed).toBe(true);
    expect(saved.onboarded).toBe(true);
    // A later save that leaves the flags out never forgets them.
    await request('/profile', 'PATCH', { name: 'Sam D', time_zone: 'UTC', day_hours: hours });
    expect(await profile()).toMatchObject({ onboarded: true, time_zone_confirmed: true });
  });

  test('each run writes its answer into the routine thread, the list and Home', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations/morning-brief', 'POST', { agent_id: persona.id, at: '08:30' })
      ).json(),
    ).automation;
    expect(routine.schedule).toBe('Every day at 8:30 AM (UTC)');
    expect(routine.runs).toEqual([]);

    const thread = await run(routine.id, {
      kind: 'completed',
      summary: 'Two meetings today, and the passport form is still open.',
      evidence: [],
    });
    expect(thread).toBe(routine.conversation_id);
    const list = experienceOperations['GET /automations'].response.parse(
      await (await request('/automations')).json(),
    );
    const latest = required(list.automations.find((row) => row.id === routine.id)?.runs[0]);
    expect(latest).toMatchObject({
      status: 'done',
      conversation_id: thread,
      summary: 'Two meetings today, and the passport form is still open.',
      reason: null,
    });

    // The thread reads like a chat: the instruction, then the answer.
    const opened = conversationResponse.parse(
      await (await request(`/conversations/${thread}`)).json(),
    ).conversation;
    expect(opened.automation_id).toBe(routine.id);
    const turns = turnList.parse(
      await (await request(`/conversations/${thread}/messages`)).json(),
    ).turns;
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: latest.turn_id,
      status: 'done',
      answer: 'Two meetings today, and the passport form is still open.',
    });
    expect(turns[0]?.text).toContain('Summarize my upcoming events');
    // A reply belongs in a chat of its own, not in the routine's schedule.
    const reply = await request(`/conversations/${thread}/messages`, 'POST', { text: 'More?' });
    expect(reply.status).toBe(409);
    // Routine threads stay out of the chat list.
    const chats = (await (await request('/conversations')).json()) as {
      conversations: { id: string }[];
    };
    expect(chats.conversations.map((chat) => chat.id)).not.toContain(thread);

    const home = homeResponse.parse(await (await request('/home')).json());
    expect(home.routine_results[0]).toMatchObject({
      automation_id: routine.id,
      title: 'Your morning brief',
      conversation_id: thread,
      run: { status: 'done', turn_id: latest.turn_id },
    });

    // A failed run says why.
    await run(routine.id, {
      kind: 'failed',
      reason: 'The calendar could not be reached.',
      retryable: false,
    });
    const failed = experienceOperations['GET /automations'].response.parse(
      await (await request('/automations')).json(),
    );
    expect(failed.automations.find((row) => row.id === routine.id)?.runs[0]).toMatchObject({
      status: 'failed',
      reason: 'It failed: The calendar could not be reached.',
    });
    const after = turnList.parse(
      await (await request(`/conversations/${thread}/messages`)).json(),
    ).turns;
    expect(after.map((turn) => turn.status)).toEqual(['done', 'failed']);
  });

  test('changing the time zone moves every routine and keeps its local hour across DST', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations', 'POST', {
          title: 'Weekday check',
          instruction: 'Check today',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          at: '08:30',
          agent_id: persona.id,
        })
      ).json(),
    ).automation;
    expect(routine.schedule).toContain('(UTC)');
    const saved = await request('/profile', 'PATCH', {
      name: 'Sam',
      time_zone: 'America/New_York',
      day_hours: hours,
    });
    expect(saved.status).toBe(200);
    expect((await profile()).time_zone).toBe('America/New_York');
    const list = experienceOperations['GET /automations'].response.parse(
      await (await request('/automations')).json(),
    );
    for (const row of list.automations) expect(row.schedule).toContain('(America/New_York)');
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const spec = triggerSpec.parse(required(registration).spec);
    if (spec.kind !== 'schedule') throw new Error('not a schedule');
    expect(spec.timezone).toBe('America/New_York');
    const [registered] = await required(queue).boss.getSchedules(
      QUEUES.triggerSchedule,
      routine.id,
    );
    expect(registered?.timezone).toBe('America/New_York');
    // 8:30 in New York is 12:30 UTC before the clocks go back on 1 November, 13:30 after.
    const next = required(queue).boss.previewSchedule(spec.cron, {
      tz: spec.timezone,
      from: new Date('2026-10-30T00:00:00Z'),
      count: 4,
    });
    expect(next.map((at) => at.toISOString())).toEqual([
      '2026-10-30T12:30:00.000Z',
      '2026-10-31T12:30:00.000Z',
      '2026-11-01T13:30:00.000Z',
      '2026-11-02T13:30:00.000Z',
    ]);
  });

  test('a routine can be paused, resumed and deleted, and a failed or stopped one says so', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const create = async (title: string) =>
      automationResponse.parse(
        await (
          await request('/automations', 'POST', {
            title,
            instruction: 'Write a haiku',
            weekdays: [6],
            at: '07:15',
            agent_id: persona.id,
          })
        ).json(),
      ).automation;
    const listed = async (id: string) =>
      experienceOperations['GET /automations'].response
        .parse(await (await request('/automations')).json())
        .automations.find((row) => row.id === id);
    const scheduled = async (id: string) =>
      (await required(queue).boss.getSchedules(QUEUES.triggerSchedule, id)).length > 0;

    const routine = await create('Daily haiku');
    // Each run shows its own answer, and a failed run leaves the routine on.
    await run(routine.id, { kind: 'completed', summary: 'First haiku.', evidence: [] });
    await run(routine.id, { kind: 'failed', reason: 'The model refused.', retryable: false });
    await run(routine.id, { kind: 'completed', summary: 'Second haiku.', evidence: [] });
    const runs = required(await listed(routine.id)).runs;
    expect(runs.map((entry) => [entry.status, entry.summary])).toEqual([
      ['done', 'Second haiku.'],
      ['failed', null],
      ['done', 'First haiku.'],
    ]);
    expect((await required(jobs).get(routine.conversation_id)).state).toBe(
      'waiting_for_event_or_time',
    );
    expect((await listed(routine.id))?.enabled).toBe(true);

    // Paused, nothing is scheduled and a test run is refused until it is resumed.
    const paused = await request(`/automations/${routine.id}/pause`, 'POST');
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ automation: { enabled: false } });
    expect(await scheduled(routine.id)).toBe(false);
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    expect((await required(jobs).get(routine.conversation_id)).state).toBe(
      'waiting_for_event_or_time',
    );
    expect((await request(`/automations/${routine.id}/resume`, 'POST')).status).toBe(200);
    expect(await scheduled(routine.id)).toBe(true);
    expect((await listed(routine.id))?.enabled).toBe(true);

    // A run under way when it is paused finishes, and the routine rests rather than ending.
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    const row = await required(jobs).get(routine.conversation_id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'event',
      }),
    );
    // An occurrence due while it runs is not owed a run once it is paused and resumed.
    await required(triggers).fireSchedule(routine.id, 'backlog');
    expect((await request(`/automations/${routine.id}/pause`, 'POST')).status).toBe(200);
    const rested = await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Third haiku.',
      evidence: [],
    });
    expect(rested.state).toBe('waiting_for_event_or_time');
    expect((await request(`/automations/${routine.id}/resume`, 'POST')).status).toBe(200);
    expect((await required(jobs).get(routine.conversation_id)).state).toBe(
      'waiting_for_event_or_time',
    );
    await required(triggers).fireSchedule(routine.id, 'next');
    expect((await required(jobs).get(routine.conversation_id)).state).toBe('queued');
    await required(jobs).cancel(routine.conversation_id);

    // A routine whose job was stopped is off, and says why it cannot run.
    const stopped = await create('Stopped haiku');
    await required(jobs).cancel(stopped.conversation_id);
    expect(await listed(stopped.id)).toMatchObject({ enabled: false, ended: true });
    expect((await listed(routine.id))?.ended).toBe(true);
    const refused = await request(`/automations/${stopped.id}/test`, 'POST');
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'routine_ended',
    );

    // Deleting stops it for good and takes it off the list.
    const deleted = await request(`/automations/${routine.id}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: 'ok' });
    expect(await listed(routine.id)).toBeUndefined();
    expect(await scheduled(routine.id)).toBe(false);
    expect((await required(jobs).get(routine.conversation_id)).state).toBe('cancelled');
    expect((await request(`/automations/${stopped.id}`, 'DELETE')).status).toBe(200);
    expect(await listed(stopped.id)).toBeUndefined();
  });

  test('a stopped routine starts again with the same settings in the old one’s place', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    const created = automationResponse.parse(
      await (
        await request('/automations', 'POST', {
          title: 'Weekday brief',
          instruction: 'Summarize my day',
          weekdays: [1, 2, 3, 4, 5],
          at: '06:45',
          agent_id: persona.id,
        })
      ).json(),
    ).automation;
    const listed = async () =>
      experienceOperations['GET /automations'].response.parse(
        await (await request('/automations')).json(),
      ).automations;
    const scheduled = async (id: string) =>
      (await required(queue).boss.getSchedules(QUEUES.triggerSchedule, id)).length > 0;

    // One that has not ended is resumed, not started again.
    const early = await request(`/automations/${created.id}/restart`, 'POST');
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
      'routine_not_ended',
    );
    expect(await scheduled(created.id)).toBe(true);

    await run(created.id, { kind: 'completed', summary: 'A quiet day.', evidence: [] });
    await required(jobs).cancel(created.conversation_id);
    expect((await listed()).find((row) => row.id === created.id)?.ended).toBe(true);

    const restarted = await request(`/automations/${created.id}/restart`, 'POST');
    expect(restarted.status).toBe(200);
    const fresh = automationResponse.parse(await restarted.json()).automation;
    expect(fresh).toMatchObject({
      title: 'Weekday brief',
      schedule: created.schedule,
      enabled: true,
      ended: false,
      runs: [],
    });
    expect(fresh.id).not.toBe(created.id);
    expect(fresh.conversation_id).not.toBe(created.conversation_id);
    expect(await required(jobs).get(fresh.conversation_id)).toMatchObject({
      objective: 'Summarize my day',
      agentId: persona.id,
      state: 'waiting_for_event_or_time',
    });
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, fresh.id));
    expect(triggerSpec.parse(required(registration).spec)).toMatchObject({
      kind: 'schedule',
      cron: '45 6 * * 1,2,3,4,5',
    });
    expect(await scheduled(fresh.id)).toBe(true);

    // The person sees one routine; the ended one's thread stays as it was.
    const rows = await listed();
    expect(rows.find((row) => row.id === created.id)).toBeUndefined();
    expect(rows.filter((row) => row.title === 'Weekday brief')).toHaveLength(1);
    expect(await scheduled(created.id)).toBe(false);
    expect((await required(jobs).get(created.conversation_id)).state).toBe('cancelled');
    expect((await request(`/automations/${created.id}/restart`, 'POST')).status).toBe(404);

    // The new routine runs like any other.
    await run(fresh.id, { kind: 'completed', summary: 'Back on.', evidence: [] });
    expect((await listed()).find((row) => row.id === fresh.id)?.runs[0]?.summary).toBe('Back on.');
    expect((await request(`/automations/${fresh.id}`, 'DELETE')).status).toBe(200);
  });

  test('a routine is told the open tasks, and a plan’s chat and steps are told the plan', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', freshAgent())).json(),
    ).agent;
    expect(
      (await request('/tasks', 'POST', { title: 'Renew the passport', due_at: null })).status,
    ).toBe(200);
    expect(
      (await request('/tasks', 'POST', { title: 'Already sorted', due_at: null, done: true }))
        .status,
    ).toBe(200);
    const routine = automationResponse.parse(
      await (
        await request('/automations/morning-brief', 'POST', { agent_id: persona.id, at: '07:30' })
      ).json(),
    ).automation;
    const objective = async (jobId: string) => {
      const row = await required(jobs).get(jobId);
      const bundle = await required(jobs).transaction((tx) =>
        buildAttemptSkeleton(
          tx,
          row,
          { id: newId('att'), epoch: row.leaseEpoch + 1, revision: row.revision, token: 'fixture' },
          { provider: 'stub', model: 'script', fallback: null },
          0,
        ),
      );
      return bundle.job.objective;
    };
    const brief = await objective(routine.conversation_id);
    expect(brief).toContain('- Renew the passport');
    expect(brief).not.toContain('Already sorted');

    const plan = experienceOperations['POST /plans'].response.parse(
      await (
        await request('/plans', 'POST', {
          title: 'Plan trip to Tahoe',
          category: 'Personal',
          milestones: [
            { title: 'Book the cabin', assignee: { kind: 'person' } },
            { title: 'Find a ski rental', assignee: { kind: 'agent', agent_id: persona.id } },
          ],
        })
      ).json(),
    );
    if (!('plan' in plan)) throw new Error('Expected a plan');
    const chat = conversationResponse.parse(
      await (
        await request(`/plans/${plan.plan.id}/conversation`, 'POST', { agent_id: persona.id })
      ).json(),
    ).conversation;
    const told = await objective(chat.id);
    expect(told).toContain('This belongs to the plan "Plan trip to Tahoe"');
    expect(told).toContain('- [not done] Book the cabin');
    expect(told).toContain('- [not done] Find a ski rental, assigned to an assistant');

    // What the assistant did for its step is shown on the plan.
    const [step] = await required(handle).sql<{ child_job_id: string }[]>`
      select child_job_id from plan_milestone where plan_id = ${plan.plan.id} and child_job_id is not null`;
    const child = await required(jobs).get(required(step).child_job_id);
    const claimed = required(
      await required(runner).claim({
        job_id: child.id,
        expected_epoch: child.leaseEpoch,
        expected_version: child.stateVersion,
        reason: 'created',
      }),
    );
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Tahoe Ski Rentals has boards for Friday.',
      evidence: [],
    });
    const shown = experienceOperations['GET /plans/{id}'].response.parse(
      await (await request(`/plans/${plan.plan.id}`)).json(),
    );
    if (!('plan' in shown)) throw new Error('Expected a plan');
    expect(shown.plan.milestones.map((item) => [item.done, item.output ?? null])).toEqual([
      [false, null],
      [true, 'Tahoe Ski Rentals has boards for Friday.'],
    ]);
  });
});
