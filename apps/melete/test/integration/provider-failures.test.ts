/**
 * A model provider that refuses a call is named for what it is: a refused
 * key, a spent account, a limit, a missing model. The provider's own words
 * never leave the gateway; the class does, and the turn ends (or waits and
 * tries again) according to it, with a plain note and the way to the fix.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import {
  type AttemptOutcome,
  agentResponse,
  type CapabilityClaims,
  conversationResponse,
  turnList,
} from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { signCapability } from '../../src/broker/capability.ts';
import { createInternalServer } from '../../src/broker/internal-server.ts';
import { session } from '../../src/db/auth-schema.ts';
import { attempt, job, owner, space } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { loadEnv } from '../../src/env.ts';
import { appendEvent } from '../../src/events/store.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { createScriptedProvider, type FakeTurn, fakeProvider } from '../../src/gateway/fake.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { MODEL_SETTINGS_PLACE, PROVIDER_FAILURE_NOTES } from '../../src/jobs/provider-notes.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { defaultPrivacyRouter } from '../../src/privacy/index.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { freshAgent } from '../helpers/agents.ts';
import { seedJob } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const BACKOFF_MS = 20_000;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'provider-failures-signing-key-000000000',
      retryBackoffMs: BACKOFF_MS,
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
  await handle.db.insert(owner).values({ id: ownerId, email: 'refusals@example.test' });
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

afterAll(async () => {
  await runner?.stop();
  await queue?.stop();
  await handle?.close();
}, 30000);

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('fixture unavailable');
  return value;
}

// ---------------------------------------------------------------------------
// The gateway, with the scripted provider refusing
// ---------------------------------------------------------------------------

const capabilityKey = 'provider-failures-gateway-key-0000000000';
const LEAKED = 'sk-live-leaked-0123456789';

/** One model call through the real gateway to a provider that answers with `refusal`. */
async function refusedCall(refusal: FakeTurn) {
  const sql = required(handle).sql;
  const seed = await seedJob(sql, { budget: { max_turns: 10 } });
  const internal = createInternalServer({
    privacy: defaultPrivacyRouter(),
    sql,
    connectors: { get: () => undefined },
    capabilityKey,
    approvalKey: 'provider-failures-approval-key-000000000',
    providers: [fakeProvider],
    defaultProvider: 'fake',
    fake: createScriptedProvider([refusal]),
  });
  await new Promise<void>((resolve, reject) => {
    internal.server.once('error', reject);
    internal.server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = internal.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing gateway address');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/providers/fake/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-fixture',
          'x-melete-capability': signCapability(seed.claims, capabilityKey),
        },
        body: JSON.stringify({
          model: 'scripted',
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      },
    );
    const text = await response.text();
    const [receipt] =
      await sql`select payload from event where attempt_id = ${seed.claims.attempt_id}
        and payload->>'phase' = 'model_receipt'`;
    return { status: response.status, text, receipt: receipt?.payload as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve) => internal.server.close(() => resolve()));
  }
}

withDb('the gateway names a provider refusal and keeps its words', () => {
  test('a refused key is a 401 the engine will not retry, with no provider text', async () => {
    const call = await refusedCall({
      refuse: {
        status: 401,
        body: {
          error: {
            type: 'invalid_request_error',
            message: `Incorrect API key provided: ${LEAKED}. Find your key in your account.`,
          },
        },
      },
    });
    expect(call.status).toBe(401);
    expect(JSON.parse(call.text)).toEqual({
      error: { code: 'provider_key_refused', message: 'provider_key_refused' },
    });
    expect(call.text).not.toContain(LEAKED);
    expect(call.text).not.toContain('Incorrect API key');
    expect(call.receipt).toMatchObject({
      status: 'failed',
      http_status: 401,
      failure: 'key_refused',
    });
  });

  test('a rate limit stays a 429 and is recorded as one', async () => {
    const call = await refusedCall({
      refuse: {
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'Too many requests per minute.' } },
      },
    });
    expect(call.status).toBe(429);
    expect(JSON.parse(call.text).error.code).toBe('provider_rate_limited');
    expect(call.text).not.toContain('per minute');
    expect(call.receipt).toMatchObject({ http_status: 429, failure: 'rate_limited' });
  });

  test('a spent account answered as 429 is told apart from a rate limit', async () => {
    const call = await refusedCall({
      refuse: {
        status: 429,
        body: {
          error: {
            code: 'insufficient_quota',
            message: 'You exceeded your current quota, please check your plan.',
          },
        },
      },
    });
    expect(call.status).toBe(402);
    expect(JSON.parse(call.text).error.code).toBe('provider_quota');
    expect(call.receipt).toMatchObject({ http_status: 429, failure: 'quota' });
  });

  test('a model the provider does not have is a 404', async () => {
    const call = await refusedCall({
      refuse: { status: 404, body: { error: { code: 'model_not_found', message: 'gone' } } },
    });
    expect(call.status).toBe(404);
    expect(JSON.parse(call.text).error.code).toBe('provider_model_not_found');
    expect(call.receipt).toMatchObject({ failure: 'model_not_found' });
  });
});

