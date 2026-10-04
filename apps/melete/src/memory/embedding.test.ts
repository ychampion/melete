import { describe, expect, test } from 'bun:test';
import { PriceTable } from '../gateway/prices.ts';
import type { GatewayPrincipal, GatewaySettlement } from '../gateway/types.ts';
import type { ResolvedSettings } from '../privacy/store.ts';
import {
  createEmbeddingProvider,
  embeddingFromEnv,
  onceForQueries,
  screenText,
} from './embedding.ts';

const settings = (overrides: Partial<ResolvedSettings> = {}): ResolvedSettings => ({
  version: 1,
  enabled: new Set(['phone', 'email', 'address', 'name']),
  topics: [],
  privateSpace: false,
  privateAgents: new Set(),
  local: null,
  localDetection: false,
  known: [],
  onDeviceUrl: null,
  screenshotsOwn: true,
  screenshotsDevices: false,
  ...overrides,
});

/** A stand-in embeddings endpoint: records each request and answers in the OpenAI shape. */
function endpoint(dimensions = 3) {
  const requests: { url: string; body: { model: string; input: string[] }; auth: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    requests.push({
      url: String(input),
      body,
      auth: new Headers(init?.headers).get('authorization') ?? '',
    });
    return Response.json({
      data: body.input.map((_, index) => ({
        index,
        embedding: Array.from({ length: dimensions }, (_, i) => i + index),
      })),
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
  };
  return { requests, fetch };
}

describe('what a cloud embedder may read', () => {
  test('detected details and listed values are swapped for their kind', () => {
    const text = screenText(
      'Call Priya on +1 415 555 0100 or priya@example.com about the lease.',
      settings({
        known: [{ id: 'pv_1', label: 'Sister', category: 'name', value: 'Priya' }],
      }),
    );
    expect(text).not.toContain('555');
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('Priya');
    expect(text).toContain('[phone]');
    expect(text).toContain('[email]');
    expect(text).toContain('[name]');
    expect(text).toContain('about the lease');
  });

  test('a space marked private sends nothing; a local model reads memory as written', async () => {
    const { fetch } = endpoint();
    const privacy = {
      settingsFor: async () => settings({ privateSpace: true }),
    };
    const cloud = createEmbeddingProvider({
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: 'k',
      provider: 'fireworks',
      model: { model: 'nomic-ai/nomic-embed-text-v1.5', dimensions: 3 },
      local: false,
      privacy,
      fetch,
    });
    expect(await cloud.screen?.('sp_x', ['anything'])).toBeNull();
    const local = createEmbeddingProvider({
      baseUrl: 'http://127.0.0.1:11434/v1',
      provider: 'local',
      model: { model: 'nomic-embed-text', dimensions: 3 },
      local: true,
      privacy,
      fetch,
    });
    expect(await local.screen?.('sp_x', ['call 415 555 0100'])).toEqual(['call 415 555 0100']);
  });
});

describe('embedding calls', () => {
  test('prefixes, batching and vectors follow the model, and every call is charged to its person', async () => {
    const { requests, fetch } = endpoint();
    const recorded: { principal: GatewayPrincipal; settlement: GatewaySettlement }[] = [];
    const admitted: GatewayPrincipal[] = [];
    const provider = createEmbeddingProvider({
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: 'secret',
      provider: 'fireworks',
      model: {
        model: 'nomic-ai/nomic-embed-text-v1.5',
        dimensions: 3,
        prefixes: { query: 'search_query: ', document: 'search_document: ' },
      },
      local: false,
      fetch,
      spending: {
        async admit(principal) {
          admitted.push(principal);
        },
        async record(principal, settlement) {
          recorded.push({ principal, settlement });
        },
      },
    });
    expect(provider.model).toBe('fireworks/nomic-ai/nomic-embed-text-v1.5');
    const vectors = await provider.embed(
      ['teal is my color', 'peanuts'],
      AbortSignal.timeout(1000),
      {
        purpose: 'document',
        call: { spaceId: 'sp_1' },
      },
    );
    expect(vectors).toEqual([
      [0, 1, 2],
      [1, 2, 3],
    ]);
    await provider.embed(['favourite colour'], AbortSignal.timeout(1000), {
      purpose: 'query',
      call: { spaceId: 'sp_1', jobId: 'job_1', actor: 'prn_1' },
    });
    expect(requests[0]?.url).toBe('https://api.fireworks.ai/inference/v1/embeddings');
    expect(requests[0]?.auth).toBe('Bearer secret');
    expect(requests[0]?.body.input).toEqual([
      'search_document: teal is my color',
      'search_document: peanuts',
    ]);
    expect(requests[1]?.body.input).toEqual(['search_query: favourite colour']);
    expect(admitted).toHaveLength(2);
    expect(recorded.map((entry) => entry.principal.privacy)).toEqual([
      { kind: 'service', purpose: 'memory_embedding', spaceId: 'sp_1', sourceJobId: null },
      { kind: 'service', purpose: 'memory_embedding', spaceId: 'sp_1', sourceJobId: 'job_1' },
    ]);
    expect(recorded[1]?.principal.actor).toBe('prn_1');
    expect(recorded[0]?.settlement).toMatchObject({
      provider: 'fireworks',
      modelRequested: 'nomic-ai/nomic-embed-text-v1.5',
      status: 'succeeded',
      usage: { inputTokens: 7, outputTokens: 0 },
    });
    // Priced as an embedding model, not as the conservative unknown model.
    const cost = new PriceTable().cost('fireworks', 'nomic-ai/nomic-embed-text-v1.5', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cost).toBe(0.008);
  });

  test('a refused or malformed answer fails the call, and is still recorded', async () => {
    const recorded: GatewaySettlement[] = [];
    const spending = {
      async admit() {},
      async record(_principal: GatewayPrincipal, settlement: GatewaySettlement) {
        recorded.push(settlement);
      },
    };
    const refused = createEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'k',
      provider: 'openai',
      model: { model: 'text-embedding-3-small', dimensions: 3 },
      local: false,
      spending,
      fetch: async () => new Response('no', { status: 401 }),
    });
    await expect(
      refused.embed(['x'], AbortSignal.timeout(1000), { call: { spaceId: 'sp_1' } }),
    ).rejects.toThrow('embedding_provider_auth');
    const short = createEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'k',
      provider: 'openai',
      model: { model: 'text-embedding-3-small', dimensions: 4 },
      local: false,
      spending,
      fetch: endpoint(3).fetch,
    });
    await expect(
      short.embed(['x'], AbortSignal.timeout(1000), { call: { spaceId: 'sp_1' } }),
    ).rejects.toThrow('embedding_space_mismatch');
    expect(recorded.map((settlement) => settlement.status)).toEqual(['failed', 'succeeded']);
  });

  test('one request is embedded once for memory and notes alike', async () => {
    let calls = 0;
    const base = createEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'k',
      provider: 'openai',
      model: { model: 'text-embedding-3-small', dimensions: 3 },
      local: false,
      fetch: async (input, init) => {
        calls++;
        return endpoint().fetch(input, init);
      },
    });
    const once = onceForQueries(base);
    await once.embed(['plumber'], AbortSignal.timeout(1000), { purpose: 'query' });
    await once.embed(['plumber'], AbortSignal.timeout(1000), { purpose: 'query' });
    await once.embed(['plumber'], AbortSignal.timeout(1000), { purpose: 'document' });
    expect(calls).toBe(2);
  });
});

