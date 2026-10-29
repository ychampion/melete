/**
 * A message that replies to an earlier one (`replies_to`): the reply is
 * refused unless it names an earlier message of the same conversation, its
 * event keeps the target and a short quote of it, and the agent reads that
 * quote with the reply, whether the reply starts a turn or steers a running one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  dedupKey,
  messageAcceptance,
  REPLY_QUOTE_MAX_CHARS,
  type RuntimeEvent,
} from '@melete/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { event, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { pendingSteers } from '../../src/jobs/steer.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'reply-to-test-signing-key-32-bytes!!',
      scopes: [],
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const withDb = handle ? describe : describe.skip;

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture unavailable');
  return value;
}

const ownerId = newId('own');
const spaceId = newId('sp');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'reply-to@example.test' });
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
const request = (path: string, method = 'GET', body?: unknown) =>
  required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function conversation() {
  const persona = agentResponse.parse(
    await (await request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  return conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'Flights', agent_id: persona.id })
    ).json(),
  ).conversation;
}

const post = (chatId: string, text: string, repliesTo?: string) =>
  request(`/conversations/${chatId}/messages`, 'POST', {
    text,
    ...(repliesTo ? { replies_to: repliesTo } : {}),
  });

async function send(chatId: string, text: string, repliesTo?: string) {
  const response = await post(chatId, text, repliesTo);
  expect(response.status).toBe(200);
  return messageAcceptance.parse(await response.json());
}

async function claim(chatId: string): Promise<ClaimedAttempt> {
  const row = await required(jobs).get(chatId);
  return required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
}

let localSeq = 0;
function emit(claimed: ClaimedAttempt, body: Record<string, unknown>) {
  const seq = localSeq++;
  return required(runner).emit(claimed.claims, {
    ...body,
    attempt_id: claimed.claims.attempt_id,
    local_seq: seq,
    dedup_key: dedupKey(claimed.claims.attempt_id, seq),
    at: new Date().toISOString(),
  } as RuntimeEvent);
}

async function finish(claimed: ClaimedAttempt, summary: string) {
  await emit(claimed, { type: 'text_delta', text: summary });
  return required(runner).commitOutcome(claimed.claims, {
    kind: 'completed',
    summary,
    evidence: [],
  });
}

/** The seq of the chat's newest event of a type: a message's id. */
async function newest(chatId: string, type: string, kind?: string): Promise<string> {
  const rows = await required(handle)
    .db.select({ seq: event.seq })
    .from(event)
    .where(
      and(
        eq(event.jobId, chatId),
        eq(event.type, type),
        kind ? sql`${event.payload}->>'kind' = ${kind}` : undefined,
      ),
    )
    .orderBy(asc(event.seq));
  return String(required(rows.at(-1)).seq);
}

async function personMessages(chatId: string) {
  const rows = await required(handle)
    .db.select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, chatId),
        eq(event.type, 'notice'),
        sql`${event.payload}->>'kind' = 'user_message'`,
      ),
    )
    .orderBy(asc(event.seq));
  return rows.map((row) => row.payload as Record<string, unknown>);
}

/** A chat whose first turn has been answered with `answer`. */
async function answered(answer: string) {
  const chat = await conversation();
  await send(chat.id, 'Find me flights to Lisbon on Friday.');
  localSeq = 0;
  await finish(await claim(chat.id), answer);
  return chat;
}

const OPTIONS = 'Three flights: 1. TAP at 07:10, 2. easyJet at 12:40, 3. Ryanair at 18:05.';

