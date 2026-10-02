/**
 * The agent asks the person a question through the broker and the job waits
 * for the answer: in a chat, in a responsibility and in a routine, which keeps
 * its schedule while the question waits. The answer, picked or typed, comes
 * back as the person's next message; a stop, a cancel or a delete withdraws it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  automationResponse,
  type CapabilityClaims,
  conversationResponse,
  experienceOperations,
} from '@melete/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { requestPersonQuestion } from '../../src/broker/ask-person.ts';
import { requestRuntimeWait } from '../../src/broker/runtime-wait.ts';
import { session } from '../../src/db/auth-schema.ts';
import { event, experienceTurn, owner, question, space, trigger } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'ask-person-fixture-signing-key-32-bytes',
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'ask@example.test' });
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
const sql = () => required(handle).sql;
const quickAnswers = async () =>
  experienceOperations['GET /quick-answers'].response.parse(
    await (await request('/quick-answers')).json(),
  ).questions;

let persona: string | undefined;
async function agentId() {
  persona ??= agentResponse.parse(
    await (await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent)).json(),
  ).agent.id;
  return persona;
}

/** A chat whose first turn is claimed and running. */
async function chatTurn(text = 'Book us a table') {
  const created = await request('/conversations', 'POST', {
    title: 'Dinner',
    agent_id: await agentId(),
  });
  const chat = conversationResponse.parse(await created.json()).conversation;
  expect((await request(`/conversations/${chat.id}/messages`, 'POST', { text })).status).toBe(200);
  return { id: chat.id, claims: await claim(chat.id, 'input') };
}

async function claim(jobId: string, reason: 'input' | 'event') {
  const row = await required(jobs).get(jobId);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason,
    }),
  );
  return claimed;
}

const ask = (claims: CapabilityClaims, input: unknown) =>
  requestPersonQuestion(sql(), claims, input);

/** The person's latest message on the job, as the next attempt reads it. */
const latestMessage = async (jobId: string) => {
  const rows = await required(handle)
    .db.select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.jobId, jobId), eq(event.type, 'notice')))
    .orderBy(desc(event.seq));
  return rows
    .map((entry) => entry.payload as { kind?: string; text?: string })
    .find((payload) => payload.kind === 'user_message')?.text;
};

const questionsOf = (jobId: string) =>
  required(handle).db.select().from(question).where(eq(question.jobId, jobId));

