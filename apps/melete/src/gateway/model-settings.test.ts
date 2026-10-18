import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { UNREACHABLE } from '../connectors/public-fetch.ts';
import type { Database } from '../db/client.ts';
import { loadEnv } from '../env.ts';
import { defaultPrivacyRouter } from '../privacy/index.ts';
import { createModelGateway, type GatewayProvider, providersFromEnv } from './index.ts';
import { checkedBaseUrl, ModelSettingsService, modelIds } from './model-settings.ts';
import type { GatewaySettlement } from './types.ts';

/** No keys stored and no model chosen: the tests here never reach the database. */
const emptyDb = {
  select: () => ({ from: () => Object.assign(Promise.resolve([]), { where: async () => [] }) }),
} as unknown as Database;

function service(
  fetch: (request: Request) => Promise<Response>,
  env: Record<string, string> = {},
  timeoutMs?: number,
) {
  return new ModelSettingsService({
    db: emptyDb,
    env: loadEnv({ NODE_ENV: 'test', ...env }),
    fetch,
    timeoutMs,
  });
}

const status = (code: number) => async () => new Response('{"error":"no"}', { status: code });

describe('testing a model connection', () => {
  test('a working key lists the provider’s models, sorted, and sends the key the provider expects', async () => {
    const seen: Request[] = [];
    const openai = await service(async (request) => {
      seen.push(request);
      return Response.json({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] });
    }).test({ provider: 'openai', api_key: 'sk-test-openai-1234' });
    expect(openai).toMatchObject({ ok: true, models: ['gpt-a', 'gpt-b'] });
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-test-openai-1234');
    expect(seen[0]?.redirect).toBe('manual');

    const anthropic = await service(async (request) => {
      seen.push(request);
      return Response.json({ data: [{ id: 'claude-fixture' }] });
    }).test({ provider: 'anthropic', api_key: 'sk-ant-test-5678' });
    expect(anthropic).toMatchObject({ ok: true, models: ['claude-fixture'] });
    expect(seen[1]?.url).toBe('https://api.anthropic.com/v1/models');
    expect(seen[1]?.headers.get('x-api-key')).toBe('sk-ant-test-5678');
    expect(seen[1]?.headers.get('authorization')).toBeNull();

    // Google's list names each model `models/<id>`; the id is what a call takes.
    const google = await service(async () =>
      Response.json({ data: [{ id: 'models/gemini-fixture' }] }),
    ).test({ provider: 'google', api_key: 'google-test-key' });
    expect(google).toMatchObject({ ok: true, models: ['gemini-fixture'] });
  });

  test('Anthropic’s test and model list go through the gateway ANTHROPIC_BASE_URL names', async () => {
    const seen: Request[] = [];
    const env = { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4610', ANTHROPIC_API_KEY: 'operator-key' };
    const settings = new ModelSettingsService({
      db: emptyDb,
      env: loadEnv({ NODE_ENV: 'test', ...env }),
      fetch: async (request) => {
        seen.push(request);
        return Response.json({ data: [{ id: 'claude-fixture' }] });
      },
      // The operator's address goes as it is, like OPENAI_COMPAT_BASE_URL: it is
      // never resolved and pinned as an address chosen in the app would be.
      resolve: async () => {
        throw new Error('the operator’s address is not resolved here');
      },
    });
    expect(await settings.test({ provider: 'anthropic' })).toMatchObject({
      ok: true,
      models: ['claude-fixture'],
    });
    expect(seen.map((request) => request.url)).toEqual(['http://127.0.0.1:4610/v1/models']);
    expect(seen[0]?.headers.get('x-api-key')).toBe('operator-key');
    // A typed address is only ever the OpenAI-compatible endpoint's.
    await settings.test({
      provider: 'anthropic',
      api_key: 'sk-ant-typed',
      base_url: 'https://elsewhere.example.net',
    });
    expect(seen[1]?.url).toBe('http://127.0.0.1:4610/v1/models');
    // The privacy checks and the gateway are told the same address.
    expect(await settings.providerAddress('anthropic')).toBe('http://127.0.0.1:4610/v1/');
    expect(await service(async () => Response.json({})).providerAddress('anthropic')).toBe(
      'https://api.anthropic.com/v1/',
    );
  });

  test('each refusal answers with its own plain sentence and the provider’s status', async () => {
    const cases: [number, string, RegExp][] = [
      [401, 'key_refused', /did not accept this key \(HTTP 401\)/],
      [403, 'key_refused', /did not accept this key \(HTTP 403\)/],
      [404, 'not_found', /HTTP 404/],
      [429, 'rate_limited', /Wait a minute/],
      [500, 'provider_error', /answered with an error \(HTTP 500\)/],
      [302, 'not_found', /HTTP 302/],
    ];
    for (const [code, expected, message] of cases) {
      const result = await service(status(code)).test({
        provider: 'fireworks',
        api_key: 'fw-test-key-0000',
      });
      expect(result).toMatchObject({ ok: false, code: expected, status: code });
      if (result.ok) throw new Error('expected a failure');
      expect(result.message).toMatch(message);
      expect(result.message).not.toContain('fw-test-key');
    }
  });

  test('a compatible endpoint that is not there says to check the address', async () => {
    const seen: string[] = [];
    const result = await service(async (request) => {
      seen.push(request.url);
      return new Response('not found', { status: 404 });
    }).test({
      provider: 'openai-compatible',
      api_key: 'local-key-1234',
      base_url: 'http://models.internal:8000/v1/',
    });
    expect(seen).toEqual(['http://models.internal:8000/v1/models']);
    expect(result).toMatchObject({ ok: false, code: 'not_found', status: 404 });
    if (result.ok) throw new Error('expected a failure');
    expect(result.message).toContain('usually ends in /v1');
  });

  test('a provider that does not answer in time, or cannot be reached, is told apart', async () => {
    const slow = await service(() => new Promise<Response>(() => {}), {}, 50).test({
      provider: 'openai',
      api_key: 'sk-test-slow-0000',
    });
    expect(slow).toMatchObject({ ok: false, code: 'timeout', status: null });

    const down = await service(async () => {
      throw new TypeError('fetch failed');
    }).test({ provider: 'openai', api_key: 'sk-test-down-0000' });
    expect(down).toMatchObject({ ok: false, code: 'unreachable' });
    if (down.ok) throw new Error('expected a failure');
    expect(down.message).toContain('api.openai.com');
  });

  test('nothing is sent without a key, and an operator key never goes to a new address', async () => {
    let called = false;
    const record = async () => {
      called = true;
      return Response.json({ data: [] });
    };
    expect(await service(record).test({ provider: 'anthropic' })).toMatchObject({
      ok: false,
      code: 'no_key',
    });
    const operator = service(record, {
      OPENAI_COMPAT_BASE_URL: 'https://models.example.test/v1',
      OPENAI_COMPAT_API_KEY: 'operator-secret-key',
    });
    expect(
      await operator.test({
        provider: 'openai-compatible',
        base_url: 'https://elsewhere.example.test/v1',
      }),
    ).toMatchObject({ ok: false, code: 'no_key' });
    expect(called).toBe(false);
    // The operator's own address is tried with the operator's key.
    expect(await operator.test({ provider: 'openai-compatible' })).toMatchObject({ ok: true });
    expect(called).toBe(true);
  });

  test('an address with a query, credentials or another scheme is refused before any call', async () => {
    for (const address of [
      'ftp://models.example.test/v1',
      'https://user:pass@models.example.test/v1',
      'https://models.example.test/v1?key=1',
      'not an address',
    ]) {
      expect(
        await service(status(200)).test({
          provider: 'openai-compatible',
          api_key: 'k-12345678',
          base_url: address,
        }),
      ).toMatchObject({ ok: false, code: 'invalid_address' });
    }
    expect(checkedBaseUrl(' https://models.example.test/v1 ')).toBe(
      'https://models.example.test/v1/',
    );
  });

  test('model lists in either shape become ids, bounded in length', () => {
    expect(modelIds({ models: [{ name: 'models/a' }, { name: 'b' }] })).toEqual(['a', 'b']);
    expect(modelIds({ data: [{ id: 'x'.repeat(301) }, { id: 'ok' }, null, 3] })).toEqual(['ok']);
    expect(modelIds('nonsense')).toEqual([]);
  });
});

