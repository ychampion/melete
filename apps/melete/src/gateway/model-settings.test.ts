import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import type { Database } from '../db/client.ts';
import { loadEnv } from '../env.ts';
import { defaultPrivacyRouter } from '../privacy/index.ts';
import { createModelGateway, type GatewayProvider, providersFromEnv } from './index.ts';
import { checkedBaseUrl, ModelSettingsService, modelIds } from './model-settings.ts';

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
});
