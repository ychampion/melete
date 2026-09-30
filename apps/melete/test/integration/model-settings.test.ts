import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { configuredReviewGateway } from '../../src/broker/review-gateway.ts';
import type { ReviewInput } from '../../src/broker/reviewer.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from '../../src/companies/fixtures.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { MemoryCompanyStore } from '../../src/companies/repository.ts';
import { runScan } from '../../src/companies/scan.ts';
import { configuredExtractor } from '../../src/companies/service.ts';
import { loadEnv } from '../../src/env.ts';
import { ModelSettingsService } from '../../src/gateway/model-settings.ts';
import { providersFromEnv } from '../../src/gateway/providers.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { configuredMemoryGateway } from '../../src/memory/gateway.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const describeWithDb = handle && queue ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';
/** Fixture keys only; each is searched for in every answer and every table. */
const ANTHROPIC_KEY = 'sk-ant-fixture-key-7a3f';
const COMPATIBLE_KEY = 'compat-fixture-key-9b1c';
const FIREWORKS_KEY = 'fw-fixture-key-2c4d';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

// biome-ignore lint/suspicious/noExplicitAny: test bodies are asserted field by field.
type Json = Record<string, any>;
let answered: string[] = [];

function app(env: Record<string, string> = {}, fetch?: (request: Request) => Promise<Response>) {
  const settings: Record<string, string> = {
    NODE_ENV: 'test',
    MELETE_MASTER_KEY: masterKey,
    ...env,
  };
  // An empty value stands for a server started without one.
  if (!settings.MELETE_MASTER_KEY) delete settings.MELETE_MASTER_KEY;
  const loaded = loadEnv(settings);
  const service = new ModelSettingsService({ db: database().db, env: loaded, fetch });
  const built = createApp({
    env: loaded,
    db: database().db,
    sql: database().sql,
    modelSettings: service,
    checkDatabase: async () => 'ok',
  });
  return {
    env: loaded,
    settings: service,
    async call(path: string, cookie: string, init: RequestInit = {}) {
      const response = await built.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      answered.push(text);
      return { status: response.status, body: text ? (JSON.parse(text) as Json) : {} };
    },
    request: built.request.bind(built),
  };
}

const sessionOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? 'missing';

async function owner(api: ReturnType<typeof app>) {
  const setup = await api.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  expect(setup.status).toBe(201);
  return sessionOf(setup);
}