describe('the gateway reads its providers per call', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  test('a key connected after start-up is used by the next call, and redacted', async () => {
    let connected: string | null = null;
    const seen: (string | null)[] = [];
    const configured = providersFromEnv({});
    const server = createModelGateway({
      authenticate: async () => ({
        jobId: 'job',
        attemptId: 'att',
        privacy: { kind: 'job' as const },
        epoch: 1,
        revision: 1,
        maxRequests: 5,
        maxTokens: 5000,
        allowedModels: [{ provider: 'openai', model: 'fixture-chat' }],
      }),
      budget: { reserve: async () => ({ id: 'r' }), settle: async () => {} },
      privacy: defaultPrivacyRouter(),
      providers: configured,
      currentProviders: async (base): Promise<GatewayProvider[]> =>
        base.map((provider) =>
          provider.name === 'openai' && connected
            ? {
                ...provider,
                signedIn: {
                  current: async () => ({ token: connected ?? '', generation: 0, headers: {} }),
                  rejected: () => {},
                },
              }
            : provider,
        ),
      fetch: async (request) => {
        seen.push(request.headers.get('authorization'));
        return Response.json({
          model: 'fixture-chat',
          choices: [{ message: { role: 'assistant', content: `echo ${connected}` } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const call = () =>
      fetch(`http://127.0.0.1:${address.port}/providers/openai/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'cap',
        },
        body: JSON.stringify({ model: 'fixture-chat', max_tokens: 10, messages: [] }),
      });
    const before = await call();
    expect(before.status).toBe(503);
    expect(await before.text()).toContain('provider_key_unavailable');
    connected = 'sk-connected-in-app-9999';
    const after = await call();
    expect(after.status).toBe(200);
    const text = await after.text();
    expect(text).not.toContain('sk-connected-in-app');
    expect(seen).toEqual(['Bearer sk-connected-in-app-9999']);
  });

  test('a saved key the provider refuses is named a refused key, after one call', async () => {
    // The table of saved keys, kept in memory: what `saveKey` writes, the gateway reads.
    const stored: unknown[] = [];
    const db = {
      insert: () => ({
        values: (row: unknown) => ({
          onConflictDoUpdate: async () => {
            stored.splice(0, stored.length, row);
          },
        }),
      }),
      delete: () => ({ where: async () => {} }),
      select: () => ({
        from: () => Object.assign(Promise.resolve(stored), { where: async () => [] }),
      }),
    } as unknown as Database;
    const settings = new ModelSettingsService({
      db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: 'ab'.repeat(32) }),
      fetch: status(500),
    });
    await settings.saveKey('openai', 'owner', { api_key: 'sk-typed-in-app-4321' });
    const settled: GatewaySettlement[] = [];
    let calls = 0;
    const server = createModelGateway({
      authenticate: async () => ({
        jobId: 'job',
        attemptId: 'att',
        privacy: { kind: 'job' as const },
        epoch: 1,
        revision: 1,
        maxRequests: 5,
        maxTokens: 5000,
        allowedModels: [{ provider: 'openai', model: 'fixture-chat' }],
      }),
      budget: {
        reserve: async () => ({ id: 'r' }),
        settle: async (_reservation, settlement) => {
          settled.push(settlement);
        },
      },
      privacy: defaultPrivacyRouter(),
      providers: providersFromEnv({}),
      currentProviders: (configured) => settings.providers(configured),
      fetch: async (request) => {
        calls++;
        expect(request.headers.get('authorization')).toBe('Bearer sk-typed-in-app-4321');
        return new Response(
          '{"error":{"message":"Incorrect API key provided","code":"invalid_api_key"}}',
          { status: 401 },
        );
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP listener');
    const answer = await fetch(
      `http://127.0.0.1:${address.port}/providers/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'cap',
        },
        body: JSON.stringify({ model: 'fixture-chat', max_tokens: 10, messages: [] }),
      },
    );
    expect(answer.status).toBe(401);
    const text = await answer.text();
    expect(text).not.toContain('sk-typed-in-app');
    expect(JSON.parse(text).error.code).toBe('provider_key_refused');
    expect(settled).toMatchObject([{ failure: 'key_refused', httpStatus: 401 }]);
    expect(calls).toBe(1);
  });
});

describe('an Anthropic key saved in the app', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });
  const MASTER = 'ab'.repeat(32);
  const GATEWAY = 'http://127.0.0.1:4610';
  /** The table of saved keys, kept in memory and shared by the services below. */
  function keyTable() {
    const stored: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflictDoUpdate: async () => {
            stored.splice(0, stored.length, row);
          },
        }),
      }),
      delete: () => ({ where: async () => {} }),
      select: () => ({
        from: () => Object.assign(Promise.resolve(stored), { where: async () => [] }),
      }),
    } as unknown as Database;
    return { db, stored };
  }
  function atAddress(db: Database, env: Record<string, string> = {}) {
    const seen: Request[] = [];
    const settings = new ModelSettingsService({
      db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_MASTER_KEY: MASTER, ...env }),
      fetch: async (request) => {
        seen.push(request);
        return Response.json({ data: [{ id: 'claude-fixture' }] });
      },
    });
    const anthropic = async () =>
      (await settings.providers(providersFromEnv(env))).find(
        (provider) => provider.name === 'anthropic',
      );
    return { settings, seen, anthropic };
  }

  /** One agent turn on Anthropic, through a gateway that reads the saved keys. */
  async function turn(settings: ModelSettingsService, env: Record<string, string>) {
    const sent: { url: string; key: string | null }[] = [];
    const server = createModelGateway({
      authenticate: async () => ({
        jobId: 'job',
        attemptId: 'att',
        privacy: { kind: 'job' as const },
        epoch: 1,
        revision: 1,
        maxRequests: 5,
        maxTokens: 5000,
        allowedModels: [{ provider: 'anthropic', model: 'claude-fixture' }],
      }),
      budget: { reserve: async () => ({ id: 'r' }), settle: async () => {} },
      privacy: defaultPrivacyRouter(),
      providers: providersFromEnv(env),
      currentProviders: (configured) => settings.providers(configured),
      fetch: async (request) => {
        sent.push({ url: request.url, key: request.headers.get('x-api-key') });
        return Response.json({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-fixture',
          content: [{ type: 'text', text: 'hi' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
        });
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/providers/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'melete-surrogate-test',
        'x-melete-capability': 'cap',
      },
      body: JSON.stringify({
        model: 'claude-fixture',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    await response.body?.cancel();
    return { status: response.status, sent };
  }

  test('never goes to a gateway it was not saved for', async () => {
    const { db } = keyTable();
    await atAddress(db).settings.saveKey('anthropic', 'owner', {
      api_key: 'sk-ant-saved-direct-1111',
    });
    // The operator later routes Anthropic through a gateway.
    const later = atAddress(db, { ANTHROPIC_BASE_URL: GATEWAY });
    expect((await later.anthropic())?.signedIn).toBeUndefined();
    const call = await turn(later.settings, { ANTHROPIC_BASE_URL: GATEWAY });
    expect(call.status).toBe(503);
    expect(call.sent).toEqual([]);
    expect(await later.settings.test({ provider: 'anthropic' })).toMatchObject({
      ok: false,
      code: 'no_key',
    });
    expect(later.seen).toEqual([]);
    // Settings says the saved key is for another address, and which one is in use.
    const view = await later.settings.view(true);
    expect(view.providers.find((status) => status.provider === 'anthropic')).toMatchObject({
      key: { state: 'other_address', last_four: '1111' },
      base_url: `${GATEWAY}/v1/`,
      base_url_source: 'operator',
      connected: false,
    });
    // The operator's own key is what calls through the gateway carry.
    const operator = { ANTHROPIC_BASE_URL: GATEWAY, ANTHROPIC_API_KEY: 'operator-anthropic-key' };
    const withKey = atAddress(db, operator);
    expect(await withKey.anthropic()).toMatchObject({ apiKey: 'operator-anthropic-key' });
    expect((await withKey.anthropic())?.signedIn).toBeUndefined();
    expect((await turn(withKey.settings, operator)).sent).toEqual([
      { url: `${GATEWAY}/v1/messages`, key: 'operator-anthropic-key' },
    ]);
  });

  test('a key saved while the gateway is set goes to it, and only to it', async () => {
    const { db, stored } = keyTable();
    const gateway = atAddress(db, { ANTHROPIC_BASE_URL: GATEWAY });
    await gateway.settings.saveKey('anthropic', 'owner', { api_key: 'sk-ant-gateway-2222' });
    expect(stored[0]?.baseUrl).toBe(`${GATEWAY}/v1/`);
    expect((await turn(gateway.settings, { ANTHROPIC_BASE_URL: GATEWAY })).sent).toEqual([
      { url: `${GATEWAY}/v1/messages`, key: 'sk-ant-gateway-2222' },
    ]);
    expect(await gateway.settings.test({ provider: 'anthropic' })).toMatchObject({ ok: true });
    expect(gateway.seen.map((request) => request.url)).toEqual([`${GATEWAY}/v1/models`]);
    expect(gateway.seen[0]?.headers.get('x-api-key')).toBe('sk-ant-gateway-2222');
    // With the gateway gone, it is not sent to Anthropic directly either.
    const direct = atAddress(db);
    expect((await turn(direct.settings, {})).sent).toEqual([]);
    expect(await direct.settings.test({ provider: 'anthropic' })).toMatchObject({
      code: 'no_key',
    });
  });

  test('a key saved before keys were bound stays with Anthropic itself', async () => {
    const { db, stored } = keyTable();
    await atAddress(db).settings.saveKey('anthropic', 'owner', { api_key: 'sk-ant-legacy-3333' });
    // A row written before this change carries no address.
    if (stored[0]) stored[0].baseUrl = null;
    const direct = atAddress(db);
    expect((await turn(direct.settings, {})).sent).toEqual([
      { url: 'https://api.anthropic.com/v1/messages', key: 'sk-ant-legacy-3333' },
    ]);
    expect(await direct.settings.test({ provider: 'anthropic' })).toMatchObject({ ok: true });
    expect(direct.seen[0]?.url).toBe('https://api.anthropic.com/v1/models');
    const view = await direct.settings.view(true);
    expect(view.providers.find((status) => status.provider === 'anthropic')).toMatchObject({
      key: { state: 'set', last_four: '3333' },
      base_url: null,
      connected: true,
    });
    const gateway = atAddress(db, { ANTHROPIC_BASE_URL: GATEWAY });
    expect((await turn(gateway.settings, { ANTHROPIC_BASE_URL: GATEWAY })).sent).toEqual([]);
  });
});

describe('an endpoint the owner connects in the app', () => {
  const NAMES: Record<string, { address: string; family: 4 | 6 }[]> = {
    'models.inside.test': [{ address: '10.0.0.7', family: 4 }],
    'metadata.inside.test': [{ address: '169.254.169.254', family: 4 }],
    'mapped.inside.test': [{ address: '::ffff:a9fe:a9fe', family: 6 }],
    'models.example.test': [{ address: '93.184.216.34', family: 4 }],
  };
  const resolve = async (host: string) => {
    const found = NAMES[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  };
  const METADATA = [
    'http://169.254.169.254/v1',
    'http://2852039166/v1',
    'http://0251.0376.0251.0376/v1',
    'http://[::ffff:a9fe:a9fe]/v1',
    'http://[fd00:ec2::254]/v1',
    'http://metadata.inside.test/v1',
    'http://mapped.inside.test/v1',
  ];

  test('may sit on the owner’s own network or be public, but never at cloud metadata', async () => {
    const seen: string[] = [];
    const settings = new ModelSettingsService({
      db: emptyDb,
      env: loadEnv({ NODE_ENV: 'test' }),
      resolve,
      fetch: async (request) => {
        seen.push(request.url);
        return Response.json({ data: [{ id: 'llama' }] });
      },
    });
    const attempt = (base_url: string) =>
      settings.test({ provider: 'openai-compatible', api_key: 'k-12345678', base_url });
    for (const base of ['http://models.inside.test/v1', 'https://models.example.test/v1'])
      expect(await attempt(base)).toMatchObject({ ok: true });
    for (const base of METADATA)
      expect([base, await attempt(base)]).toEqual([
        base,
        { ok: false, code: 'invalid_address', message: UNREACHABLE, status: null },
      ]);
    expect(seen).toEqual([
      'http://models.inside.test/v1/models',
      'https://models.example.test/v1/models',
    ]);
    // An address written out is refused before it is saved.
    expect(() => checkedBaseUrl('http://169.254.169.254/v1')).toThrow(UNREACHABLE);
    expect(() => checkedBaseUrl('http://[fd00:ec2::254]/v1')).toThrow(UNREACHABLE);
  });

  test('the operator’s own address is the operator’s configuration, and is not checked', async () => {
    const seen: string[] = [];
    const settings = new ModelSettingsService({
      db: emptyDb,
      env: loadEnv({
        NODE_ENV: 'test',
        OPENAI_COMPAT_BASE_URL: 'http://metadata.inside.test/v1',
        OPENAI_COMPAT_API_KEY: 'operator-secret-key',
      }),
      resolve,
      fetch: async (request) => {
        seen.push(request.url);
        return Response.json({ data: [] });
      },
    });
    expect(await settings.test({ provider: 'openai-compatible' })).toMatchObject({ ok: true });
    expect(seen).toEqual(['http://metadata.inside.test/v1/models']);
  });

  test('every model call to it is checked again, so a name that turns to metadata reaches nothing', async () => {
    let address = 'http://models.inside.test/v1';
    const seen: string[] = [];
    const server = createModelGateway({
      authenticate: async () => ({
        jobId: 'job',
        attemptId: 'att',
        privacy: { kind: 'job' as const },
        epoch: 1,
        revision: 1,
        maxRequests: 20,
        maxTokens: 50_000,
        allowedModels: [{ provider: 'openai-compatible', model: 'llama' }],
      }),
      budget: { reserve: async () => ({ id: 'r' }), settle: async () => {} },
      privacy: defaultPrivacyRouter(),
      providers: [],
      currentProviders: async (): Promise<GatewayProvider[]> => [
        {
          name: 'openai-compatible',
          baseUrl: `${address}/`,
          apiKey: 'owner-key-1234',
          protocols: ['chat/completions'],
          allowHttp: true,
          mayBeLocal: true,
          reach: 'installation',
        },
      ],
      resolve,
      fetch: async (request) => {
        seen.push(request.url);
        return Response.json({
          model: 'llama',
          choices: [{ message: { role: 'assistant', content: 'hi' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const port = (server.address() as { port: number }).port;
      const call = () =>
        fetch(`http://127.0.0.1:${port}/providers/openai-compatible/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer melete-surrogate-test',
            'x-melete-capability': 'cap',
          },
          body: JSON.stringify({ model: 'llama', max_tokens: 10, messages: [] }),
        });
      expect((await call()).status).toBe(200);
      for (const base of METADATA) {
        address = base;
        const refused = await call();
        expect([base, refused.ok]).toEqual([base, false]);
        await refused.body?.cancel();
      }
      expect(seen).toEqual(['http://models.inside.test/v1/chat/completions']);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
