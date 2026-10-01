/**
 * A conversation outlives any one turn. A turn that failed, reached a safety
 * limit or left an effect to reconcile is recorded as such, and the person's
 * next message starts the next turn instead of being refused.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  agentResponse,
  type CapabilityClaims,
  conversationResponse,
  dedupKey,
  jobBudget,
  messageAcceptance,
  turnList,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { session } from '../../src/db/auth-schema.ts';
import { openDatabase } from '../../src/db/client.ts';
import { action, connection, job, owner, space } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { loadEnv } from '../../src/env.ts';
import { appendEvent } from '../../src/events/store.ts';
import { AGENT_TEMPLATES } from '../../src/experience/agents.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { LIMIT_REACHED_NOTE, waitingForSlotNote } from '../../src/jobs/limits.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, LOST_NOTE } from '../../src/jobs/runner.ts';
import { CONVERSATION_BUDGET, DEFAULT_BUDGET, JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'conversation-recovery-signing-key-32b',
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'recovery@example.test' });
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

async function createConversation() {
  const response = await request('/agents', 'POST', AGENT_TEMPLATES.templates[0]?.agent);
  expect(response.status).toBe(200);
  const persona = agentResponse.parse(await response.json()).agent;
  const created = await request('/conversations', 'POST', { title: 'Tea', agent_id: persona.id });
  expect(created.status).toBe(200);
  return conversationResponse.parse(await created.json()).conversation;
}

const send = (id: string, text: string) =>
  request(`/conversations/${id}/messages`, 'POST', { text });

/** Send a message, claim the turn it starts, and end that turn with `outcome`. */
async function turnEndingIn(
  id: string,
  outcome: AttemptOutcome,
  during?: (claims: CapabilityClaims) => Promise<void>,
) {
  const sent = await send(id, 'Write a long essay on the history of tea.');
  expect(sent.status).toBe(200);
  const row = await required(jobs).get(id);
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
  await during?.(claimed.claims);
  await required(runner).commitOutcome(claimed.claims, outcome);
  return claimed.claims;
}

