/**
 * Words sent while a conversation's turn runs: accepted at once, shown at
 * once, and read exactly once, by the running attempt, by the next attempt
 * of the same turn, or as a turn of their own when the turn ended first.
 * Each race between a steer and the end of its turn has a test here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  dedupKey,
  messageAcceptance,
  type RuntimeEvent,
} from '@melete/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { event, experienceTurn, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { appendEvent } from '../../src/events/store.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
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
      key: 'steering-test-signing-key-32-bytes!!',
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'steering@example.test' });
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
const request = (path: string, method = 'GET', body?: unknown, headers: object = {}) =>
  required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function conversation() {
  const persona = agentResponse.parse(
    await (await request('/agents', 'POST', freshAgent())).json(),
  ).agent;
  return conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'Keyboards', agent_id: persona.id })
    ).json(),
  ).conversation;
}

async function send(chatId: string, text: string, key?: string) {
  const response = await request(
    `/conversations/${chatId}/messages`,
    'POST',
    { text },
    key ? { 'Idempotency-Key': key } : {},
  );
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

async function turns(chatId: string) {
  return required(handle)
    .db.select()
    .from(experienceTurn)
    .where(eq(experienceTurn.jobId, chatId))
    .orderBy(asc(experienceTurn.createdAt), asc(experienceTurn.id));
}

async function steerEvents(chatId: string, type: string) {
  return required(handle)
    .db.select()
    .from(event)
    .where(and(eq(event.jobId, chatId), eq(event.type, type)));
}

withDb('words sent while a turn runs', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('are accepted at once into the running turn, not refused and not a new turn', async () => {
    const chat = await conversation();
    const first = await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    const running = await claim(chat.id);
    const steered = await send(chat.id, 'Wireless only, actually.');
    expect(steered.steer).toEqual({ id: steered.receipt.id, state: 'queued' });
    expect(steered.turn_id).toBe(first.turn_id);
    expect(await turns(chat.id)).toHaveLength(1);
    expect(await pendingSteers(required(handle).db, chat.id)).toMatchObject([
      { text: 'Wireless only, actually.' },
    ]);
    // Read by the running attempt: nothing is carried when the turn ends.
    await emit(running, { type: 'steer_delivered', steer_id: steered.receipt.id });
    await finish(running, 'Here are three wireless keyboards.');
    expect(await turns(chat.id)).toHaveLength(1);
    expect(await pendingSteers(required(handle).db, chat.id)).toEqual([]);
    expect((await required(jobs).get(chat.id)).state).toBe('waiting_for_input');
  });

  test('that the turn never read become the next turn, queued as it ends', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    const running = await claim(chat.id);
    const steered = await send(chat.id, 'Under 50 dollars.');
    const after = await finish(running, 'Here are three keyboards.');
    expect(after.state).toBe('queued');
    const [, carried] = await turns(chat.id);
    expect(carried?.text).toBe('Under 50 dollars.');
    expect(after.currentTurnId).toBe(required(carried).id);
    expect(await steerEvents(chat.id, 'steer_carried')).toHaveLength(1);
    // The carried turn reads them as its new message, once.
    localSeq = 0;
    const next = await claim(chat.id);
    expect(next.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Under 50 dollars.',
    ]);
    expect(await pendingSteers(required(handle).db, chat.id)).toEqual([]);
    await finish(next, 'All three are under 50 dollars.');
    expect(await turns(chat.id)).toHaveLength(2);
    expect(steered.steer?.state).toBe('queued');
  });

  test('sent before the turn’s attempt starts are read by it as new messages', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    const steered = await send(chat.id, 'Make it quiet.');
    expect(steered.steer?.state).toBe('queued');
    localSeq = 0;
    const running = await claim(chat.id);
    expect(running.bundle.inputs.new_user_messages.map((message) => message.content)).toEqual([
      'Find me a keyboard.',
      'Make it quiet.',
    ]);
    expect(await pendingSteers(required(handle).db, chat.id)).toEqual([]);
    await finish(running, 'Here is a quiet keyboard.');
    expect(await turns(chat.id)).toHaveLength(1);
  });

  test('read by an attempt that was lost are not new again to the retry', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    const lost = await claim(chat.id);
    const steered = await send(chat.id, 'Wireless only.');
    await emit(lost, { type: 'steer_delivered', steer_id: steered.receipt.id });
    await required(runner).loseAttempt(lost.claims.attempt_id, 'runtime_crashed');
    localSeq = 0;
    const retry = await claim(chat.id);
    const contents = retry.bundle.inputs.new_user_messages.map((message) => message.content);
    expect(contents).not.toContain('Wireless only.');
    // Still in the conversation the retry reads, in order.
    expect(retry.bundle.transcript.map((message) => message.content)).toContain('Wireless only.');
    await finish(retry, 'Here are wireless keyboards.');
    expect(await turns(chat.id)).toHaveLength(1);
  });

  test('not read by an attempt that was lost are read by the retry, and never carried twice', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    const lost = await claim(chat.id);
    await send(chat.id, 'Wireless only.');
    await required(runner).loseAttempt(lost.claims.attempt_id, 'runtime_crashed');
    localSeq = 0;
    const retry = await claim(chat.id);
    expect(retry.bundle.inputs.new_user_messages.map((message) => message.content)).toContain(
      'Wireless only.',
    );
    await finish(retry, 'Here are wireless keyboards.');
    expect(await turns(chat.id)).toHaveLength(1);
    expect(await steerEvents(chat.id, 'steer_carried')).toHaveLength(0);
  });

  test('sent twice with the same key are one message', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    await claim(chat.id);
    const one = await send(chat.id, 'Wireless only.', 'same-key');
    const two = await send(chat.id, 'Wireless only.', 'same-key');
    expect(two.receipt.id).toBe(one.receipt.id);
    expect(await pendingSteers(required(handle).db, chat.id)).toHaveLength(1);
  });

  test('sent after the turn ended are an ordinary next message', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    await finish(await claim(chat.id), 'Here are three keyboards.');
    const next = await send(chat.id, 'Wireless only.');
    expect(next.steer).toBeUndefined();
    expect(await turns(chat.id)).toHaveLength(2);
  });

  test('are shown at once in the conversation, then as read', async () => {
    const chat = await conversation();
    await send(chat.id, 'Find me a keyboard.');
    localSeq = 0;
    const running = await claim(chat.id);
    const steered = await send(chat.id, 'Wireless only.');
    await emit(running, { type: 'steer_delivered', steer_id: steered.receipt.id });
    await finish(running, 'Here are three wireless keyboards.');
    const page = (await (
      await request(`/conversations/${chat.id}/events?since=0&limit=200`)
    ).json()) as { events: Array<{ item: { type: string; id?: string; state?: string } }> };
    const shown = page.events
      .map((entry) => entry.item)
      .filter((item) => item.type === 'steer' && item.id === steered.receipt.id);
    expect(shown.map((item) => item.state)).toEqual(['queued', 'delivered']);
    const raw = await required(handle).db.execute(
      sql`select count(*)::int as n from event where job_id = ${chat.id} and type = 'steer_delivered'`,
    );
    expect((raw as unknown as Array<{ n: number }>)[0]?.n).toBe(1);
  });

  test('a quiet thread whose run moved is kept up to date in the background', async () => {
    const thread = await conversation();
    const db = required(handle).db;
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await db.update(job).set({ updatedAt: old }).where(eq(job.id, thread.id));
    const run = newId('job');
    await db.insert(job).values({
      id: run,
      spaceId,
      principalId: ownerId,
      title: 'Morning brief',
      objective: 'Morning brief',
      experienceParentId: thread.id,
    });
    await db.transaction((tx) =>
      appendEvent(tx, {
        jobId: run,
        type: 'notice',
        payload: { kind: 'gap' },
        dedupKey: `${run}:gap`,
      }),
    );
    // The space-wide pass a live page runs, not a read of this thread.
    await new ExperienceEvents(db).sync(spaceId, undefined, ownerId);
    const [projected] = await db
      .select()
      .from(event)
      .where(and(eq(event.jobId, thread.id), sql`${event.payload}->'item'->>'transient' = 'true'`));
    expect(projected).toBeDefined();
  });
});
