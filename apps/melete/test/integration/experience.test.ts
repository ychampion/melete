import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  agentResponse,
  conversationResponse,
  dedupKey,
  messageAcceptance,
  turnList,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import {
  action,
  agent,
  connection,
  event,
  experienceTurn,
  job,
  owner,
  space,
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
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'experience-fixture-signing-key-32-bytes',
    })
  : null;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      checkDatabase: async () => 'ok',
    })
  : null;
const spaceId = newId('sp');
const foreignSpaceId = newId('sp');
const ownerId = newId('own');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'experience@example.test' });
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
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
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
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}
