import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  automationResponse,
  conversationResponse,
  dedupKey,
  experienceOperations,
  experienceQuestion,
  experienceSearch,
  homeResponse,
  memoryItemList,
  messageAcceptance,
  planResponse,
  taskResponse,
  turnList,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BudgetService } from '../../src/broker/budget.ts';
import { session } from '../../src/db/auth-schema.ts';
import { openDatabase } from '../../src/db/client.ts';
import {
  action,
  agent,
  artifact,
  connection,
  event,
  experienceTurn,
  job,
  owner,
  space,
  trigger,
} from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { BACKEND_VOCABULARY } from '../../src/experience/projectors.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { publishRevision } from '../../src/memory/claims.ts';
import { lockSpace, type MemoryScope, provisionMemorySpace } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { recordOutput } from '../../src/memory/outputs.ts';
import type { RestrictionJournal, RestrictionRecord } from '../../src/memory/restore.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const forgotten: RestrictionRecord[] = [];
const journal: RestrictionJournal = {
  read: async () => forgotten,
  append: async (record) => {
    forgotten.push(record);
  },
};
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'experience-fixture-signing-key-32-bytes',
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
      memory: { sql: handle.sql, journal },
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const foreignSpaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'experience@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db.insert(space).values([
    { id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` },
    { id: foreignSpaceId, name: 'Separate', gitPath: `/spaces/${foreignSpaceId}` },
  ]);
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600000),
  });
}
const withDb = handle ? describe : describe.skip;
async function request(path: string, method = 'GET', body?: unknown, key?: string) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function createConversation() {
  const response = await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent);
  expect(response.status).toBe(200);
  const persona = agentResponse.parse(await response.json()).agent;
  const created = await request('/conversations', 'POST', {
    title: 'Dinner',
    agent_id: persona.id,
  });
  expect(created.status).toBe(200);
  return conversationResponse.parse(await created.json()).conversation;
}

withDb('experience rows and authenticated scope', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);
  test('home uses the saved time zone and tasks; search excludes foreign rows', async () => {
    expect(
      (
        await request('/profile', 'PATCH', {
          name: 'Alex',
          time_zone: 'Asia/Kolkata',
          day_hours: { start: '00:00', end: '00:00' },
        })
      ).status,
    ).toBe(200);
    const task = taskResponse.parse(
      await (await request('/tasks', 'POST', { title: 'Dinner groceries', due_at: null })).json(),
    ).task;
    await required(handle)
      .sql`insert into task (id, space_id, title) values (${newId('task')}, ${foreignSpaceId}, 'Dinner private')`;
    const home = homeResponse.parse(await (await request('/home')).json());
    expect(home.time_zone).toBe('Asia/Kolkata');
    expect(home.greeting).toContain('Alex');
    expect(home.within_day_hours).toBe(true);
    expect(home.tasks.some((item) => item.id === task.id)).toBe(true);
    expect(home.upcoming).toMatchObject({ status: 'not_available' });
    const result = experienceSearch.parse(await (await request('/search?q=Dinner')).json());
    expect(result.results.some((item) => item.id === task.id && item.kind === 'task')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Dinner private');
    expect((await request(`/tasks/${task.id}`, 'DELETE')).status).toBe(200);
  });
  test('plans project real child completion and preserve context in a linked conversation', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
    ).agent;
    const saved = planResponse.parse(
      await (
        await request('/plans', 'POST', {
          title: 'Plan dinner',
          category: 'Personal',
          milestones: [
            { title: 'Choose menu', assignee: { kind: 'person' } },
            {
              title: 'Check availability',
              assignee: { kind: 'agent', agent_id: persona.id },
              schedule_at: new Date(Date.now() + 3600000).toISOString(),
            },
          ],
        })
      ).json(),
    ).plan;
    expect(saved.progress_percent).toBe(0);
    const changed = planResponse.parse(
      await (
        await request(
          `/plans/${saved.id}/milestones/${required(saved.milestones[0]).id}`,
          'PATCH',
          { done: true },
        )
      ).json(),
    ).plan;
    expect(changed.progress_percent).toBe(50);
    expect(changed.next_step).toBe('Check availability');
    const [child] = await required(handle)
      .sql`select j.* from job j join plan_milestone m on m.child_job_id = j.id where m.plan_id = ${saved.id}`;
    expect(child?.state).toBe('waiting_for_event_or_time');
    expect(new Date(child?.next_wake_at).getTime()).toBeGreaterThan(Date.now());
    const linked = conversationResponse.parse(
      await (
        await request(`/plans/${saved.id}/conversation`, 'POST', { agent_id: persona.id })
      ).json(),
    ).conversation;
    expect(linked.plan_id).toBe(saved.id);
    expect((await required(jobs).get(linked.id)).objective).toContain('Plan dinner');
    expect((await request(`/plans/${saved.id}/share`, 'POST')).status).toBe(200);
    await required(handle)
      .db.update(job)
      .set({ spaceId: foreignSpaceId })
      .where(eq(job.id, saved.id));
    expect((await request(`/plans/${saved.id}`)).status).toBe(404);
  });
  test('a scheduled routine completes twice with separate spending and attempt bounds', async () => {
    const persona = agentResponse.parse(
      await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
    ).agent;
    const routine = automationResponse.parse(
      await (
        await request('/automations', 'POST', {
          title: 'Daily dinner',
          instruction: 'Check today',
          weekdays: [1, 2, 3, 4, 5],
          at: '08:30',
          agent_id: persona.id,
        })
      ).json(),
    ).automation;
    expect(routine.schedule).toContain('Every weekday at 8:30 AM');
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const id = required(registration).jobId;
    await required(handle)
      .sql`update job set budget = jsonb_set(jsonb_set(budget, '{max_attempts}', '1'), '{max_output_tokens}', '10') where id = ${id}`;
    const turnIds = [];
    for (let index = 0; index < 2; index++) {
      expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
      const row = await required(jobs).get(id);
      turnIds.push(row.currentTurnId);
      const claimed = required(
        await required(runner).claim({
          job_id: id,
          expected_epoch: row.leaseEpoch,
          expected_version: row.stateVersion,
          reason: 'event',
        }),
      );
      await new BudgetService(required(handle).sql).reserve(claimed.claims, [
        { kind: 'tokens', amount: 10 },
      ]);
      await required(runner).commitOutcome(claimed.claims, {
        kind: 'completed',
        summary: 'Ready for today.',
        evidence: [],
      });
      expect((await required(jobs).get(id)).state).toBe('waiting_for_event_or_time');
    }
    expect(new Set(turnIds).size).toBe(2);
    const [runs] = await required(handle)
      .sql`select count(*)::int as n from attempt where job_id = ${id} and outcome = 'completed'`;
    expect(runs?.n).toBe(2);
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    const pending = await required(jobs).get(id);
    const claimed = required(
      await required(runner).claim({
        job_id: id,
        expected_epoch: pending.leaseEpoch,
        expected_version: pending.stateVersion,
        reason: 'event',
      }),
    );
    const connectionId = newId('conn');
    await required(handle)
      .db.insert(connection)
      .values({ id: connectionId, spaceId, label: 'Mail', provider: 'imap' });
    const actionId = newId('act');
    await required(handle)
      .db.insert(action)
      .values({
        id: actionId,
        jobId: id,
        attemptId: claimed.claims.attempt_id,
        connectionId,
        kind: 'email.send',
        effectClass: 'write_external',
        canonicalPayload: {},
        payloadHash: 'a'.repeat(64),
        idempotencyKey: actionId,
        status: 'unknown',
      });
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Unconfirmed.',
      evidence: [],
    });
    const list = experienceOperations['GET /automations'].response.parse(
      await (await request('/automations')).json(),
    );
    expect(list.automations.find((row) => row.id === routine.id)?.runs[0]?.status).toBe(
      'needs_you',
    );
  });
  test('creates a chat job and projects the agent without identities from the client', async () => {
    const chat = await createConversation();
    expect(chat.status).toBe('idle');
    const [row] = await required(handle).db.select().from(job).where(eq(job.id, chat.id));
    expect(row?.kind).toBe('chat');
    expect(row?.spaceId).toBe(spaceId);
    expect(row?.nextWakeAt).toBeNull();
    expect(
      (
        await request('/conversations', 'POST', {
          title: 'Bad',
          agent_id: chat.agent_id,
          space_id: foreignSpaceId,
        })
      ).status,
    ).toBe(400);
    await required(handle)
      .db.update(agent)
      .set({ spaceId: foreignSpaceId })
      .where(eq(agent.id, chat.agent_id));
    expect(
      (await request('/conversations', 'POST', { title: 'Bad', agent_id: chat.agent_id })).status,
    ).toBe(404);
    expect((await request('/conversations', 'GET')).status).toBe(200);
  });
  test('submissions persist exactly one turn, finish and accept the next message', async () => {
    const chat = await createConversation();
    const first = messageAcceptance.parse(
      await (
        await request(
          `/conversations/${chat.id}/messages`,
          'POST',
          { text: 'Find dinner' },
          'message-one',
        )
      ).json(),
    );
    const repeated = messageAcceptance.parse(
      await (
        await request(
          `/conversations/${chat.id}/messages`,
          'POST',
          { text: 'Find dinner' },
          'message-one',
        )
      ).json(),
    );
    expect(repeated).toEqual(first);
    const row = await required(jobs).get(chat.id);
    const claimed = await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    });
    expect(claimed).not.toBeNull();
    expect(required(claimed).bundle.identity).toContain('Nova');
    await required(runner).commitOutcome(required(claimed).claims, {
      kind: 'completed',
      summary: 'Dinner is ready.',
      evidence: [],
    });
    const messages = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(messages.turns).toHaveLength(1);
    expect(messages.turns[0]?.answer).toBe('Dinner is ready.');
    expect(messages.turns[0]?.status).toBe('done');
    expect(
      (
        await request(
          `/conversations/${chat.id}/messages`,
          'POST',
          { text: 'What about tomorrow?' },
          'message-two',
        )
      ).status,
    ).toBe(200);
  });
  test('quick answers persist the offered choices and reject invented option ids', async () => {
    const chat = await createConversation();
    await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Find dinner' });
    const row = await required(jobs).get(chat.id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    await required(runner).commitOutcome(claimed.claims, {
      outcome: { kind: 'waiting_for_input', question: 'Eat out or cook?' },
      questions: [
        {
          text: 'Eat out or cook?',
          because: [`attempt:${claimed.claims.attempt_id}`],
          if_ignored: 'I will wait.',
          options: [
            { id: 'cook', label: 'Cook at home' },
            { id: 'out', label: 'Eat out' },
          ],
        },
      ],
    });
    const body = (await (await request('/quick-answers')).json()) as { questions: unknown[] };
    const question = required(
      body.questions
        .map((value) => experienceQuestion.parse(value))
        .find((item) => item.conversation_id === chat.id),
    );
    expect(question.options).toHaveLength(2);
    expect(question.why).toEqual(['For Dinner.']);
    expect(
      (await request(`/quick-answers/${question.id}`, 'POST', { option_id: 'invented' })).status,
    ).toBe(400);
    expect(
      (await request(`/quick-answers/${question.id}`, 'POST', { option_id: 'cook' })).status,
    ).toBe(200);
    expect(
      (await request(`/quick-answers/${question.id}`, 'POST', { option_id: 'cook' })).status,
    ).toBe(200);
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.filter((turn) => turn.text === 'Cook at home')).toHaveLength(1);
  });
  test('saved details use plain keys, correction history, dependency explanations and durable forgetting', async () => {
    const sql = required(handle).sql;
    const scope: MemoryScope = {
      ownerId,
      spaceId,
      publisher: 'experience',
      audience: 'private',
      role: 'owner',
    };
    await provisionMemorySpace(sql, ownerId, spaceId);
    await sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
    const source = await ingest(sql, scope, {
      stream: 'onboarding',
      source_identity: 'diet',
      source_version: '1',
      source_type: 'message',
      author: 'owner',
      event_at: new Date().toISOString(),
      text: 'I prefer vegetarian meals.',
    });
    const first = await sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      return publishRevision(tx, scope, 'pref.food.diet', null, {
        key: 'pref.food.diet',
        content: 'Vegetarian',
        kind: 'preference',
        factual_status: 'attributed',
        protected: false,
        valid_from: new Date().toISOString(),
        valid_until: null,
        sources: [{ source_id: source.source.source_id, source_version: '1', start: 0, end: 26 }],
      });
    });
    const chat = await createConversation();
    await recordOutput(sql, scope, {
      job_id: chat.id,
      kind: 'plan_step',
      output_id: 'dinner-choice',
      output_version: '1',
      uses: [`${first.claim_id}@${first.revision}`],
    });
    const before = memoryItemList.parse(await (await request('/memory/items')).json());
    const item = required(before.items.find((value) => value.id === first.claim_id));
    expect(item).toMatchObject({
      key: 'food: diet',
      value: 'Vegetarian',
      source: 'onboarding',
      editable: true,
    });
    expect(item.last_used).not.toBeNull();
    const why = await (await request(`/memory/items/${item.id}/why`)).json();
    expect(why).toMatchObject({ reasons: ['food: diet: Vegetarian'], output: 'Used for Dinner.' });
    expect(JSON.stringify(why)).not.toContain(first.claim_id);
    const edited = await request(`/memory/items/${item.id}`, 'PATCH', {
      value: 'Vegan',
      version: item.version,
    });
    expect(edited.status).toBe(200);
    expect(
      (
        await request(`/memory/items/${item.id}`, 'PATCH', {
          value: 'Old choice',
          version: item.version,
        })
      ).status,
    ).toBe(409);
    expect(
      memoryItemList
        .parse(await (await request('/memory/items')).json())
        .items.find((value) => value.id === item.id)?.value,
    ).toBe('Vegan');
    const revisions = await sql`select revision from memory_revisions where claim_id = ${item.id}`;
    expect(revisions).toHaveLength(2);
    expect((await request(`/memory/items/${item.id}`, 'DELETE')).status).toBe(200);
    expect(memoryItemList.parse(await (await request('/memory/items')).json()).items).toEqual([]);
    expect(forgotten.some((record) => record.claim_ids.includes(item.id))).toBe(true);
  });
  test('stopping fences further text and retains the partial answer', async () => {
    const chat = await createConversation();
    await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Help me plan' });
    const row = await required(jobs).get(chat.id);
    const claimed = await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    });
    const claims = required(claimed).claims;
    await required(runner).emit(claims, {
      type: 'text_delta',
      text: 'Here is the first part.',
      attempt_id: claims.attempt_id,
      local_seq: 0,
      dedup_key: dedupKey(claims.attempt_id, 0),
      at: new Date().toISOString(),
    });
    const stopped = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}/stop`, 'POST')).json(),
    );
    expect(stopped.conversation.status).toBe('stopped');
    const [turn] = await required(handle)
      .db.select()
      .from(experienceTurn)
      .where(eq(experienceTurn.id, row.currentTurnId ?? ''));
    expect(turn?.answer).toBe('Here is the first part.');
    let rejected = false;
    try {
      await required(runner).emit(claims, {
        type: 'text_delta',
        text: 'Late text',
        attempt_id: claims.attempt_id,
        local_seq: 1,
        dedup_key: dedupKey(claims.attempt_id, 1),
        at: new Date().toISOString(),
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
  test('a queued pause prevents claim and resume claims the same turn once', async () => {
    const chat = await createConversation();
    const accepted = messageAcceptance.parse(
      await (
        await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Plan dinner' })
      ).json(),
    );
    expect((await request(`/conversations/${chat.id}/pause`, 'POST')).status).toBe(200);
    const row = await required(jobs).get(chat.id);
    const wake = {
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input' as const,
    };
    expect(await required(runner).claim(wake)).toBeNull();
    await request(`/conversations/${chat.id}/resume`, 'POST');
    expect(await required(runner).claim(wake)).not.toBeNull();
    const messages = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(messages.turns.map((turn) => turn.id)).toEqual([accepted.turn_id]);
  });
  test('retrying pause and resume appends one notice per turn and action', async () => {
    const chat = await createConversation();
    const accepted = messageAcceptance.parse(
      await (
        await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Plan dinner' })
      ).json(),
    );
    for (const action of ['pause', 'pause', 'resume', 'resume'])
      expect((await request(`/conversations/${chat.id}/${action}`, 'POST')).status).toBe(200);
    const rows = await required(handle).sql`select payload from event where job_id = ${chat.id}
      and payload->>'kind' in ('experience_paused', 'experience_resumed') order by seq`;
    expect(rows.map((row) => row.payload)).toEqual([
      { kind: 'experience_paused', turn_id: accepted.turn_id },
      { kind: 'experience_resumed', turn_id: accepted.turn_id },
    ]);
  });
  test('an unconfirmed change cannot produce a completed turn or done trail step', async () => {
    const chat = await createConversation();
    await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Prepare dinner' });
    const row = await required(jobs).get(chat.id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    const connectionId = newId('conn');
    await required(handle)
      .db.insert(connection)
      .values({ id: connectionId, spaceId, label: 'Mail', provider: 'imap' });
    const actionId = newId('act');
    await required(handle)
      .db.insert(action)
      .values({
        id: actionId,
        jobId: chat.id,
        attemptId: claimed.claims.attempt_id,
        connectionId,
        kind: 'email.send',
        effectClass: 'write_external',
        canonicalPayload: {},
        payloadHash: 'a'.repeat(64),
        idempotencyKey: actionId,
        status: 'unknown',
      });
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'All ready.',
      evidence: [],
    });
    const view = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}`)).json(),
    );
    expect(view.conversation.status).toBe('needs_you');
    const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    expect(page.events.some((event) => event.item.type === 'done')).toBe(false);
  });
  test('space event sync skips locked idle conversations and explicit sync retains history', async () => {
    const idle = await createConversation();
    const recent = await createConversation();
    const fixture = required(handle);
    await fixture.sql`update job set updated_at = now() - interval '2 days' where id = ${idle.id}`;
    for (const chat of [idle, recent])
      await fixture.db.insert(event).values({
        jobId: chat.id,
        type: 'notice',
        payload: {
          kind: 'experience_say',
          text: chat.id === idle.id ? 'Saved history.' : 'Working now.',
        },
        dedupKey: `${chat.id}:fixture-say`,
        createdAt: new Date(Date.now() - (chat.id === idle.id ? 2 * 86400000 : 0)),
      });
    const reader = openDatabase(fixture.url, 1);
    try {
      await reader.sql`set lock_timeout = '250ms'`;
      const projection = new ExperienceEvents(reader.db);
      await fixture.sql.begin(async (tx) => {
        await tx`select id from job where id = ${idle.id} for update`;
        const page = await projection.page(spaceId, 0);
        expect(
          page.events.some(
            (item) => item.conversation_id === recent.id && item.item.type === 'say',
          ),
        ).toBe(true);
        expect(page.events.some((item) => item.conversation_id === idle.id)).toBe(false);
      });
      const history = await projection.page(spaceId, 0, idle.id);
      expect(
        history.events.some(
          (item) => item.item.type === 'say' && item.item.text === 'Saved history.',
        ),
      ).toBe(true);
    } finally {
      await reader.close();
    }
  });
  test('real ledger rows yield one grouped trail action and stable resumable safe events', async () => {
    const chat = await createConversation();
    await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Check dinner plans' });
    const row = await required(jobs).get(chat.id);
    const claimed = await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    });
    const calendarId = newId('conn');
    const mailId = newId('conn');
    await required(handle)
      .db.insert(connection)
      .values([
        { id: calendarId, spaceId, label: 'Calendar', provider: 'caldav' },
        { id: mailId, spaceId, label: 'Mail', provider: 'imap' },
      ]);
    for (const [index, kind] of ['calendar.list', 'email.search', 'email.read'].entries()) {
      const actionId = newId('act');
      const detail =
        index === 0
          ? { events: [{ summary: 'Dinner' }] }
          : index === 1
            ? { messages: [{ subject: 'Invite' }] }
            : { message: { subject: 'Menu' } };
      await required(handle)
        .db.insert(action)
        .values({
          id: actionId,
          jobId: chat.id,
          attemptId: required(claimed).claims.attempt_id,
          connectionId: index === 0 ? calendarId : mailId,
          kind,
          effectClass: 'read',
          canonicalPayload: { private: 'must stay inside' },
          payloadHash: 'a'.repeat(64),
          idempotencyKey: actionId,
          status: 'succeeded',
          receipt: { detail },
          resolvedAt: new Date(),
        });
      await required(handle)
        .db.insert(event)
        .values({
          jobId: chat.id,
          attemptId: required(claimed).claims.attempt_id,
          type: 'action_requested',
          payload: { action_id: actionId, kind },
          dedupKey: `fixture:${actionId}`,
        });
    }
    await required(runner).commitOutcome(required(claimed).claims, {
      kind: 'completed',
      summary: 'Your evening is clear.',
      evidence: [],
    });
    const projection = new ExperienceEvents(required(handle).db);
    const page = await projection.page(spaceId, 0, chat.id);
    expect(page.events.filter((item) => item.item.type === 'action')).toHaveLength(1);
    const step = page.events.find((item) => item.item.type === 'action')?.item;
    if (step?.type !== 'action') throw new Error('Missing action');
    expect(step.sources.map((source) => source.connection_id)).toEqual([
      calendarId,
      mailId,
      mailId,
    ]);
    expect(JSON.stringify(page)).not.toMatch(BACKEND_VOCABULARY);
    expect(JSON.stringify(page)).not.toContain('must stay inside');
    expect((await projection.page(spaceId, page.next_cursor, chat.id)).events).toEqual([]);
    expect((await projection.page(foreignSpaceId, 0, chat.id)).events).toEqual([]);
    const response = await request(`/conversations/${chat.id}/events?since=0`);
    expect(response.status).toBe(200);
  });
  test('cards project real calendar, draft, file, page and artifact records with safe attribution', async () => {
    const chat = await createConversation();
    await request(`/conversations/${chat.id}/messages`, 'POST', { text: 'Gather dinner details' });
    const row = await required(jobs).get(chat.id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    const entries = [
      {
        provider: 'caldav',
        kind: 'calendar.list',
        payload: {},
        detail: {
          events: [
            {
              uid: 'dinner-event',
              summary: 'Dinner event',
              start: '2026-09-12T19:00:00Z',
              end: '2026-09-12T20:00:00Z',
              location: 'Home',
            },
          ],
        },
      },
      {
        provider: 'imap',
        kind: 'email.draft',
        payload: { to: 'alex@example.test', subject: 'Dinner invitation', body: 'At seven?' },
        detail: {},
      },
      {
        provider: 'files',
        kind: 'files.read',
        payload: { path: 'artifacts/menu.txt' },
        detail: { path: 'artifacts/menu.txt', content: 'private details stay inside' },
      },
      {
        provider: 'web',
        kind: 'web.fetch',
        payload: {},
        detail: {
          final_url: 'https://example.test/menu?access_token=private',
          body: '<title>Dinner menu</title><p>private details stay inside</p>',
        },
      },
    ];
    const ids: string[] = [];
    for (const entry of entries) {
      const connectionId = newId('conn');
      ids.push(connectionId);
      await required(handle)
        .db.insert(connection)
        .values({ id: connectionId, spaceId, label: 'Connected app', provider: entry.provider });
      const id = newId('act');
      await required(handle)
        .db.insert(action)
        .values({
          id,
          jobId: chat.id,
          attemptId: claimed.claims.attempt_id,
          connectionId,
          kind: entry.kind,
          effectClass: entry.kind === 'email.draft' ? 'write_reversible' : 'read',
          canonicalPayload: entry.payload,
          payloadHash: 'a'.repeat(64),
          idempotencyKey: id,
          status: 'succeeded',
          receipt: { detail: entry.detail },
          resolvedAt: new Date(),
        });
      await required(handle)
        .db.insert(event)
        .values({
          jobId: chat.id,
          attemptId: claimed.claims.attempt_id,
          type: 'action_status_changed',
          payload: { action_id: id, to: 'succeeded' },
          dedupKey: `card-fixture:${id}`,
        });
    }
    await required(handle)
      .db.insert(artifact)
      .values([
        {
          id: newId('art'),
          spaceId,
          jobId: chat.id,
          path: 'artifacts/dinner-notes.txt',
          contentHash: 'a'.repeat(64),
          mime: 'text/plain',
          size: 15,
        },
        {
          id: newId('art'),
          spaceId: foreignSpaceId,
          jobId: chat.id,
          path: 'foreign-secret.txt',
          contentHash: 'b'.repeat(64),
          mime: 'text/plain',
          size: 20,
        },
      ]);
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Dinner details are ready.',
      evidence: [],
    });
    const result = experienceOperations['GET /conversations/{id}/cards'].response.parse(
      await (await request(`/conversations/${chat.id}/cards`)).json(),
    );
    expect(result.cards).toHaveLength(5);
    expect(result.cards.map((card) => card.title).sort()).toEqual(
      ['Dinner event', 'Dinner invitation', 'Dinner menu', 'dinner-notes.txt', 'menu.txt'].sort(),
    );
    expect(
      result.cards.find((card) => card.title === 'Dinner event')?.facts.map((fact) => fact.label),
    ).toEqual(['Starts', 'Ends', 'Place']);
    expect(result.cards.find((card) => card.title === 'Dinner invitation')?.facts).toEqual([
      { label: 'To', value: 'alex@example.test' },
    ]);
    // Credential-bearing source addresses never become clickable links.
    expect(result.cards.find((card) => card.title === 'Dinner menu')?.primary_action).toBeNull();
    expect(
      result.cards
        .filter((card) => card.source_connection)
        .map((card) => card.source_connection)
        .sort(),
    ).toEqual(ids.sort());
    expect(JSON.stringify(result)).not.toMatch(BACKEND_VOCABULARY);
    expect(JSON.stringify(result)).not.toContain('private details stay inside');
    expect(JSON.stringify(result)).not.toContain('foreign-secret');
    const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    expect(page.events.filter((event) => event.item.type === 'card')).toHaveLength(5);
    expect(JSON.stringify(page)).not.toMatch(BACKEND_VOCABULARY);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
