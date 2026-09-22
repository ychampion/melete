/**
 * Every kind of backend work reaches the conversation as tool entries: a start
 * and an end under one id, safe summaries, and the same sequence again after a
 * reconnect. The raw records are the ones the broker, the runtime, the gateway
 * and memory write; the projection is the real one.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  type ExperienceEvent,
  experienceEvent,
  type ToolCall,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { action, approval, connection, event, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { BACKEND_VOCABULARY } from '../../src/experience/projectors.ts';
import { appendMemoryTool, appendToolTrace } from '../../src/experience/tools.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { publishRevision } from '../../src/memory/claims.ts';
import { assembleAttemptKnowledge } from '../../src/memory/context.ts';
import { lockSpace, type MemoryScope, provisionMemorySpace } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'experience-tools-signing-key-32-bytes',
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
const spaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
const SEALED = 'sealed-box-v1:QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=';
const PRIVATE = 'private body stays inside';
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'tools@example.test' });
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
async function conversationWithAttempt(text: string) {
  const persona = agentResponse.parse(
    await (
      await request('/agents', {
        method: 'POST',
        body: JSON.stringify(AGENT_TEMPLATES.templates[0]?.agent),
      })
    ).json(),
  ).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Dinner', agent_id: persona.id }),
      })
    ).json(),
  ).conversation;
  await request(`/conversations/${chat.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  const row = await required(jobs).get(chat.id);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
  return { chat, claims: claimed.claims };
}
/** Read SSE frames until `count` events arrived, then hang up. */
async function readStream(path: string, count: number, lastEventId?: number) {
  const controller = new AbortController();
  const response = await request(path, {
    headers: {
      Accept: 'text/event-stream',
      ...(lastEventId === undefined ? {} : { 'Last-Event-ID': String(lastEventId) }),
    },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = required(response.body).getReader();
  const decoder = new TextDecoder();
  const events: ExperienceEvent[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6);
      if (data) events.push(experienceEvent.parse(JSON.parse(data)));
      end = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel();
  controller.abort();
  return events;
}
const tools = (events: ExperienceEvent[]) =>
  events.flatMap((item) => (item.item.type === 'tool' ? [item.item.tool] : []));
const history = (calls: ToolCall[], id: string) =>
  calls.filter((call) => call.id === id).map((call) => call.status);

withDb('tool entries in the conversation', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('each kind starts and ends under one id, and a reconnect replays the same sequence', async () => {
    const db = required(handle).db;
    const sql = required(handle).sql;
    const { chat, claims } = await conversationWithAttempt('Book dinner and tell Sam');
    const attemptId = claims.attempt_id;
    const mailId = newId('conn');
    await db.insert(connection).values({ id: mailId, spaceId, label: 'Mail', provider: 'imap' });
    const raw = async (type: string, payload: Record<string, unknown>) => {
      await db.insert(event).values({
        jobId: chat.id,
        attemptId,
        type,
        payload,
        dedupKey: `tools-fixture:${randomBytes(8).toString('hex')}`,
      });
    };
    // A send: proposed, held for approval, approved, then sent.
    const sendId = newId('act');
    await db.insert(action).values({
      id: sendId,
      jobId: chat.id,
      attemptId,
      connectionId: mailId,
      kind: 'email.send',
      effectClass: 'write_external',
      canonicalPayload: { to: ['sam@example.test'], subject: 'Dinner at seven', body: PRIVATE },
      payloadHash: 'a'.repeat(64),
      idempotencyKey: sendId,
      status: 'proposed',
    });
    const approvalId = newId('apr');
    await db
      .insert(approval)
      .values({ id: approvalId, actionId: sendId, jobRevision: 1, payloadHash: 'a'.repeat(64) });
    await raw('action_requested', { action_id: sendId, kind: 'email.send' });
    for (const [from, to] of [
      ['proposed', 'needs_approval'],
      ['needs_approval', 'approved'],
      ['approved', 'admitted'],
      ['admitted', 'dispatched'],
      ['dispatched', 'succeeded'],
    ])
      await raw('action_status_changed', { action_id: sendId, from, to });
    await db
      .update(action)
      .set({ status: 'succeeded', receipt: { detail: { token: SEALED } }, resolvedAt: new Date() })
      .where(eq(action.id, sendId));
    // A search the destination never confirmed, after one rate-limited wait.
    const searchId = newId('act');
    await db.insert(action).values({
      id: searchId,
      jobId: chat.id,
      attemptId,
      connectionId: mailId,
      kind: 'email.search',
      effectClass: 'read',
      canonicalPayload: { query: `password=${SEALED}` },
      payloadHash: 'b'.repeat(64),
      idempotencyKey: searchId,
      status: 'unknown',
    });
    await raw('action_requested', { action_id: searchId, kind: 'email.search' });
    await raw('notice', { action_id: searchId, phase: 'repair_parked', retry_after_at: null });
    await raw('action_status_changed', { action_id: searchId, from: 'dispatched', to: 'unknown' });
    // The runtime's own calls: a skill that worked and a command that did not.
    await raw('tool_call_proposed', {
      tool: 'skills.research_with_sources',
      call_id: 'c1',
      arguments: { preview: 'dinner places near Sam' },
    });
    await raw('tool_result', { call_id: 'c1', ok: true, result: {} });
    await raw('tool_call_proposed', { tool: 'terminal', call_id: 'email.send#2', arguments: {} });
    await raw('tool_result', { call_id: 'email.send#2', ok: false, result: {} });
    // A connector verb the runtime proposed is told by its action, not twice.
    await raw('tool_call_proposed', { tool: 'email.send', call_id: 'c3', arguments: {} });
    await raw('tool_result', { call_id: 'c3', ok: true, result: {} });
    // The model, through the gateway.
    await raw('notice', { phase: 'model_request', reservation_id: 'bl_one', provider: 'x' });
    await raw('notice', {
      phase: 'model_receipt',
      reservation_id: 'bl_one',
      model_actual: 'gpt-secret-model',
      status: 'succeeded',
      latency_ms: 1200,
    });
    // Memory and a browser step, as other subsystems write them.
    const now = new Date().toISOString();
    await appendMemoryTool(sql, chat.id, attemptId, {
      op: 'write',
      id: 'write:k_1@1',
      status: 'done',
      started_at: now,
      ended_at: now,
      count: 1,
      labels: ['Diet'],
      value: 'Vegetarian',
      memory_item_id: null,
      parent: null,
    });
    await appendToolTrace(sql, chat.id, attemptId, {
      id: 'browser:1',
      kind: 'browser',
      title: 'Opened the booking page',
      status: 'done',
      started_at: now,
      ended_at: now,
      input_summary: null,
      output_summary: { text: 'Page open', quote: { text: 'Table for two', from: 'page' } },
      detail: null,
      parent: null,
    });
    await required(runner).commitOutcome(claims, {
      kind: 'completed',
      summary: 'Dinner is booked.',
      evidence: [],
    });

    const projection = new ExperienceEvents(db);
    const page = await projection.page(spaceId, 0, chat.id, 200);
    const calls = tools(page.events);
    const send = `action:${sendId}`;
    expect(history(calls, send)).toEqual(['running', 'needs_approval', 'running', 'done']);
    expect(
      calls.find((call) => call.id === send && call.status === 'needs_approval')?.detail,
    ).toEqual({ type: 'permission', id: approvalId });
    expect(history(calls, `action:${searchId}`)).toEqual(['running', 'unknown']);
    const retry = calls.find((call) => call.kind === 'retry');
    expect(retry?.parent).toBe(`action:${searchId}`);
    const skill = calls.filter((call) => call.kind === 'skill');
    expect(skill.map((call) => [call.status, call.title])).toEqual([
      ['running', 'Using the skill: Research with sources'],
      ['done', 'Used the skill: Research with sources'],
    ]);
    expect(calls.filter((call) => call.kind === 'sandbox').map((call) => call.status)).toEqual([
      'running',
      'failed',
    ]);
    expect(calls.filter((call) => call.kind === 'model').map((call) => call.status)).toEqual([
      'running',
      'done',
    ]);
    expect(calls.find((call) => call.kind === 'memory_write')?.title).toBe('Remembered: Diet');
    expect(calls.find((call) => call.kind === 'browser')?.output_summary?.quote).toEqual({
      text: 'Table for two',
      from: 'page',
    });
    // The runtime's view of a connector verb adds no entry of its own.
    expect(new Set(calls.map((call) => call.id)).size).toBe(8);
    // The trail gains one finished step for each entry it did not already tell.
    const trail = page.events.flatMap((item) =>
      item.item.type === 'action' && item.item.tool ? [item.item.label] : [],
    );
    expect(trail.sort()).toEqual(
      [
        'Opened the booking page',
        'Remembered: Diet',
        'Used the skill: Research with sources',
        'Using a tool',
      ].sort(),
    );
    const json = JSON.stringify(page);
    expect(json).not.toMatch(BACKEND_VOCABULARY);
    expect(json).not.toContain('sealed-box');
    expect(json).not.toContain(PRIVATE);
    expect(json).not.toContain('gpt-secret');

    // Projecting again adds nothing; the stream from zero is the page, and a
    // reconnect from the middle continues it exactly.
    expect((await projection.page(spaceId, page.next_cursor, chat.id)).events).toEqual([]);
    const path = `/conversations/${chat.id}/events?since=0`;
    const full = await readStream(path, page.events.length);
    expect(full).toEqual(page.events);
    const middle = Math.floor(full.length / 2);
    const resumed = await readStream(path, full.length - middle - 1, required(full[middle]).seq);
    expect([...full.slice(0, middle + 1), ...resumed]).toEqual(full);

    // Home reads the finished turn's progress: steps, never a percentage.
    const view = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}`)).json(),
    );
    expect(view.conversation.progress).toEqual({ steps_done: 6, current: null });
  }, 60000);

  test('recall names details only to the person they belong to', async () => {
    const sql = required(handle).sql;
    const scope: MemoryScope = {
      ownerId,
      spaceId,
      publisher: 'job-worker',
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
    await sql.begin(async (tx) => {
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
    const recalled = async (member: boolean) => {
      const { chat, claims } = await conversationWithAttempt('What should we cook?');
      if (member) {
        const memberId = newId('own');
        await sql`insert into principal (id, email, password_hash)
          values (${memberId}, ${`${memberId}@example.test`}, 'x')`;
        await required(handle)
          .db.update(job)
          .set({ principalId: memberId })
          .where(eq(job.id, chat.id));
      }
      const knowledge = await assembleAttemptKnowledge(
        sql,
        scope,
        claims.attempt_id,
        chat.id,
        'cook dinner food',
      );
      expect(knowledge.context.items.length).toBeGreaterThan(0);
      const page = await new ExperienceEvents(required(handle).db).page(
        spaceId,
        0,
        chat.id,
        200,
        member ? undefined : ownerId,
      );
      return tools(page.events).find((call) => call.kind === 'memory_recall');
    };
    const own = await recalled(false);
    expect(own?.title).toBe('Used what you told me: food: diet');
    const theirs = await recalled(true);
    expect(theirs?.title).toBe('Used 1 thing you told me');
    // The value is never part of a recall entry, for anyone.
    expect(JSON.stringify([own, theirs])).not.toContain('Vegetarian');
  }, 60000);
});
