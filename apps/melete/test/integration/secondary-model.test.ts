/**
 * The secondary model, end to end on Postgres: set by the owner in Settings,
 * kept across a restart, taken by short side calls about work in the owner's
 * spaces and, when switched on, by scheduled work there. Chats and the action
 * reviewer stay where they were, a member's work never follows anyone else's
 * setting, and a private conversation still stays on the local model.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { configuredReviewGateway } from '../../src/broker/review-gateway.ts';
import type { ReviewInput } from '../../src/broker/reviewer.ts';
import { loadEnv } from '../../src/env.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import { providersFromEnv } from '../../src/gateway/providers.ts';
import { NO_ROUTING } from '../../src/gateway/routing.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { configuredMemoryGateway } from '../../src/memory/gateway.ts';
import { PostgresPrivacyStore, PrivacyRouter } from '../../src/privacy/index.ts';
import { updateSettings } from '../../src/privacy/routes.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const describeWithDb = handle && queue ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';

const PRIMARY = 'accounts/fireworks/models/deepseek-v4p1-flash';
const FAST = 'accounts/fireworks/models/fixture-fast';
const SMALL = 'accounts/fireworks/models/fixture-small';
const ENV = {
  FIREWORKS_API_KEY: 'fw-fixture-key-5e6f',
  MELETE_MODEL_FAST: `fireworks/${FAST}`,
};

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

// biome-ignore lint/suspicious/noExplicitAny: test bodies are asserted field by field.
type Json = Record<string, any>;

/** One process of the service: its own settings reader over the shared database. */
function service(extra: Record<string, string> = {}) {
  const env = loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: masterKey, ...ENV, ...extra });
  const settings = new ModelSettingsService({ db: database().db, env });
  const built = createApp({
    env,
    db: database().db,
    sql: database().sql,
    modelSettings: settings,
    checkDatabase: async () => 'ok',
  });
  return {
    env,
    settings,
    async call(path: string, cookie: string, init: RequestInit = {}) {
      const response = await built.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
    },
    request: built.request.bind(built),
  };
}

const sessionOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? 'missing';
const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });

async function people(api: ReturnType<typeof service>) {
  const setup = await api.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  expect(setup.status).toBe(201);
  const owner = sessionOf(setup);
  const made = await api.call('/principals', owner, {
    method: 'POST',
    body: JSON.stringify({ email: 'member@example.test', password }),
  });
  expect(made.status).toBe(201);
  const login = await api.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', password }),
  });
  expect(login.status).toBe(200);
  const sql = database().sql;
  const [ownerRow] = await sql`select id from principal where email = 'owner@example.test'`;
  const [memberRow] = await sql`select id from principal where email = 'member@example.test'`;
  const [space] = await sql`select id from space where owner_principal_id = ${ownerRow?.id}
    order by created_at limit 1`;
  const [memberSpace] = await sql`select id from space where owner_principal_id = ${memberRow?.id}
    order by created_at limit 1`;
  return {
    owner: { cookie: owner, id: String(ownerRow?.id) },
    member: {
      cookie: sessionOf(login),
      id: String(memberRow?.id),
      spaceId: String(memberSpace?.id),
    },
    spaceId: String(space?.id),
  };
}

/** A stand-in provider that records where each request went and for which model. */
function recordingProvider() {
  const reached: { host: string; model: unknown }[] = [];
  const fetch = async (request: Request) => {
    const body = (await request.json()) as { model?: unknown };
    reached.push({ host: new URL(request.url).host, model: body.model });
    return Response.json({
      id: 'chat_1',
      object: 'chat.completion',
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: '{"items":[]}' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
    });
  };
  return { reached, fetch };
}

/** Memory reading a message for this person: one of the short side calls. */
async function sideCall(
  api: ReturnType<typeof service>,
  personId: string,
  spaceId: string,
  router = new PrivacyRouter({ store: new PostgresPrivacyStore(database().sql) }),
) {
  const provider = recordingProvider();
  const memory = await configuredMemoryGateway(database().sql, api.env, undefined, router, {
    settings: api.settings,
    fetch: provider.fetch,
  });
  if (!memory) throw new Error('memory extraction is off');
  try {
    await memory.gateway
      .chat(
        {
          messages: [
            { role: 'system', content: 'Return JSON.' },
            { role: 'user', content: '{}' },
          ],
          max_tokens: 100,
          signal: AbortSignal.timeout(10_000),
        },
        {
          ownerId: personId,
          spaceId,
          workId: `work-${randomBytes(6).toString('hex')}`,
          sourceJobId: null,
        },
      )
      .catch(() => 'refused');
  } finally {
    await memory.close();
  }
  return provider.reached;
}