withDb('a conversation goes on after a turn that did not finish cleanly', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30000);

  test('a turn whose last attempt was lost to a restart ends failed, not working', async () => {
    const chat = await createConversation();
    const sent = await send(chat.id, 'Run the long command on your computer.');
    expect(sent.status).toBe(200);
    const sql = required(handle).sql;
    // The last attempt this turn may have.
    await sql`update job set budget = jsonb_set(budget, '{max_attempts}', '1'::jsonb)
      where id = ${chat.id}`;
    const row = await required(jobs).get(chat.id);
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    // The service stopped while it ran.
    expect(await required(runner).loseAttempt(claimed.claims.attempt_id, 'Service stopping')).toBe(
      true,
    );
    expect((await required(jobs).get(chat.id)).state).toBe('failed');
    const view = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(view.status).toBe('failed');
    expect(view.composer).toBe('send');
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.at(-1)?.status).toBe('failed');
    expect(turns.turns.at(-1)?.answer).toBe(LOST_NOTE);
    const [ended] = await sql`select payload from event
      where attempt_id = ${claimed.claims.attempt_id} and type = 'attempt_ended'`;
    expect(ended?.payload).toMatchObject({ kind: 'lost', turn_status: 'failed' });
  });

  test('after a failed turn the next message starts a new turn', async () => {
    const chat = await createConversation();
    await turnEndingIn(chat.id, {
      kind: 'failed',
      reason: 'The model provider did not answer.',
      retryable: false,
    });
    expect((await required(jobs).get(chat.id)).state).toBe('failed');
    const next = await send(chat.id, 'Try again, please.');
    expect(next.status).toBe(200);
    const accepted = messageAcceptance.parse(await next.json());
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.map((turn) => turn.status)).toEqual(['failed', 'queued']);
    expect(turns.turns[1]?.id).toBe(accepted.turn_id);
    const row = await required(jobs).get(chat.id);
    expect(row.state).toBe('queued');
    expect(row.currentTurnId).toBe(accepted.turn_id);
  });

  test('after a turn left an effect to reconcile, the effect stays open and the chat goes on', async () => {
    const chat = await createConversation();
    const connectionId = newId('conn');
    await required(handle)
      .db.insert(connection)
      .values({ id: connectionId, spaceId, label: 'Mail', provider: 'imap' });
    const actionId = newId('act');
    await turnEndingIn(
      chat.id,
      { kind: 'completed', summary: 'I sent it.', evidence: [] },
      async (claims) => {
        await required(handle)
          .db.insert(action)
          .values({
            id: actionId,
            jobId: chat.id,
            attemptId: claims.attempt_id,
            connectionId,
            kind: 'email.send',
            effectClass: 'write_external',
            canonicalPayload: {},
            payloadHash: 'a'.repeat(64),
            idempotencyKey: actionId,
            status: 'unknown',
          });
      },
    );
    expect((await required(jobs).get(chat.id)).state).toBe('needs_reconciliation');
    expect((await send(chat.id, 'Did it go? Also, what time is it in Tokyo?')).status).toBe(200);
    expect((await required(jobs).get(chat.id)).state).toBe('queued');
    const [open] = await required(handle).db.select().from(action).where(eq(action.id, actionId));
    // Nothing is decided on the person's behalf: the uncertain send is still
    // recorded as uncertain and still theirs to settle.
    expect(open?.status).toBe('unknown');
  });

  test('a turn the broker parked while its attempt is still running is still in progress', async () => {
    const chat = await createConversation();
    expect((await send(chat.id, 'Send the note to Sam.')).status).toBe(200);
    const row = await required(jobs).get(chat.id);
    required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    // The broker moves the job while the attempt keeps going.
    await required(handle)
      .db.update(job)
      .set({ state: 'needs_reconciliation' })
      .where(eq(job.id, chat.id));
    const refused = await send(chat.id, 'And one more thing.');
    expect(refused.status).toBe(409);
    expect((await required(jobs).get(chat.id)).state).toBe('needs_reconciliation');
  });

  test('a conversation turn has room for real work and ends a limit in plain words', async () => {
    const chat = await createConversation();
    const budget = jobBudget.parse((await required(jobs).get(chat.id)).budget);
    expect(budget).toEqual(CONVERSATION_BUDGET);
    expect(budget.max_wall_ms).toBeGreaterThanOrEqual(30 * 60_000);
    await turnEndingIn(
      chat.id,
      { kind: 'budget_exhausted', summary: 'The attempt wall-time budget is exhausted.' },
      async (claims) => {
        await required(runner).emit(claims, {
          type: 'text_delta',
          attempt_id: claims.attempt_id,
          local_seq: 1,
          dedup_key: dedupKey(claims.attempt_id, 1),
          at: new Date().toISOString(),
          text: 'Tea was first drunk in China.',
        });
      },
    );
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns[0]?.answer).toBe(`Tea was first drunk in China.\n\n${LIMIT_REACHED_NOTE}`);
    expect(turns.turns[0]?.answer).not.toContain('budget');
    const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    // A page following the turn live reads the same sentence.
    expect(
      page.events.some(
        (event) => event.item.type === 'note' && event.item.text === LIMIT_REACHED_NOTE,
      ),
    ).toBe(true);
    // "continue" is a new turn, which is what the sentence promised.
    expect((await send(chat.id, 'continue')).status).toBe(200);
  });

  test('a turn waiting for a free slot says so in the conversation, while it is queued', async () => {
    const chat = await createConversation();
    expect((await send(chat.id, 'What time is it in Paris?')).status).toBe(200);
    const row = await required(jobs).get(chat.id);
    const wake = {
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input' as const,
    };
    await required(runner).noteWaiting(wake, 2);
    // Told once per wait, however often it is looked at.
    await required(runner).noteWaiting(wake, 2);
    const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    const notes = page.events.filter((event) => event.item.type === 'note');
    expect(notes.map((event) => event.item)).toEqual([
      { type: 'note', text: 'Waiting for a free slot — 2 other tasks are running' },
    ]);
    expect(notes[0]?.turn_id).toBeTruthy();
    expect(waitingForSlotNote(1)).toBe('Waiting for a free slot — 1 other task is running');
    // A wake that would no longer start the job says nothing.
    required(await required(runner).claim(wake));
    await required(runner).noteWaiting(wake, 3);
    const later = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    expect(later.events.filter((event) => event.item.type === 'note')).toHaveLength(1);
  });

  test('a conversation from before conversations had their own limits gets them on its next turn', async () => {
    const chat = await createConversation();
    await required(handle)
      .db.update(job)
      .set({ budget: DEFAULT_BUDGET })
      .where(eq(job.id, chat.id));
    expect((await send(chat.id, 'Hello again')).status).toBe(200);
    expect(jobBudget.parse((await required(jobs).get(chat.id)).budget)).toEqual(
      CONVERSATION_BUDGET,
    );
    // A budget somebody chose is left alone.
    const chosen = { ...DEFAULT_BUDGET, max_wall_ms: 60_000 };
    const other = await createConversation();
    await required(handle).db.update(job).set({ budget: chosen }).where(eq(job.id, other.id));
    expect((await send(other.id, 'Hello')).status).toBe(200);
    expect(jobBudget.parse((await required(jobs).get(other.id)).budget)).toEqual(chosen);
  });

  test('cancelling the job of a conversation mid-turn settles it the way Stop does', async () => {
    const chat = await createConversation();
    expect((await send(chat.id, 'Write a long essay on the history of tea.')).status).toBe(200);
    const row = await required(jobs).get(chat.id);
    required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'input',
      }),
    );
    expect((await request(`/jobs/${chat.id}/cancel`, 'POST', {})).status).toBe(200);
    const view = conversationResponse.parse(
      await (await request(`/conversations/${chat.id}`)).json(),
    ).conversation;
    expect(view.status).toBe('stopped');
    expect(view.composer).toBe('send');
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.at(-1)?.status).toBe('stopped');
    // A page following the conversation live is told too, not left working.
    const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, chat.id);
    expect(
      page.events.some(
        (event) =>
          event.item.type === 'status' &&
          event.item.status === 'stopped' &&
          event.item.composer === 'send',
      ),
    ).toBe(true);
    expect((await send(chat.id, 'Something shorter, then.')).status).toBe(200);
  });

  test('projecting a conversation never waits on a second connection under the event order lock', async () => {
    const chat = await createConversation();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Two connections: one for the projection, one for a writer that queues on
    // the lock. A lookup that then needs a third waits for the pool for ever,
    // while the pool waits for the lock: the whole service froze this way.
    const small = openDatabase(required(handle).url, 2);
    let waiter: Promise<unknown> = Promise.resolve();
    try {
      await serviceTransaction(small.db, (tx) =>
        appendEvent(tx, {
          jobId: chat.id,
          type: 'notice',
          payload: { kind: 'question_asked', question_id: 'q_pool_probe' },
          dedupKey: `pool-probe:${chat.id}`,
        }),
      );
      const events = new ExperienceEvents(small.db, {
        permission: async () => undefined,
        question: async () => {
          waiter = serviceTransaction(small.db, async () => {});
          await Promise.race([waiter, sleep(500)]);
          // The question service reads on the pool, as the real one does.
          await small.sql`select 1`;
          return undefined;
        },
      });
      const outcome = await Promise.race([
        events.sync(spaceId, chat.id).then(() => 'projected'),
        sleep(15_000).then(() => 'stuck'),
      ]);
      expect(outcome).toBe('projected');
      await waiter;
    } finally {
      await small.close();
    }
  }, 30000);
});