async function member(api: ReturnType<typeof app>, ownerCookie: string) {
  const made = await api.call('/principals', ownerCookie, {
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
  return sessionOf(login);
}

const put = (body: unknown): RequestInit => ({ method: 'PUT', body: JSON.stringify(body) });
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function everythingStored(): Promise<string> {
  const sql = database().sql;
  const tables = await sql<{ name: string }[]>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'`;
  const rows: string[] = [];
  for (const { name } of tables) rows.push(JSON.stringify(await sql`select * from ${sql(name)}`));
  return rows.join('\n');
}

describeWithDb('the model, connected in the app', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
    answered = [];
  }, 15_000);

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('the owner stores a key sealed, sees only its last four, and no answer or table carries it', async () => {
    const api = app();
    const cookie = await owner(api);
    const before = await api.call('/model-settings', cookie);
    expect(before.status).toBe(200);
    expect(before.body.can_edit).toBe(true);
    expect(before.body.can_store_keys).toBe(true);
    expect(before.body.active).toMatchObject({
      provider: 'fireworks',
      source: 'operator',
      connected: false,
    });

    const saved = await api.call(
      '/model-settings/keys/anthropic',
      cookie,
      put({ api_key: ANTHROPIC_KEY }),
    );
    expect(saved.status).toBe(200);
    const anthropic = saved.body.providers.find((p: Json) => p.provider === 'anthropic');
    expect(anthropic).toMatchObject({
      key: { state: 'set', last_four: '7a3f' },
      connected: true,
    });

    const compatible = await api.call(
      '/model-settings/keys/openai-compatible',
      cookie,
      put({ api_key: COMPATIBLE_KEY, base_url: 'http://models.internal:8000/v1' }),
    );
    expect(
      compatible.body.providers.find((p: Json) => p.provider === 'openai-compatible'),
    ).toMatchObject({
      base_url: 'http://models.internal:8000/v1/',
      base_url_source: 'app',
      connected: true,
    });

    // Round trip: the gateway's per-call providers open the sealed key.
    const providers = await api.settings.providers(providersFromEnv({}));
    const opened = await providers.find((p) => p.name === 'anthropic')?.signedIn?.current();
    expect(opened?.token).toBe(ANTHROPIC_KEY);
    const endpoint = providers.find((p) => p.name === 'openai-compatible');
    expect(endpoint?.baseUrl).toBe('http://models.internal:8000/v1/');
    expect((await endpoint?.signedIn?.current())?.token).toBe(COMPATIBLE_KEY);

    // The box is bound to its provider: moved onto another provider's row, it does not open.
    await database().sql`delete from model_provider_key where provider = 'openai-compatible'`;
    await database()
      .sql`update model_provider_key set provider = 'openai' where provider = 'anthropic'`;
    const moved = (await api.settings.providers(providersFromEnv({}))).find(
      (p) => p.name === 'openai',
    );
    await expect(moved?.signedIn?.current()).rejects.toThrow('Secret unavailable');

    const stored = await everythingStored();
    for (const key of [ANTHROPIC_KEY, COMPATIBLE_KEY]) {
      expect(stored).not.toContain(key);
      expect(answered.join('\n')).not.toContain(key);
    }
  });

  test('a member can see the active model but cannot change or test anything', async () => {
    let called = false;
    const api = app({}, async () => {
      called = true;
      return Response.json({ data: [] });
    });
    const ownerCookie = await owner(api);
    const memberCookie = await member(api, ownerCookie);
    const seen = await api.call('/model-settings', memberCookie);
    expect(seen.status).toBe(200);
    expect(seen.body.can_edit).toBe(false);
    for (const [path, init] of [
      ['/model-settings/keys/anthropic', put({ api_key: ANTHROPIC_KEY })],
      ['/model-settings/keys/anthropic', { method: 'DELETE' }],
      ['/model-settings/test', post({ provider: 'anthropic', api_key: ANTHROPIC_KEY })],
      ['/model-settings/default', put({ provider: 'anthropic', model: 'claude-fixture' })],
      ['/model-settings/default', { method: 'DELETE' }],
    ] as const) {
      const refused = await api.call(path, memberCookie, init);
      expect([path, refused.status, refused.body.error?.code]).toEqual([
        path,
        403,
        'owner_required',
      ]);
    }
    expect(called).toBe(false);
    expect(await database().sql`select * from model_provider_key`).toHaveLength(0);
    // Signed out, nothing is readable at all.
    expect((await api.call('/model-settings', '')).status).toBe(401);
  });

  test('a key the environment sets wins, is shown as the operator’s, and cannot be replaced', async () => {
    const api = app({ ANTHROPIC_API_KEY: 'operator-anthropic-key' });
    const cookie = await owner(api);
    const refused = await api.call(
      '/model-settings/keys/anthropic',
      cookie,
      put({ api_key: ANTHROPIC_KEY }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('set_by_operator');
    const view = await api.call('/model-settings', cookie);
    expect(view.body.providers.find((p: Json) => p.provider === 'anthropic')).toMatchObject({
      key: { state: 'operator', last_four: null },
      connected: true,
    });
    expect(answered.join('\n')).not.toContain('operator-anthropic-key');
  });

  test('without the master key a key is refused rather than stored in the clear', async () => {
    const api = app({ MELETE_MASTER_KEY: '' });
    const cookie = await owner(api);
    const view = await api.call('/model-settings', cookie);
    expect(view.body.can_store_keys).toBe(false);
    const refused = await api.call(
      '/model-settings/keys/anthropic',
      cookie,
      put({ api_key: ANTHROPIC_KEY }),
    );
    expect(refused.status).toBe(503);
    expect(await database().sql`select * from model_provider_key`).toHaveLength(0);
  });

  test('the test call reaches the provider with the saved key and maps a refusal', async () => {
    const seen: Request[] = [];
    let answer = Response.json({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] });
    const api = app({}, async (request) => {
      seen.push(request);
      return answer;
    });
    const cookie = await owner(api);
    await api.call('/model-settings/keys/anthropic', cookie, put({ api_key: ANTHROPIC_KEY }));
    const ok = await api.call('/model-settings/test', cookie, post({ provider: 'anthropic' }));
    expect(ok.body).toMatchObject({ ok: true, models: ['claude-a', 'claude-b'] });
    expect(seen[0]?.headers.get('x-api-key')).toBe(ANTHROPIC_KEY);
    answer = new Response('{"error":"invalid x-api-key"}', { status: 401 });
    const refused = await api.call('/model-settings/test', cookie, post({ provider: 'anthropic' }));
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ ok: false, code: 'key_refused', status: 401 });
    expect(answered.join('\n')).not.toContain(ANTHROPIC_KEY);
  });

  test('a model chosen in the app is what the next attempt runs on, without a restart', async () => {
    const api = app();
    const cookie = await owner(api);
    const refused = await api.call(
      '/model-settings/default',
      cookie,
      put({ provider: 'anthropic', model: 'claude-fixture' }),
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('model_not_connected');

    if (!queue) throw new Error('the job queue is unavailable');
    const jobs = new JobService(database().db, queue.boss);
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'model-settings-signing-key-32-chars!',
      scopes: [],
      resolveModel: (tx) => api.settings.activeChoice(tx),
    });
    const [space] = await database().sql`select id from space limit 1`;
    const claim = async (title: string) => {
      const job = await jobs.create({ space_id: space?.id, title, objective: 'model check' });
      const claimed = await runner.claim({
        job_id: job.id,
        expected_epoch: job.leaseEpoch,
        expected_version: job.stateVersion,
        reason: 'created',
      });
      if (!claimed) throw new Error('attempt was not claimed');
      const [row] = await database()
        .sql`select provider, model from attempt where id = ${claimed.bundle.attempt.id}`;
      return { bundle: claimed.bundle.model, row };
    };

    const first = await claim('Before');
    expect(first.bundle).toMatchObject({
      provider: 'fireworks',
      model: 'accounts/fireworks/models/deepseek-v4p1-flash',
    });

    await api.call('/model-settings/keys/anthropic', cookie, put({ api_key: ANTHROPIC_KEY }));
    const chosen = await api.call(
      '/model-settings/default',
      cookie,
      put({ provider: 'anthropic', model: 'claude-fixture' }),
    );
    expect(chosen.status).toBe(200);
    expect(chosen.body.active).toMatchObject({
      provider: 'anthropic',
      model: 'claude-fixture',
      source: 'app',
      connected: true,
    });

    const second = await claim('After');
    expect(second.bundle).toMatchObject({ provider: 'anthropic', model: 'claude-fixture' });
    // The gateway authorizes the attempt's own row, so it now admits the new model.
    expect(second.row).toMatchObject({ provider: 'anthropic', model: 'claude-fixture' });

    const cleared = await api.call('/model-settings/default', cookie, { method: 'DELETE' });
    expect(cleared.body.active).toMatchObject({ provider: 'fireworks', source: 'operator' });
    expect((await claim('Cleared')).bundle.provider).toBe('fireworks');
  }, 30_000);

  test('memory reads and the companies scan use the key and model connected in the app', async () => {
    // No provider key in the environment: the app is the only place one is set.
    const api = app();
    const cookie = await owner(api);
    const reached: { host: string; authorization: string | null; model: unknown }[] = [];
    const provider = async (request: Request) => {
      const body = (await request.json()) as { model?: unknown };
      reached.push({
        host: new URL(request.url).host,
        authorization: request.headers.get('authorization'),
        model: body.model,
      });
      // One answer serves both readers: memory reads it as an empty reply, a scan as no items.
      const text = JSON.stringify({ items: [] });
      return request.url.endsWith('/responses')
        ? Response.json({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            model: body.model,
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
            ],
            usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 },
          })
        : Response.json({
            id: 'chat_1',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text } }],
            usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
          });
    };
    const memory = await configuredMemoryGateway(database().sql, api.env, undefined, {
      settings: api.settings,
      fetch: provider,
    });
    if (!memory) throw new Error('memory extraction is off');
    const companies = configuredExtractor(api.env, undefined, api.settings, provider);
    const read = (workId: string) =>
      memory.gateway.chat(
        {
          messages: [
            { role: 'system', content: 'Return JSON.' },
            { role: 'user', content: '{}' },
          ],
          max_tokens: 100,
          signal: AbortSignal.timeout(10_000),
        },
        { ownerId: 'own_model_settings', spaceId: 'sp_model_settings', workId },
      );
    const scan = (spaceId: string) =>
      runScan({
        store: new MemoryCompanyStore(),
        mailbox: fixtureMailbox(fixtureMessages()),
        extractor: companies,
        owner: { spaceId, principalId: 'own_model_settings' },
        now: new Date(FIXTURE_REFERENCE),
      });
    try {
      // Before a key is connected nothing reaches a provider: memory is refused
      // and the scan reads with the scripted extractor.
      expect(await read('before').catch(() => 'refused')).toBe('refused');
      expect((await scan('sp_before')).status).toBe('done');
      expect(reached).toHaveLength(0);

      const model = 'accounts/fireworks/models/fixture-chosen';
      await api.call('/model-settings/keys/fireworks', cookie, put({ api_key: FIREWORKS_KEY }));
      const chosen = await api.call(
        '/model-settings/default',
        cookie,
        put({ provider: 'fireworks', model }),
      );
      expect(chosen.status).toBe(200);

      // Without a restart, the next memory read and the next scan use it.
      expect(await read('after')).toBe('{"items":[]}');
      expect(reached).toEqual([
        { host: 'api.fireworks.ai', authorization: `Bearer ${FIREWORKS_KEY}`, model },
      ]);
      const [ledger] = await database().sql`select provider, model from memory_model_calls
        where work_id = 'after'`;
      expect(ledger).toMatchObject({ provider: 'fireworks', model });

      expect((await scan('sp_after')).status).toBe('done');
      const scanned = reached.slice(1);
      expect(scanned.length).toBeGreaterThan(0);
      for (const call of scanned)
        expect(call).toEqual({
          host: 'api.fireworks.ai',
          authorization: `Bearer ${FIREWORKS_KEY}`,
          model,
        });
    } finally {
      await memory.close();
    }
    expect(answered.join('\n')).not.toContain(FIREWORKS_KEY);
  }, 30_000);

  test('the action reviewer uses the key and model connected in the app', async () => {
    // No provider key in the environment: the app is the only place one is set.
    const api = app();
    const cookie = await owner(api);
    const reached: { host: string; authorization: string | null; model: unknown }[] = [];
    const provider = async (request: Request) => {
      const body = (await request.json()) as {
        model?: unknown;
        messages?: { role: string; content: string }[];
        input?: { role: string; content: string }[];
      };
      reached.push({
        host: new URL(request.url).host,
        authorization: request.headers.get('authorization'),
        model: body.model,
      });
      const system = (body.messages ?? body.input ?? []).find((m) => m.role === 'system');
      const nonce = /The review_id must be exactly (\w+)\./.exec(system?.content ?? '')?.[1];
      const text = JSON.stringify({
        review_id: nonce,
        verdict: 'approve',
        risk: 'low',
        reason: 'It renames the task as asked.',
      });
      return request.url.endsWith('/responses')
        ? Response.json({
            id: 'resp_1',
            object: 'response',
            status: 'completed',
            model: body.model,
            output: [
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
            ],
            usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 },
          })
        : Response.json({
            id: 'chat_1',
            object: 'chat.completion',
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: text } }],
            usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
          });
    };
    const review = await configuredReviewGateway(api.env, undefined, undefined, {
      settings: api.settings,
      fetch: provider,
    });
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
    const ask = () =>
      review.reviewer.review(input, AbortSignal.timeout(10_000), {
        spaceId: 'sp_model_settings',
        jobId: 'job_model_settings',
      });
    try {
      // Before a key is connected nothing reaches a provider, and the action
      // would go to the person.
      expect(await ask()).toMatchObject({ verdict: 'none', failure: 'unavailable' });
      expect(reached).toHaveLength(0);

      const model = 'accounts/fireworks/models/fixture-chosen';
      await api.call('/model-settings/keys/fireworks', cookie, put({ api_key: FIREWORKS_KEY }));
      const chosen = await api.call(
        '/model-settings/default',
        cookie,
        put({ provider: 'fireworks', model }),
      );
      expect(chosen.status).toBe(200);

      // Without a restart, the next review goes to that model, with that key,
      // and the decision names the model that made it.
      expect(await ask()).toEqual({
        verdict: 'approve',
        risk: 'low',
        reason: 'It renames the task as asked.',
        model: `fireworks/${model}`,
      });
      expect(reached).toEqual([
        { host: 'api.fireworks.ai', authorization: `Bearer ${FIREWORKS_KEY}`, model },
      ]);
    } finally {
      await review.close();
    }
    expect(answered.join('\n')).not.toContain(FIREWORKS_KEY);
  }, 30_000);

  test('a compatible endpoint’s key only goes to the address it was saved for', async () => {
    const api = app();
    const cookie = await owner(api);
    await api.call(
      '/model-settings/keys/openai-compatible',
      cookie,
      put({ api_key: COMPATIBLE_KEY, base_url: 'http://models.internal:8000/v1' }),
    );

    // The operator later names a different endpoint, with no key of its own.
    const elsewhere = 'https://elsewhere.example/v1';
    const sent: Request[] = [];
    const moved = app({ OPENAI_COMPAT_BASE_URL: elsewhere }, async (request) => {
      sent.push(request);
      return Response.json({ data: [] });
    });
    const endpoints = (
      await moved.settings.providers(providersFromEnv({ OPENAI_COMPAT_BASE_URL: elsewhere }))
    ).filter((p) => p.name === 'openai-compatible');
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.baseUrl).toBe(`${elsewhere}/`);
    expect(endpoints[0]?.apiKey).toBeUndefined();
    expect(endpoints[0]?.signedIn).toBeUndefined();
    const view = await moved.call('/model-settings', cookie);
    expect(view.body.providers.find((p: Json) => p.provider === 'openai-compatible')).toMatchObject(
      {
        key: { state: 'unset' },
        base_url: `${elsewhere}/`,
        base_url_source: 'operator',
        connected: false,
      },
    );
    const tried = await moved.call(
      '/model-settings/test',
      cookie,
      post({ provider: 'openai-compatible' }),
    );
    expect(tried.body).toMatchObject({ ok: false, code: 'no_key' });
    expect(sent).toHaveLength(0);

    // A key saved while the operator names the address is bound to that address.
    const second = 'compat-second-fixture-4e2a';
    const saved = await moved.call(
      '/model-settings/keys/openai-compatible',
      cookie,
      put({ api_key: second }),
    );
    expect(saved.status).toBe(200);
    const [row] = await database()
      .sql`select base_url from model_provider_key where provider = 'openai-compatible'`;
    expect(row?.base_url).toBe(`${elsewhere}/`);
    const bound = (
      await moved.settings.providers(providersFromEnv({ OPENAI_COMPAT_BASE_URL: elsewhere }))
    ).find((p) => p.name === 'openai-compatible');
    expect((await bound?.signedIn?.current())?.token).toBe(second);

    const third = 'https://third.example/v1';
    const again = app({ OPENAI_COMPAT_BASE_URL: third });
    const unbound = (
      await again.settings.providers(providersFromEnv({ OPENAI_COMPAT_BASE_URL: third }))
    ).find((p) => p.name === 'openai-compatible');
    expect(unbound?.signedIn).toBeUndefined();
  });
});