/** The model an attempt of a new job of this kind, for this person, is claimed on. */
async function attemptModel(
  api: ReturnType<typeof service>,
  spaceId: string,
  personId: string,
  kind: 'chat' | 'routine' | 'responsibility',
  options: { trigger?: boolean } = {},
) {
  if (!queue) throw new Error('the job queue is unavailable');
  const jobs = new JobService(database().db, queue.boss);
  const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
    key: 'secondary-model-signing-key-32-chars!',
    scopes: [],
    resolveModel: (tx, row) => api.settings.routedChoice(NO_ROUTING, tx, row),
  });
  const job = await jobs.create({ space_id: spaceId, title: kind, objective: 'model check' });
  const sql = database().sql;
  await sql`update job set kind = ${kind}, principal_id = ${personId} where id = ${job.id}`;
  if (options.trigger)
    await sql`insert into trigger (id, job_id, kind, spec)
      values (${newId('trg')}, ${job.id}, 'schedule', ${JSON.stringify({ kind: 'schedule' })}::jsonb)`;
  const claimed = await runner.claim({
    job_id: job.id,
    expected_epoch: job.leaseEpoch,
    expected_version: job.stateVersion,
    reason: 'created',
  });
  if (!claimed) throw new Error('attempt was not claimed');
  return claimed.bundle.model.model;
}