describe('which embedder a deployment runs', () => {
  test('the configured provider, else the first with a key; none means lexical recall', async () => {
    expect(await embeddingFromEnv({})).toBeNull();
    expect(
      await embeddingFromEnv({ ANTHROPIC_API_KEY: 'a', MELETE_DEFAULT_PROVIDER: 'anthropic' }),
    ).toBeNull();
    const fireworks = await embeddingFromEnv({
      ANTHROPIC_API_KEY: 'a',
      FIREWORKS_API_KEY: 'f',
      MELETE_DEFAULT_PROVIDER: 'anthropic',
    });
    expect(fireworks?.model).toBe('fireworks/nomic-ai/nomic-embed-text-v1.5');
    expect(fireworks?.dimensions).toBe(768);
    const openai = await embeddingFromEnv({
      FIREWORKS_API_KEY: 'f',
      OPENAI_API_KEY: 'o',
      MELETE_DEFAULT_PROVIDER: 'openai',
    });
    expect(openai?.model).toBe('openai/text-embedding-3-small');
    expect(
      await embeddingFromEnv({ FIREWORKS_API_KEY: 'f', MELETE_EMBEDDING_MODEL: 'off' }),
    ).toBeNull();
    // A model the operator names on an OpenAI-compatible endpoint needs its dimensions.
    expect(
      await embeddingFromEnv({
        OPENAI_COMPAT_BASE_URL: 'https://models.example/v1',
        OPENAI_COMPAT_API_KEY: 'c',
        MELETE_EMBEDDING_PROVIDER: 'openai-compatible',
        MELETE_EMBEDDING_MODEL: 'bge-m3',
      }),
    ).toBeNull();
    const compatible = await embeddingFromEnv({
      OPENAI_COMPAT_BASE_URL: 'https://models.example/v1',
      OPENAI_COMPAT_API_KEY: 'c',
      MELETE_EMBEDDING_PROVIDER: 'openai-compatible',
      MELETE_EMBEDDING_MODEL: 'bge-m3',
      MELETE_EMBEDDING_DIMENSIONS: 1024,
    });
    expect(compatible?.model).toBe('openai-compatible/bge-m3');
    expect(compatible?.local).toBe(false);
  });

  test('a local embedder must be on this machine or network', async () => {
    const env = {
      MELETE_EMBEDDING_PROVIDER: 'local',
      MELETE_EMBEDDING_MODEL: 'nomic-embed-text',
      MELETE_EMBEDDING_DIMENSIONS: 768,
    };
    const local = await embeddingFromEnv({
      ...env,
      MELETE_LOCAL_MODEL_URL: 'http://127.0.0.1:11434/v1',
    });
    expect(local?.local).toBe(true);
    expect(
      await embeddingFromEnv(
        { ...env, MELETE_LOCAL_MODEL_URL: 'https://embeddings.example/v1' },
        { resolve: async () => [{ address: '93.184.216.34' }] },
      ),
    ).toBeNull();
  });
});