withDb('the agent asks the person and waits for the answer', () => {
  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a chat waits for input, shows the choices, and resumes with the chosen answer', async () => {
    const { id, claims } = await chatTurn();
    const asked = await ask(claims.claims, {
      question: 'Which night suits you?',
      choices: ['Tuesday', 'Thursday'],
      why: 'Both places have a table only on those nights.',
    });
    expect(asked).toMatchObject({
      status: 'waiting_for_input',
      question: 'Which night suits you?',
    });
    await required(runner).commitOutcome(claims.claims, {
      kind: 'completed',
      summary: 'I found two places.',
      evidence: [],
    });
    const waiting = await required(jobs).get(id);
    expect(waiting.state).toBe('waiting_for_input');
    expect(waiting.wait).toEqual({ kind: 'user_input', question: 'Which night suits you?' });
    // The turn keeps its words and says it needs the person.
    const [turn] = await required(handle)
      .db.select()
      .from(experienceTurn)
      .where(eq(experienceTurn.jobId, id));
    expect(turn).toMatchObject({ status: 'needs_you', answer: 'I found two places.' });

    const card = required((await quickAnswers()).find((entry) => entry.conversation_id === id));
    expect(card).toMatchObject({
      text: 'Which night suits you?',
      free_text: true,
      options: [
        { id: 'choice_1', label: 'Tuesday' },
        { id: 'choice_2', label: 'Thursday' },
      ],
    });
    expect(card.why[0]).toBe('Both places have a table only on those nights.');

    const answered = await request(`/quick-answers/${card.id}`, 'POST', { option_id: 'choice_2' });
    expect(answered.status).toBe(200);
    expect((await required(jobs).get(id)).state).toBe('queued');
    expect(await latestMessage(id)).toBe('Thursday');
    const [closed] = await questionsOf(id);
    expect(closed).toMatchObject({ state: 'answered', answer: 'Thursday' });
    // The next attempt reads the answer as the person's new message.
    const next = await claim(id, 'input');
    expect(next.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Thursday',
    ]);
  });

  test('an answer in the person’s own words is accepted; an unknown choice is not', async () => {
    const { id, claims } = await chatTurn('Plan the weekend');
    await ask(claims.claims, { question: 'Anywhere you would rather avoid?' });
    await required(runner).commitOutcome(claims.claims, {
      kind: 'completed',
      summary: '',
      evidence: [],
    });
    const card = required((await quickAnswers()).find((entry) => entry.conversation_id === id));
    expect(card.options).toEqual([]);
    expect(
      (await request(`/quick-answers/${card.id}`, 'POST', { option_id: 'choice_1' })).status,
    ).toBe(400);
    expect(
      (await request(`/quick-answers/${card.id}`, 'POST', { text: 'Nothing too far north' }))
        .status,
    ).toBe(200);
    expect(await latestMessage(id)).toBe('Nothing too far north');
    expect((await required(jobs).get(id)).state).toBe('queued');
  });

  test('one question per turn, none while one waits, and no wait set beside it', async () => {
    const { claims } = await chatTurn('Find a gift');
    await ask(claims.claims, { question: 'What budget?', choices: ['Under $50', 'Under $100'] });
    // The same call again is the same question; a different one is refused.
    await ask(claims.claims, { question: 'What budget?', choices: ['Under $50', 'Under $100'] });
    expect((await rejectionOf(ask(claims.claims, { question: 'For whom?' }))).code).toBe(
      'payload_invalid',
    );
    expect(
      (
        await rejectionOf(
          requestRuntimeWait(sql(), claims.claims, {
            kind: 'timer',
            wake_at: new Date(Date.now() + 3600_000).toISOString(),
          }),
        )
      ).code,
    ).toBeDefined();
    // Too many choices is refused before anything is written.
    expect(
      (
        await rejectionOf(
          ask(claims.claims, { question: 'Which?', choices: ['a', 'b', 'c', 'd', 'e'] }),
        )
      ).code,
    ).toBe('payload_invalid');
  });

  test('stopping the conversation withdraws its question', async () => {
    const { id, claims } = await chatTurn('Compare two flights');
    await ask(claims.claims, { question: 'Aisle or window?', choices: ['Aisle', 'Window'] });
    await required(runner).commitOutcome(claims.claims, {
      kind: 'completed',
      summary: '',
      evidence: [],
    });
    expect((await quickAnswers()).some((entry) => entry.conversation_id === id)).toBe(true);
    expect((await request(`/conversations/${id}/stop`, 'POST')).status).toBe(200);
    const [withdrawn] = await questionsOf(id);
    expect(withdrawn?.state).toBe('withdrawn');
    expect((await quickAnswers()).some((entry) => entry.conversation_id === id)).toBe(false);
    expect(
      (await request(`/quick-answers/${required(withdrawn).id}`, 'POST', { text: 'Aisle' })).status,
    ).toBe(409);
  });

  test('deleting the conversation takes its question with it', async () => {
    const { id, claims } = await chatTurn('Pick a restaurant');
    await ask(claims.claims, { question: 'Italian or Thai?', choices: ['Italian', 'Thai'] });
    await required(runner).commitOutcome(claims.claims, {
      kind: 'completed',
      summary: '',
      evidence: [],
    });
    const card = required((await quickAnswers()).find((entry) => entry.conversation_id === id));
    expect((await request(`/conversations/${id}`, 'DELETE')).status).toBe(200);
    expect((await quickAnswers()).some((entry) => entry.id === card.id)).toBe(false);
    expect(await questionsOf(id)).toEqual([]);
  });

  test('a cancelled responsibility withdraws its open question', async () => {
    const row = await required(jobs).create({
      space_id: spaceId,
      title: 'Renew the passport',
      objective: 'Renew the passport before the trip',
    });
    const claimed = await claim(row.id, 'input');
    await ask(claimed.claims, {
      question: 'Standard or expedited service?',
      choices: ['Standard', 'Expedited'],
    });
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'The form is filled in.',
      evidence: [],
    });
    expect((await required(jobs).get(row.id)).state).toBe('waiting_for_input');
    const [open] = await questionsOf(row.id);
    expect(open?.state).toBe('open');
    expect(open?.options.map((option) => option.label)).toEqual(['Standard', 'Expedited']);
    await required(jobs).cancel(row.id);
    const [after] = await questionsOf(row.id);
    expect(after?.state).toBe('withdrawn');
    const [closed] = await required(handle)
      .db.select({ payload: event.payload })
      .from(event)
      .where(eq(event.dedupKey, `${required(open).id}:closed`));
    expect(closed?.payload).toMatchObject({ kind: 'question_closed', state: 'withdrawn' });
  });

  test('a routine rests on its schedule while its question waits, and the answer wakes it', async () => {
    const routine = automationResponse.parse(
      await (
        await request('/automations/morning-brief', 'POST', {
          agent_id: await agentId(),
          at: '08:30',
        })
      ).json(),
    ).automation;
    expect((await request(`/automations/${routine.id}/test`, 'POST')).status).toBe(200);
    const [registration] = await required(handle)
      .db.select()
      .from(trigger)
      .where(eq(trigger.id, routine.id));
    const jobId = required(registration).jobId;
    const claimed = await claim(jobId, 'event');
    await ask(claimed.claims, {
      question: 'Include the team calendar?',
      choices: ['Yes', 'No'],
    });
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'completed',
      summary: 'Two meetings today.',
      evidence: [],
    });
    const resting = await required(jobs).get(jobId);
    // Not waiting for input: the schedule still fires the next run.
    expect(resting.state).toBe('waiting_for_event_or_time');
    expect(resting.wait).toEqual({
      kind: 'event',
      trigger_id: routine.id,
      deadline_at: null,
    });
    const card = required((await quickAnswers()).find((entry) => entry.conversation_id === jobId));
    expect(card.text).toBe('Include the team calendar?');
    // The routine thread takes no message, but its question takes an answer.
    expect(
      (await request(`/quick-answers/${card.id}`, 'POST', { text: 'Yes, from now on' })).status,
    ).toBe(200);
    const woken = await required(jobs).get(jobId);
    expect(woken.state).toBe('queued');
    expect(await latestMessage(jobId)).toBe('Yes, from now on');
    const [answered] = await questionsOf(jobId);
    expect(answered).toMatchObject({ state: 'answered', answer: 'Yes, from now on' });
    // The run it starts is a turn of its own in the routine's thread.
    const [turn] = await required(handle)
      .db.select()
      .from(experienceTurn)
      .where(eq(experienceTurn.id, required(woken.currentTurnId)));
    expect(turn?.text).toBe('Yes, from now on');
    const next = await claim(jobId, 'input');
    expect(next.bundle.inputs.new_user_messages.map((message) => message.content)).toContain(
      'Yes, from now on',
    );
    await required(runner).commitOutcome(next.claims, {
      kind: 'completed',
      summary: 'Added the team calendar.',
      evidence: [],
    });
    const rested = await required(jobs).get(jobId);
    expect(rested.state).toBe('waiting_for_event_or_time');
    // A resent answer is the same answer, not a second wake.
    expect(
      (await request(`/quick-answers/${card.id}`, 'POST', { text: 'Yes, from now on' })).status,
    ).toBe(200);
    expect((await required(jobs).get(jobId)).stateVersion).toBe(rested.stateVersion);
  });
});
