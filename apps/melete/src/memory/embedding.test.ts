import { describe, expect, test } from 'bun:test';
import { PriceTable } from '../gateway/prices.ts';
import type { GatewayPrincipal, GatewaySettlement } from '../gateway/types.ts';
import { MemoryError } from './db.ts';
import {
  BREAKER_FAILURES,
  createEmbeddingProvider,
  embeddingFromEnv,
  onceForQueries,
} from './embedding.ts';

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
  test('a cloud embedder reads only what the privacy router hands it; a local model reads as written', async () => {
    const { fetch } = endpoint();
    const asked: { spaceId: string; texts: readonly string[]; jobId: string | null | undefined }[] =
      [];
    const privacy = {
      async screenForCloud(spaceId: string, texts: readonly string[], jobId?: string | null) {
        asked.push({ spaceId, texts, jobId });
        return spaceId === 'sp_private' ? null : texts.map(() => 'call \u27e6PHONE_1\u27e7');
      },
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
    expect(await cloud.screen?.('sp_x', ['call 415 555 0100'], 'job_1')).toEqual([
      'call \u27e6PHONE_1\u27e7',
    ]);
    expect(asked[0]).toEqual({ spaceId: 'sp_x', texts: ['call 415 555 0100'], jobId: 'job_1' });
    expect(await cloud.screen?.('sp_private', ['anything'])).toBeNull();
    // Without the router a cloud embedder is sent nothing at all.
    const unrouted = createEmbeddingProvider({
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: 'k',
      provider: 'fireworks',
      model: { model: 'nomic-ai/nomic-embed-text-v1.5', dimensions: 3 },
      local: false,
      fetch,
    });
    expect(await unrouted.screen?.('sp_x', ['anything'])).toBeNull();
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

  test('a provider that keeps failing is left alone for a while, and health says so', async () => {
    let calls = 0;
    const provider = createEmbeddingProvider({
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'k',
      provider: 'openai',
      model: { model: 'text-embedding-3-small', dimensions: 3 },
      local: false,
      fetch: async () => {
        calls++;
        return new Response('down', { status: 503 });
      },
    });
    for (let i = 0; i < BREAKER_FAILURES; i++)
      await expect(provider.embed(['x'], AbortSignal.timeout(1000))).rejects.toThrow(
        'embedding_provider_failed',
      );
    expect(provider.status?.()).toMatchObject({
      consecutive_failures: BREAKER_FAILURES,
      last_error: 'embedding_provider_failed',
    });
    expect(provider.status?.().paused_until).not.toBeNull();
    // Paused: the next request does not wait on the provider at all.
    const error = await provider.embed(['x'], AbortSignal.timeout(1000)).catch((e) => e);
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe('embedding_paused');
    // Each failed call asked twice: a busy answer is retried once.
    expect(calls).toBe(BREAKER_FAILURES * 2);
  });

  test('a provider that answers busy once is asked again, and the call succeeds', async () => {
    const { fetch } = endpoint();
    let calls = 0;
    const provider = createEmbeddingProvider({
      baseUrl: 'https://api.fireworks.ai/inference/v1/',
      apiKey: 'k',
      provider: 'fireworks',
      model: { model: 'nomic-ai/nomic-embed-text-v1.5', dimensions: 3 },
      local: false,
      fetch: async (input, init) => {
        calls++;
        return calls === 1 ? new Response('busy', { status: 503 }) : fetch(input, init);
      },
    });
    expect(await provider.embed(['nut allergy'], AbortSignal.timeout(2000))).toHaveLength(1);
    expect(calls).toBe(2);
    expect(provider.status?.()).toMatchObject({ consecutive_failures: 0, last_error: null });
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