describeWithDb('a secondary model beside the primary', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('with no secondary set, every kind of work runs as it did', async () => {
    const api = service();
    const { owner, spaceId } = await people(api);
    const view = await api.call('/model-settings', owner.cookie);
    expect(view.body.secondary).toEqual({
      model: null,
      uses: { side_tasks: 'secondary', scheduled: 'primary' },
      can_edit: true,
      leaves_local_primary: false,
      updated_at: null,
    });
    // Side calls keep the operator's fast model; jobs of every kind the primary.
    expect(await sideCall(api, owner.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: FAST },
    ]);
    expect(await attemptModel(api, spaceId, owner.id, 'chat')).toBe(PRIMARY);
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(PRIMARY);
    expect(await attemptModel(api, spaceId, owner.id, 'responsibility', { trigger: true })).toBe(
      PRIMARY,
    );
    // Choosing which work would use it changes nothing while none is set.
    await api.call('/model-settings/secondary/uses', owner.cookie, put({ scheduled: 'secondary' }));
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(PRIMARY);
    expect(await sideCall(api, owner.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: FAST },
    ]);
  }, 60_000);

  test('a side call uses the secondary, a chat never does, and scheduled work only when switched', async () => {
    const api = service();
    const { owner, spaceId } = await people(api);
    const refused = await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'anthropic', model: 'claude-fixture' }),
    );
    expect(refused.status).toBe(409);
    const chosen = await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    expect(chosen.status).toBe(200);
    expect(chosen.body.secondary.model).toEqual({
      provider: 'fireworks',
      model: SMALL,
      connected: true,
    });
    expect(chosen.body.active.model).toBe(PRIMARY);

    // The person's secondary wins over the operator's fast model for side calls.
    expect(await sideCall(api, owner.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: SMALL },
    ]);
    expect(await attemptModel(api, spaceId, owner.id, 'chat')).toBe(PRIMARY);
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(PRIMARY);

    const switched = await api.call(
      '/model-settings/secondary/uses',
      owner.cookie,
      put({ scheduled: 'secondary' }),
    );
    expect(switched.body.secondary.uses).toEqual({
      side_tasks: 'secondary',
      scheduled: 'secondary',
    });
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(SMALL);
    expect(await attemptModel(api, spaceId, owner.id, 'responsibility', { trigger: true })).toBe(
      SMALL,
    );
    // One-off work with no trigger, and chats, stay on the primary.
    expect(await attemptModel(api, spaceId, owner.id, 'responsibility')).toBe(PRIMARY);
    expect(await attemptModel(api, spaceId, owner.id, 'chat')).toBe(PRIMARY);

    // Side calls can be kept on the primary too; removing the secondary undoes it all.
    await api.call('/model-settings/secondary/uses', owner.cookie, put({ side_tasks: 'primary' }));
    expect(await sideCall(api, owner.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: FAST },
    ]);
    const removed = await api.call('/model-settings/secondary', owner.cookie, { method: 'DELETE' });
    expect(removed.body.secondary.model).toBeNull();
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(PRIMARY);
  }, 60_000);

  test('the secondary survives a restart and is only ever used for its own person', async () => {
    const first = service();
    const { owner, member, spaceId } = await people(first);
    await first.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    await first.call(
      '/model-settings/secondary/uses',
      owner.cookie,
      put({ scheduled: 'secondary' }),
    );

    // A new process reads the same setting from the database.
    const restarted = service();
    const mine = await restarted.call('/model-settings', owner.cookie);
    expect(mine.body.secondary).toMatchObject({
      model: { provider: 'fireworks', model: SMALL },
      uses: { side_tasks: 'secondary', scheduled: 'secondary' },
    });
    expect(await sideCall(restarted, owner.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: SMALL },
    ]);
    expect(await attemptModel(restarted, spaceId, owner.id, 'routine')).toBe(SMALL);

    // Another person sees none of it, and their work never runs on it.
    const theirs = await restarted.call('/model-settings', member.cookie);
    expect(theirs.body.secondary).toMatchObject({ model: null, can_edit: false });
    expect(await sideCall(restarted, member.id, member.spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: FAST },
    ]);
    expect(await attemptModel(restarted, member.spaceId, member.id, 'routine')).toBe(PRIMARY);
  }, 60_000);

  test('only the owner sets a secondary, and work follows its space owner, never who asked', async () => {
    const api = service();
    const { owner, member, spaceId } = await people(api);
    const MEMBER = 'accounts/fireworks/models/fixture-member';
    // Choosing a model on the installation's keys is the owner's, as for the primary.
    for (const [path, body] of [
      ['/model-settings/secondary', { provider: 'fireworks', model: MEMBER }],
      ['/model-settings/secondary/uses', { side_tasks: 'secondary' }],
    ] as const) {
      const refused = await api.call(path, member.cookie, put(body));
      expect(refused.status).toBe(403);
    }
    expect(
      (await api.call('/model-settings/secondary', member.cookie, { method: 'DELETE' })).status,
    ).toBe(403);
    await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    // A row for a member, however it came to be, is never used.
    await database()
      .sql`insert into model_secondary (principal_id, provider, model, side_tasks, scheduled)
      values (${member.id}, 'fireworks', ${MEMBER}, 'secondary', 'secondary')`;
    expect((await api.call('/model-settings', member.cookie)).body.secondary.model).toBeNull();
    // Usage does not label it either.
    expect((await api.settings.roles(member.id)).secondary).toBeNull();
    expect((await api.settings.roles(owner.id)).secondary).toEqual({
      provider: 'fireworks',
      model: SMALL,
    });

    // The member speaking in the owner's space: the owner's settings, not the member's.
    expect(await sideCall(api, member.id, spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: SMALL },
    ]);
    // In the member's own space nobody's secondary applies.
    expect(await sideCall(api, member.id, member.spaceId)).toEqual([
      { host: 'api.fireworks.ai', model: FAST },
    ]);
    expect(await attemptModel(api, member.spaceId, member.id, 'routine')).toBe(PRIMARY);
  }, 60_000);

  test('the action reviewer stays on its own model whatever the secondary is', async () => {
    const api = service();
    const { owner, spaceId } = await people(api);
    await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    expect((await api.call('/model-settings', owner.cookie)).body.secondary.uses.side_tasks).toBe(
      'secondary',
    );
    const reached: unknown[] = [];
    const provider = async (request: Request) => {
      const body = (await request.json()) as {
        model?: unknown;
        messages?: { role: string; content: string }[];
      };
      reached.push(body.model);
      const system = (body.messages ?? []).find((m) => m.role === 'system');
      const nonce = /The review_id must be exactly (\w+)\./.exec(system?.content ?? '')?.[1];
      const text = JSON.stringify({
        review_id: nonce,
        verdict: 'approve',
        risk: 'low',
        reason: 'It renames the task as asked.',
      });
      return Response.json({
        id: 'chat_1',
        object: 'chat.completion',
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
      });
    };
    const jobId = newId('job');
    await database().sql`insert into job (id, space_id, title, objective, principal_id)
      values (${jobId}, ${spaceId}, 'Tasks', 'Rename a task', ${owner.id})`;
    const review = await configuredReviewGateway(
      api.env,
      new PrivacyRouter({ store: new PostgresPrivacyStore(database().sql) }),
      undefined,
      undefined,
      { settings: api.settings, fetch: provider },
    );
    if (!review) throw new Error('auto-review is off');
    const input: ReviewInput = {
      action: {
        tool: 'tasks.rename',
        description: 'Rename a task',
        effect: 'write_reversible',
        app: 'Tasks',
        payload: { title: 'Groceries' },
      },
      instruction: 'Rename my task to Groceries',
      recent: [],
      origins: [],
    };
    try {
      const verdict = await review.reviewer.review(input, AbortSignal.timeout(10_000), {
        spaceId,
        jobId,
      });
      expect(verdict).toMatchObject({ verdict: 'approve', model: `fireworks/${FAST}` });
      expect(reached).toEqual([FAST]);
    } finally {
      await review.close();
    }
  }, 60_000);

  test('a private conversation stays on the local model whatever the secondary is', async () => {
    const api = service();
    const { owner, spaceId } = await people(api);
    await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    const router = new PrivacyRouter({
      store: new PostgresPrivacyStore(database().sql, () => 'a'.repeat(64)),
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    await updateSettings(router, spaceId, {
      private_space: true,
      local_model: { base_url: 'http://127.0.0.1:11434/v1', model: 'llama3.3' },
    });
    expect(await sideCall(api, owner.id, spaceId, router)).toEqual([
      { host: '127.0.0.1:11434', model: 'llama3.3' },
    ]);
  }, 60_000);

  test('scheduled work moved off a local primary is flagged, and still redacted on its way out', async () => {
    // The primary runs on this machine; the secondary is a cloud model.
    const api = service({
      MELETE_DEFAULT_PROVIDER: 'openai-compatible',
      MELETE_DEFAULT_MODEL: 'llama3.3',
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENAI_COMPAT_API_KEY: 'local-fixture-key-1a2b',
    });
    const { owner, spaceId } = await people(api);
    await api.call(
      '/model-settings/secondary',
      owner.cookie,
      put({ provider: 'fireworks', model: SMALL }),
    );
    const kept = await api.call('/model-settings', owner.cookie);
    expect(kept.body.secondary).toMatchObject({
      uses: { scheduled: 'primary' },
      leaves_local_primary: true,
    });
    // Side calls stay on the local primary; scheduled work only once switched.
    expect(await sideCall(api, owner.id, spaceId)).toEqual([
      { host: '127.0.0.1:11434', model: 'llama3.3' },
    ]);
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe('llama3.3');
    await api.call('/model-settings/secondary/uses', owner.cookie, put({ scheduled: 'secondary' }));
    expect(await attemptModel(api, spaceId, owner.id, 'routine')).toBe(SMALL);

    // The routine's request to the cloud secondary still passes the privacy router's redaction.
    const [routine] = await database().sql`select id from job where space_id = ${spaceId}
      and kind = 'routine' order by created_at desc limit 1`;
    const router = new PrivacyRouter({
      store: new PostgresPrivacyStore(database().sql, () => 'a'.repeat(64)),
      resolve: async () => [{ address: '93.184.216.34' }],
    });
    const cloud = providersFromEnv(api.env as unknown as Record<string, string | undefined>).find(
      (entry) => entry.name === 'fireworks',
    );
    if (!cloud) throw new Error('fireworks is not configured');
    const prepared = await router.prepare({
      principal: {
        jobId: String(routine?.id),
        attemptId: 'att_secondary',
        epoch: 1,
        revision: 1,
        maxRequests: 1,
        maxTokens: 100,
        allowedModels: [{ provider: 'fireworks', model: SMALL }],
        privacy: { kind: 'job' },
      },
      provider: cloud,
      protocol: 'chat/completions',
      body: {
        model: SMALL,
        messages: [{ role: 'user', content: 'Email the summary to jamie.davis@fastmail.example' }],
      },
    });
    expect(prepared.route).toBe('cloud');
    expect(JSON.stringify(prepared.body)).not.toContain('jamie.davis@fastmail.example');
    expect(JSON.stringify(prepared.body)).toContain('⟦EMAIL_');
  }, 60_000);
});