// ---------------------------------------------------------------------------
// The conversation, when an attempt ends on a refusal
// ---------------------------------------------------------------------------

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
  const response = await request('/agents', 'POST', freshAgent());
  expect(response.status).toBe(200);
  const persona = agentResponse.parse(await response.json()).agent;
  const created = await request('/conversations', 'POST', { title: 'Tea', agent_id: persona.id });
  expect(created.status).toBe(200);
  return conversationResponse.parse(await created.json()).conversation;
}

/** Send a message, claim the turn it starts, and end that turn with `outcome`. */
async function turnEndingIn(
  id: string,
  outcome: AttemptOutcome,
  during?: (claims: CapabilityClaims) => Promise<void>,
) {
  const sent = await request(`/conversations/${id}/messages`, 'POST', { text: 'Plan my week.' });
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

/** What the conversation's stream says, in order. */
async function stream(id: string) {
  const page = await new ExperienceEvents(required(handle).db).page(spaceId, 0, id);
  return page.events.map((event) => event.item);
}

async function attemptsOf(id: string) {
  return required(handle).db.select().from(attempt).where(eq(attempt.jobId, id));
}

withDb('a conversation turn the provider refused', () => {
  test('a refused key ends the turn after one attempt, says why, and points at Settings', async () => {
    const chat = await createConversation();
    await turnEndingIn(chat.id, {
      kind: 'failed',
      reason: 'Error code: 401 - provider_key_refused',
      retryable: false,
      failure: 'key_refused',
    });
    expect((await required(jobs).get(chat.id)).state).toBe('failed');
    expect(await attemptsOf(chat.id)).toHaveLength(1);
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.at(-1)?.status).toBe('failed');
    expect(turns.turns.at(-1)?.answer).toBe(PROVIDER_FAILURE_NOTES.key_refused);
    const items = await stream(chat.id);
    expect(items).toContainEqual({ type: 'note', text: PROVIDER_FAILURE_NOTES.key_refused });
    const card = items.find((item) => item.type === 'card');
    expect(card?.type === 'card' && card.card.primary_action).toMatchObject({
      kind: 'open',
      handle: MODEL_SETTINGS_PLACE,
    });
    // It settles once, on failed; it never reads as waiting on the person.
    const statuses = items.flatMap((item) => (item.type === 'status' ? [item.status] : []));
    expect(statuses.at(-1)).toBe('failed');
    expect(statuses).not.toContain('needs_you');
  });

  test('an engine that retried a refused key itself is not run again', async () => {
    const chat = await createConversation();
    // The engine's failure names nothing; the gateway's record of the call does.
    await turnEndingIn(
      chat.id,
      { kind: 'failed', reason: 'the runtime reported a failure', retryable: true },
      async (claims) => {
        await serviceTransaction(required(handle).db, (tx) =>
          appendEvent(tx, {
            jobId: claims.job_id,
            attemptId: claims.attempt_id,
            type: 'notice',
            payload: {
              phase: 'model_receipt',
              reservation_id: `res_${claims.attempt_id}`,
              status: 'failed',
              http_status: 402,
              failure: 'quota',
            },
            dedupKey: `receipt:${claims.attempt_id}`,
          }),
        );
      },
    );
    expect((await required(jobs).get(chat.id)).state).toBe('failed');
    expect(await attemptsOf(chat.id)).toHaveLength(1);
    const items = await stream(chat.id);
    expect(items).toContainEqual({ type: 'note', text: PROVIDER_FAILURE_NOTES.quota });
    const tool = items.find((item) => item.type === 'tool' && item.tool.kind === 'model');
    expect(tool?.type === 'tool' && tool.tool.output_summary?.text).toBe(
      'The provider account is out of credit.',
    );
  });

  test('a rate limit waits before the next attempt, and the turn stays under way', async () => {
    const chat = await createConversation();
    const before = Date.now();
    await turnEndingIn(chat.id, {
      kind: 'failed',
      reason: 'Error code: 429 - provider_rate_limited',
      retryable: true,
      failure: 'rate_limited',
    });
    const row = await required(jobs).get(chat.id);
    expect(row.state).toBe('queued');
    // The first wait is the whole backoff, give or take the clocks.
    expect(required(row.nextWakeAt).getTime()).toBeGreaterThanOrEqual(before + BACKOFF_MS - 2000);
    const turns = turnList.parse(
      await (await request(`/conversations/${chat.id}/messages`)).json(),
    );
    expect(turns.turns.at(-1)?.status).not.toBe('failed');
    const items = await stream(chat.id);
    const statuses = items.flatMap((item) => (item.type === 'status' ? [item.status] : []));
    expect(statuses).not.toContain('failed');
    expect(statuses).not.toContain('needs_you');
    expect(statuses.at(-1)).toBe('working');
    // The wait is told while it lasts, and drops out of the log once the turn ends.
    expect(
      items.some(
        (item) =>
          item.type === 'note' && item.text.includes('slow down') && item.transient === true,
      ),
    ).toBeTrue();
    // A wake before the backoff is over starts nothing.
    expect(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'recovery',
      }),
    ).toBeNull();
    const [saved] = await required(handle)
      .db.select({ state: job.state })
      .from(job)
      .where(eq(job.id, chat.id));
    expect(saved?.state).toBe('queued');
  });
});
