/**
 * A call against a fake ElevenLabs, through the real service: what is said
 * becomes the conversation's message, the agent's tool work shows in the chat
 * as it does for a typed turn, the answer is spoken back, and hanging up
 * leaves the work running.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { agentResponse, callSession, conversationResponse } from '@melete/contracts';
import type { ServerWebSocket } from 'bun';
import type { Upstream } from '../../src/call/service.ts';
import type { UpstreamReply } from '../../src/connectors/speech-engine.ts';
import { session } from '../../src/db/auth-schema.ts';
import { event, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { callServiceOf, createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'call-test-signing-key-32-bytes!!' })
  : null;

/** ElevenLabs' side, faked: each started call gets the next id. */
let started = 0;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
      callVoice: {
        async start() {
          started += 1;
          return {
            token: `call-token-${started}`,
            conversationId: `conv_test_${started}`,
            expiresAt: new Date(Date.now() + 60_000),
          };
        },
        verify: () => true,
      },
      callTiming: { pollMs: 20, fillerMs: 60_000, stillMs: 60_000, holdMs: 60_000 },
    })
  : null;

const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'call@example.test' });
  await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner where id = ${ownerId}`;
  await handle.db
    .insert(space)
    .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
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
async function request(path: string, init: RequestInit = {}) {
  return required(app).request(path, {
    ...init,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function newConversation() {
  const persona = agentResponse.parse(
    await (await request('/agents', { method: 'POST', body: JSON.stringify(freshAgent()) })).json(),
  ).agent;
  return conversationResponse.parse(
    await (
      await request('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Weather', agent_id: persona.id }),
      })
    ).json(),
  ).conversation;
}

/** The upstream WebSocket from ElevenLabs, faked: what the service sent back, and whether it hung up. */
function upstream() {
  const sent: UpstreamReply[] = [];
  let closed = false;
  const socket = {
    data: {} as Upstream,
    send: (text: string) => sent.push(JSON.parse(text)),
    close: () => {
      closed = true;
    },
  } as unknown as ServerWebSocket<Upstream>;
  const calls = required(callServiceOf(required(app)));
  return {
    sent,
    get closed() {
      return closed;
    },
    open: () => calls.websocket.open?.(socket),
    say: (message: unknown) => calls.websocket.message(socket, JSON.stringify(message)),
    hangUp: () => calls.websocket.close?.(socket, 1000, 'bye'),
    spoken: (eventId: number) =>
      sent.flatMap((reply) =>
        reply.type === 'agent_response' && reply.event_id === eventId && reply.content
          ? [reply.content]
          : [],
      ),
    finished: (eventId: number) =>
      sent.some(
        (reply) => reply.type === 'agent_response' && reply.event_id === eventId && reply.is_final,
      ),
  };
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 300; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function claimTurn(conversationId: string) {
  const row = await required(jobs).get(conversationId);
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  ).claims;
}

const turnStatus = async (conversationId: string) => {
  const [row] = await required(handle).sql<{ status: string }[]>`
    select t.status from job j join experience_turn t on t.id = j.current_turn_id
    where j.id = ${conversationId}`;
  return row?.status ?? null;
};

/** The person's words of each turn in the conversation, as the chat shows them. */
const turnTexts = async (conversationId: string) =>
  (
    await required(handle).sql<{ text: string }[]>`
      select text from experience_turn where job_id = ${conversationId} order by created_at`
  ).map((row) => row.text);

withDb('a call in a conversation', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('what is said lands in the chat, the tool row with it, and the answer is spoken', async () => {
    const chat = await newConversation();
    const response = await request(`/conversations/${chat.id}/call`, { method: 'POST' });
    expect(response.status).toBe(201);
    const call = callSession.parse(await response.json());
    expect(call.token).toBe(`call-token-${started}`);
    expect(Date.parse(call.expires_at) - Date.now()).toBeLessThanOrEqual(2 * 60_000);

    const line = upstream();
    line.open();
    await line.say({ type: 'init', conversation_id: `conv_test_${started}` });
    await line.say({
      type: 'user_transcript',
      event_id: 1,
      user_transcript: [{ role: 'user', content: 'What is the weather in Lisbon?' }],
    });
    expect(line.closed).toBe(false);

    // The words are the conversation's message, as a typed one would be.
    const projection = new ExperienceEvents(required(handle).db);
    await until(
      async () => (await turnTexts(chat.id)).includes('What is the weather in Lisbon?'),
      'the message in the chat',
    );

    // The agent works: a web search, then its answer.
    const claims = await claimTurn(chat.id);
    await required(handle)
      .db.insert(event)
      .values({
        jobId: chat.id,
        attemptId: claims.attempt_id,
        type: 'tool_call_proposed',
        payload: { tool: 'web_search', call_id: 'c1', arguments: { preview: 'Lisbon weather' } },
        dedupKey: `call-fixture:${randomBytes(8).toString('hex')}`,
      });
    await required(handle)
      .db.insert(event)
      .values({
        jobId: chat.id,
        attemptId: claims.attempt_id,
        type: 'tool_result',
        payload: { call_id: 'c1', ok: true, result: {} },
        dedupKey: `call-fixture:${randomBytes(8).toString('hex')}`,
      });
    await required(runner).commitOutcome(claims, {
      kind: 'completed',
      summary: 'It is sunny in Lisbon, about 24 degrees.',
      evidence: [],
    });

    await until(() => line.finished(1), 'the spoken answer');
    expect(line.spoken(1).join(' ')).toContain('It is sunny in Lisbon');
    const page = await projection.page(spaceId, 0, chat.id, 200);
    const toolRows = page.events.flatMap((item) =>
      item.item.type === 'tool' ? [item.item.tool] : [],
    );
    expect(
      toolRows.some((tool) => tool.id === 'c1' || tool.title.toLowerCase().includes('search')),
    ).toBe(true);
    line.hangUp();
  }, 30000);

  test('hanging up mid-work leaves the work running', async () => {
    const chat = await newConversation();
    await request(`/conversations/${chat.id}/call`, { method: 'POST' });
    const line = upstream();
    line.open();
    await line.say({ type: 'init', conversation_id: `conv_test_${started}` });
    await line.say({
      type: 'user_transcript',
      event_id: 1,
      user_transcript: [{ role: 'user', content: 'Research the best e-bikes for hills' }],
    });
    await until(async () => (await turnStatus(chat.id)) !== null, 'the turn');
    line.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(['queued', 'working', 'streaming']).toContain(required(await turnStatus(chat.id)));
    // The work goes on to its end after the call, and its answer stays in the chat.
    const claims = await claimTurn(chat.id);
    await required(runner).commitOutcome(claims, {
      kind: 'completed',
      summary: 'Three e-bikes stand out.',
      evidence: [],
    });
    await until(async () => (await turnStatus(chat.id)) === 'done', 'the finished turn');
    expect(line.finished(1)).toBe(false);
  }, 30000);

  test('a call started for one conversation cannot be used twice', async () => {
    const chat = await newConversation();
    await request(`/conversations/${chat.id}/call`, { method: 'POST' });
    const first = upstream();
    first.open();
    await first.say({ type: 'init', conversation_id: `conv_test_${started}` });
    const second = upstream();
    second.open();
    await second.say({ type: 'init', conversation_id: `conv_test_${started}` });
    await until(() => second.closed, 'the second line refused');
    expect(first.closed).toBe(false);
    first.hangUp();
  }, 30000);
});
