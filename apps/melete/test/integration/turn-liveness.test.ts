/**
 * A turn never sits on "working" with nothing happening. A quiet agent reads
 * as stalled until it moves again, and a turn whose work was parked on the
 * person outside the runner's sight settles as waiting for them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  type CapabilityClaims,
  conversationResponse,
  dedupKey,
  type ExperienceEvent,
  type RuntimeEvent,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { experienceTurn, job, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import { freshAgent } from '../helpers/agents.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'turn-liveness-signing-key-32-bytes!!',
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'liveness@example.test' });
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
  if (value === null || value === undefined) throw new Error('fixture unavailable');
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

/** A conversation with one message sent and its turn claimed by an attempt. */
async function turnUnderWay(text: string) {
  const created = await request('/agents', 'POST', freshAgent());
  const persona = agentResponse.parse(await created.json()).agent;
  const chat = conversationResponse.parse(
    await (
      await request('/conversations', 'POST', { title: 'Transit', agent_id: persona.id })
    ).json(),
  ).conversation;
  expect((await request(`/conversations/${chat.id}/messages`, 'POST', { text })).status).toBe(200);
  const row = await required(jobs).get(chat.id);
  const claims = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  ).claims;
  return { chat, claims };
}

type Body = RuntimeEvent extends infer T
  ? T extends RuntimeEvent
    ? Omit<T, 'attempt_id' | 'local_seq' | 'dedup_key' | 'at'>
    : never
  : never;
const emitter = (claims: CapabilityClaims) => {
  let seq = 0;
  return (body: Body) => {
    const local_seq = seq++;
    return required(runner).emit(claims, {
      ...body,
      attempt_id: claims.attempt_id,
      local_seq,
      dedup_key: dedupKey(claims.attempt_id, local_seq),
      at: new Date().toISOString(),
    } as RuntimeEvent);
  };
};

async function turnStatus(chatId: string) {
  const [row] = await required(handle)
    .db.select({ status: experienceTurn.status })
    .from(experienceTurn)
    .innerJoin(job, eq(job.currentTurnId, experienceTurn.id))
    .where(eq(job.id, chatId));
  return row?.status;
}

/** What the conversation's stream says, in order: its statuses and its notes. */
async function stream(chatId: string) {
  const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chatId, 200);
  const items = (page as { events: ExperienceEvent[] }).events.map((event) => event.item);
  return {
    statuses: items.flatMap((item) => (item.type === 'status' ? [item.status] : [])),
    notes: items.flatMap((item) => (item.type === 'note' ? [item.text] : [])),
  };
}

withDb('a turn never sits on working with nothing happening', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a quiet agent reads as stalled until it shows progress again', async () => {
    const { chat, claims } = await turnUnderWay('Transit from Union Square to SFO at 8 am');
    const emit = emitter(claims);
    await emit({
      type: 'tool_call_proposed',
      tool: 'browser.open',
      call_id: 'browser.open#0',
      arguments: { preview: '' },
    });
    await emit({ type: 'stalled', silent_ms: 300_000, tool: 'browser.open' });
    expect(await turnStatus(chat.id)).toBe('stalled');
    const view = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(view).toMatchObject({ status: 'stalled', composer: 'stop' });
    let seen = await stream(chat.id);
    expect(seen.statuses.at(-1)).toBe('stalled');
    expect(seen.notes).toContain(
      'Nothing has come back for 5 minutes. Asking for what is done so far.',
    );
    // The agent answers the hidden request to report: the turn is moving again.
    await emit({ type: 'text_delta', text: 'So far: BART from Powell St, about 35 minutes.' });
    expect(await turnStatus(chat.id)).toBe('streaming');
    seen = await stream(chat.id);
    expect(seen.statuses.slice(seen.statuses.indexOf('stalled'))).toEqual(['stalled', 'working']);
  });

  test('a turn parked on the person outside the runner settles as waiting for them', async () => {
    const { chat, claims } = await turnUnderWay('Find the Directions button');
    const sql = required(handle).sql;
    const sessionId = `brws_${randomBytes(6).toString('hex')}`;
    await sql`insert into browser_session_binding (id, space_id, job_id, control_epoch, control)
      values (${sessionId}, ${spaceId}, ${chat.id}, 1, 'human')`;
    const sessions = new BrowserSessionService(sql, {
      get: async () => {
        throw new Error('no worker is needed to park');
      },
    });
    // A person took the browser: the job waits for their hand-back, and the
    // attempt is fenced without the runner seeing an outcome.
    await sessions.park({ space_id: spaceId, job_id: chat.id }, sessionId, 'human_control');
    expect((await required(jobs).get(chat.id)).state).toBe('waiting_for_input');
    expect(await turnStatus(chat.id)).toBe('working');
    // Within the grace a move in flight is left alone.
    expect(await required(runner).settleOrphanTurns(60_000)).toBe(0);
    expect(await required(runner).settleOrphanTurns(0)).toBe(1);
    expect(await turnStatus(chat.id)).toBe('needs_you');
    expect((await stream(chat.id)).statuses.at(-1)).toBe('needs_you');
    expect(await required(runner).settleOrphanTurns(0)).toBe(0);
    expect(claims.job_id).toBe(chat.id);
  });

  test('a turn whose attempt is still running is never settled', async () => {
    const { chat } = await turnUnderWay('Compare three monitors');
    await required(handle)
      .db.update(job)
      .set({ state: 'waiting_for_input' })
      .where(eq(job.id, chat.id));
    expect(await required(runner).settleOrphanTurns(0)).toBe(0);
    expect(await turnStatus(chat.id)).toBe('working');
  });
});