withDb('replying to an earlier message', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('shows the agent a quote of its own earlier answer with the reply', async () => {
    const chat = await answered(OPTIONS);
    const answer = await newest(chat.id, 'text_delta');
    await send(chat.id, 'Book the second one.', answer);
    const [, reply] = await personMessages(chat.id);
    expect(reply).toMatchObject({
      text: 'Book the second one.',
      replies_to: answer,
      reply_quote: { message_id: answer, by: 'assistant', text: OPTIONS },
    });
    localSeq = 0;
    const next = await claim(chat.id);
    const [message] = next.bundle.inputs.new_user_messages;
    expect(message?.content).toBe(
      [
        '[Replying to something you said earlier:]',
        `> ${OPTIONS}`,
        '',
        'Book the second one.',
      ].join('\n'),
    );
    await finish(next, 'Booked easyJet at 12:40.');
  });

  test("says when the quote is the person's own message, and adds nothing to a plain one", async () => {
    const chat = await answered(OPTIONS);
    const own = await newest(chat.id, 'notice', 'user_message');
    await send(chat.id, 'Make this one shorter.', own);
    localSeq = 0;
    const next = await claim(chat.id);
    expect(next.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      [
        '[Replying to an earlier message of theirs:]',
        '> Find me flights to Lisbon on Friday.',
        '',
        'Make this one shorter.',
      ].join('\n'),
    ]);
    await finish(next, 'Lisbon, Friday.');
    await send(chat.id, 'Thanks.');
    localSeq = 0;
    const plain = await claim(chat.id);
    expect(plain.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Thanks.',
    ]);
    // The earlier reply reads the same in the history the next turn is shown.
    expect(plain.bundle.transcript.map((message) => message.content)).toContain(
      required(next.bundle.inputs.new_user_messages[0]?.content),
    );
    const [, , last] = await personMessages(chat.id);
    expect(last).not.toHaveProperty('replies_to');
    expect(last).not.toHaveProperty('reply_quote');
    await finish(plain, 'You are welcome.');
  });

  test('caps the quote of a long message, cut where a word ends', async () => {
    const long = Array.from({ length: 120 }, (_, index) => `word${index}`).join(' ');
    const chat = await answered(long);
    await send(chat.id, 'Shorter, please.', await newest(chat.id, 'text_delta'));
    const [, reply] = await personMessages(chat.id);
    const quote = required(reply?.reply_quote as { text: string } | undefined).text;
    expect(quote.length).toBeLessThanOrEqual(REPLY_QUOTE_MAX_CHARS);
    expect(quote.endsWith('…')).toBe(true);
    const words = quote.slice(0, -1).split(' ');
    expect(long.startsWith(words.join(' '))).toBe(true);
    expect(long.split(' ')).toContain(required(words.at(-1)));
  });

  test('is refused for a message of another chat, a later or unknown id, or no message', async () => {
    const chat = await answered(OPTIONS);
    const other = await answered('Two hotels near the river.');
    const elsewhere = await newest(other.id, 'text_delta');
    const latest = Number(await newest(chat.id, 'text_delta'));
    const submission = await newest(chat.id, 'notice', 'submission_accepted');
    for (const target of [elsewhere, String(latest + 1_000_000), submission]) {
      const response = await post(chat.id, 'Book that one.', target);
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain('reply_target_invalid');
    }
    // Nothing was said: the refused replies left no message behind.
    expect(await personMessages(chat.id)).toHaveLength(1);
    expect((await required(jobs).get(chat.id)).state).toBe('waiting_for_input');
  });

  test('carries the quote when the reply steers a running turn', async () => {
    const chat = await answered(OPTIONS);
    const answer = await newest(chat.id, 'text_delta');
    await send(chat.id, 'Check baggage rules too.');
    localSeq = 0;
    const running = await claim(chat.id);
    const steered = await send(chat.id, 'Only for the first one.', answer);
    expect(steered.steer?.state).toBe('queued');
    expect(await pendingSteers(required(handle).db, chat.id)).toMatchObject([
      {
        id: steered.receipt.id,
        text: 'Only for the first one.',
        quote: { message_id: answer, by: 'assistant', text: OPTIONS },
      },
    ]);
    // Not read by the running attempt: the turn it is carried into reads the quote too.
    await finish(running, 'Checked baggage for all three.');
    localSeq = 0;
    const next = await claim(chat.id);
    expect(next.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      [
        '[Replying to something you said earlier:]',
        `> ${OPTIONS}`,
        '',
        'Only for the first one.',
      ].join('\n'),
    ]);
    await finish(next, 'TAP allows one bag.');
  });

  test('is refused while steering when the target is not in this chat', async () => {
    const chat = await answered(OPTIONS);
    const other = await answered('Two hotels near the river.');
    await send(chat.id, 'Check baggage rules too.');
    localSeq = 0;
    const running = await claim(chat.id);
    const response = await post(chat.id, 'Only that one.', await newest(other.id, 'text_delta'));
    expect(response.status).toBe(400);
    expect(await pendingSteers(required(handle).db, chat.id)).toEqual([]);
    await finish(running, 'Checked baggage for all three.');
  });
});
