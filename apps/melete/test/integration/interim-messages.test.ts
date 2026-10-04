/**
 * What the agent writes between tool calls reaches the conversation as its own
 * messages: the words before a call are all shown before the call, and the
 * words after it start a new paragraph. Projected in one pass or in two, the
 * stream reads the same.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  type ExperienceEvent,
  TOOL_TRACE_NOTICE,
} from '@melete/contracts';
import { session } from '../../src/db/auth-schema.ts';
import { event, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
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
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'interim-messages-signing-key-32-bytes',
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
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'interim@example.test' });
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
    await (await request('/agents', { method: 'POST', body: JSON.stringify(freshAgent()) })).json(),
  ).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', {
        method: 'POST',
        body: JSON.stringify({ title: 'Rents', agent_id: persona.id }),
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
  return { chat, attemptId: claimed.claims.attempt_id, claims: claimed.claims };
}

/** The agent's words, cut wherever a tool entry came between them. */
function messages(events: ExperienceEvent[]): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const entry of events) {
    if (entry.item.type === 'text_delta') current = (current ?? '') + entry.item.text;
    else if (entry.item.type === 'tool' && current !== null) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

withDb('messages between tool calls', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  for (const passes of [1, 2])
    test(`each message ends before the next call, projected in ${passes} pass${passes === 1 ? '' : 'es'}`, async () => {
      const db = required(handle).db;
      const { chat, attemptId, claims } = await conversationWithAttempt('Find Lisbon rents');
      const raw = async (type: string, payload: Record<string, unknown>) => {
        await db.insert(event).values({
          jobId: chat.id,
          attemptId,
          type,
          payload,
          dedupKey: `interim-fixture:${randomBytes(8).toString('hex')}`,
        });
      };
      const projection = new ExperienceEvents(db);
      await raw('text_delta', { text: "I'll search for this month's " });
      await raw('text_delta', { text: 'rent figures first.' });
      await raw('tool_call_proposed', {
        tool: 'web_search',
        call_id: 'c1',
        arguments: { preview: 'Lisbon rent prices' },
      });
      await raw('tool_result', { call_id: 'c1', ok: true, result: {} });
      // A page read here stops the projection mid-turn; the rest is read on a later page.
      if (passes === 2) await projection.page(spaceId, 0, chat.id, 200);
      await raw('text_delta', { text: 'One source has the parish table.' });
      await raw('tool_call_proposed', {
        tool: 'read_file',
        call_id: 'c2',
        arguments: { preview: 'report.md' },
      });
      await raw('tool_result', { call_id: 'c2', ok: true, result: {} });
      await raw('text_delta', { text: 'One-bedrooms average 1,284 EUR.' });
      await required(runner).commitOutcome(claims, {
        kind: 'completed',
        summary: 'Rents found.',
        evidence: [],
      });
      const page = await projection.page(spaceId, 0, chat.id, 200);
      const said = messages(page.events);
      expect(said).toEqual([
        "I'll search for this month's rent figures first.",
        '\n\nOne source has the parish table.',
        '\n\nOne-bedrooms average 1,284 EUR.',
      ]);
      // Reasoning never joins the answer, and nothing is said twice.
      expect(page.events.filter((entry) => entry.item.type === 'reasoning')).toEqual([]);
    });

  for (const passes of [1, 2])
    test(`work the engine traces before its call is proposed ends the message too, in ${passes} pass${passes === 1 ? '' : 'es'}`, async () => {
      const db = required(handle).db;
      const { chat, attemptId, claims } = await conversationWithAttempt('Which Bun is current?');
      const raw = async (type: string, payload: Record<string, unknown>) => {
        await db.insert(event).values({
          jobId: chat.id,
          attemptId,
          type,
          payload,
          dedupKey: `interim-fixture:${randomBytes(8).toString('hex')}`,
        });
      };
      const projection = new ExperienceEvents(db);
      const at = new Date().toISOString();
      await raw('text_delta', { text: "I'll check the date and look up Bun's latest" });
      await raw('text_delta', { text: ' release.' });
      // The engine's own command is traced first; the model's call follows it.
      await raw('notice', {
        kind: TOOL_TRACE_NOTICE,
        call: {
          id: 'sandbox:1',
          kind: 'sandbox',
          title: 'Ran `date`',
          status: 'done',
          started_at: at,
          ended_at: at,
          input_summary: null,
          output_summary: null,
          detail: null,
          parent: null,
        },
      });
      if (passes === 2) await projection.page(spaceId, 0, chat.id, 200);
      await raw('tool_call_proposed', { tool: 'terminal', call_id: 'c1', arguments: {} });
      await raw('tool_result', { call_id: 'c1', ok: true, result: {} });
      await raw('text_delta', { text: 'Bun 1.4.2 is the latest.' });
      await required(runner).commitOutcome(claims, {
        kind: 'completed',
        summary: 'Found it.',
        evidence: [],
      });
      const page = await projection.page(spaceId, 0, chat.id, 200);
      expect(messages(page.events)).toEqual([
        "I'll check the date and look up Bun's latest release.",
        '\n\nBun 1.4.2 is the latest.',
      ]);
    });
});
