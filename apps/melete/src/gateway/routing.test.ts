import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { loadEnv } from '../env.ts';
import {
  acceptsEffort,
  asksForDepth,
  failedResult,
  MULTI_STEP_ROUNDS,
  toolLoop,
  turnEffort,
  withEffort,
} from './effort.ts';
import { createModelGateway, type GatewayOptions, providersFromEnv } from './index.ts';
import { ModelSettingsService, serviceModelSource } from './model-settings.ts';
import { PriceTable, parseModelPrices } from './prices.ts';
import {
  agentRoutes,
  allowedWithRoutes,
  type ModelRouting,
  NO_ROUTING,
  parseModelChoice,
  routingFromEnv,
  routingWarnings,
  withPersonRoles,
} from './routing.ts';
import type {
  GatewayPrincipal,
  GatewayReservationRequest,
  GatewayRoutes,
  GatewaySettlement,
} from './types.ts';

const STRONG = { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4' };
const VISION = { provider: 'fireworks', model: 'accounts/fireworks/models/qwen-vl' };
const BACKUP = { provider: 'openai-compatible', model: 'backup-chat' };
const PICTURE =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** One round of a tool loop as the engine writes it: the call, then its result. */
const round = (id: string, result: unknown) => [
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id, type: 'function', function: { name: 'web.fetch', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: id, content: JSON.stringify(result) },
];
const FAILED = { status: 'failed', error: { code: 'unreachable_host', message: 'no answer' } };
const SUCCEEDED = { status: 'succeeded', action_id: 'act_routing' };
const loopBody = (...after: unknown[]) => ({
  messages: [{ role: 'user', content: 'go' }, ...after],
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

function principal(routes?: GatewayRoutes): GatewayPrincipal {
  return {
    jobId: 'job_routing',
    attemptId: 'att_routing',
    privacy: { kind: 'job' },
    epoch: 1,
    revision: 0,
    maxRequests: 10,
    maxTokens: 10_000,
    allowedModels: allowedWithRoutes(STRONG, routes),
    ...(routes ? { routes } : {}),
  };
}

/**
 * A gateway in front of two providers. `answer` decides each upstream reply
 * from the model asked for; every upstream request body is kept.
 */
async function start(
  routes: GatewayRoutes | undefined,
  answer: (model: string, body: Record<string, unknown>) => Response,
  extra: Partial<GatewayOptions> = {},
) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const reservations: GatewayReservationRequest[] = [];
  const settlements: GatewaySettlement[] = [];
  const server = createModelGateway({
    privacy: false,
    authenticate: async () => principal(routes),
    budget: {
      reserve: async (request) => {
        reservations.push(request);
        return { id: request.requestId };
      },
      settle: async (_reservation, settlement) => {
        settlements.push(settlement);
      },
    },
    providers: providersFromEnv({
      FIREWORKS_API_KEY: 'fireworks-key',
      OPENAI_COMPAT_BASE_URL: 'https://models.example.net/v1',
      OPENAI_COMPAT_API_KEY: 'compat-key',
    }),
    defaultProvider: 'fireworks',
    fetch: async (request) => {
      const body = (await request.json()) as Record<string, unknown>;
      sent.push({ url: request.url, body });
      return answer(String(body.model), body);
    },
    ...extra,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
  // `after` follows the person's message: the tool loop so far, when a test needs one.
  const post = (content: unknown, after: unknown[] = []) =>
    fetch(`http://127.0.0.1:${address.port}/providers/fireworks/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer melete-surrogate-test',
        'x-melete-capability': 'fixture',
      },
      body: JSON.stringify({
        model: STRONG.model,
        max_tokens: 64,
        messages: [{ role: 'user', content }, ...after],
      }),
    });
  return { post, sent, reservations, settlements };
}

const ok = (model: string) =>
  Response.json({
    model,
    choices: [{ message: { role: 'assistant', content: 'fine' } }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  });

const withPicture = [
  { type: 'text', text: 'What is on the screen?' },
  { type: 'image_url', image_url: { url: `data:image/png;base64,${PICTURE}` } },
];

describe('routing a call to the best model', () => {
  test('the operator settings read as provider/model, split at the first slash', () => {
    expect(
      routingFromEnv({
        MELETE_MODEL_FAST: 'fireworks/accounts/fireworks/models/llama-8b',
        MELETE_MODEL_VISION: `${VISION.provider}/${VISION.model}`,
        MELETE_MODEL_FALLBACK: 'openai-compatible/backup-chat, anthropic/claude-haiku',
      }),
    ).toEqual({
      fast: { provider: 'fireworks', model: 'accounts/fireworks/models/llama-8b' },
      vision: VISION,
      fallback: [BACKUP, { provider: 'anthropic', model: 'claude-haiku' }],
    });
    expect(() => parseModelChoice('just-a-model', 'MELETE_MODEL_FAST')).toThrow(
      'MELETE_MODEL_FAST must be written provider/model',
    );
    expect(() => loadEnv({ MELETE_MODEL_VISION: 'no-slash' })).toThrow('MELETE_MODEL_VISION');
  });

  test('side calls take the fast model; a model pinned for the use wins; without one, the default', async () => {
    const env = { MELETE_DEFAULT_PROVIDER: STRONG.provider, MELETE_DEFAULT_MODEL: STRONG.model };
    const fast = { provider: 'fireworks', model: 'accounts/fireworks/models/llama-8b' };
    expect(await serviceModelSource({ env, fast }).current()).toEqual(fast);
    expect(
      await serviceModelSource({ env, fast, pinned: { model: 'pinned-model' } }).current(),
    ).toEqual({ provider: STRONG.provider, model: 'pinned-model' });
    expect(await serviceModelSource({ env, fast: null }).current()).toEqual(STRONG);
  });

  test("an agent turn gets a vision route only when its model reads no pictures, and none on the owner's own choice", () => {
    const routing = { fast: null, vision: VISION, fallback: [BACKUP] };
    expect(agentRoutes(routing, STRONG, { ownerChose: false, primaryReadsImages: false })).toEqual({
      vision: VISION,
      fallback: [BACKUP],
    });
    expect(agentRoutes(routing, STRONG, { ownerChose: false, primaryReadsImages: true })).toEqual({
      fallback: [BACKUP],
    });
    expect(
      agentRoutes(routing, STRONG, { ownerChose: true, primaryReadsImages: false }),
    ).toBeUndefined();
    // A model speaking another protocol cannot take the request as written.
    const anthropic = { provider: 'anthropic', model: 'claude-vision' };
    expect(
      agentRoutes({ fast: null, vision: anthropic, fallback: [anthropic] }, STRONG, {
        ownerChose: false,
        primaryReadsImages: false,
      }),
    ).toBeUndefined();
  });

  test("the owner's chosen model is never rerouted, while the server default is", async () => {
    const env = loadEnv({
      MELETE_DEFAULT_PROVIDER: STRONG.provider,
      MELETE_DEFAULT_MODEL: STRONG.model,
    });
    // An owner's choice is decided before the database is read.
    const settings = new ModelSettingsService({ db: {} as never, env });
    const routing = { fast: null, vision: VISION, fallback: [BACKUP] };
    expect(
      await settings.attemptRoutes(routing, { provider: 'fireworks', model: 'owner-pick' }),
    ).toBeUndefined();
  });

  test('a request carrying a picture goes to the vision model; one without stays on the strong model', async () => {
    const gateway = await start({ vision: VISION }, ok);
    expect((await gateway.post('plain words')).status).toBe(200);
    expect((await gateway.post(withPicture)).status).toBe(200);
    expect(gateway.sent.map((request) => request.body.model)).toEqual([STRONG.model, VISION.model]);
    expect(gateway.settlements.map((settlement) => settlement.route ?? null)).toEqual([
      null,
      'vision',
    ]);
    expect(gateway.settlements[1]).toMatchObject({
      modelRequested: VISION.model,
      routedFrom: STRONG,
    });
  });

  test('a provider that rate-limits is followed by the fallback, and both calls are on the record', async () => {
    const gateway = await start({ fallback: [BACKUP] }, (model) =>
      model === STRONG.model ? new Response('slow down', { status: 429 }) : ok(model),
    );
    const response = await gateway.post('hello');
    expect(response.status).toBe(200);
    expect(gateway.sent.map((request) => request.url)).toEqual([
      'https://api.fireworks.ai/inference/v1/chat/completions',
      'https://models.example.net/v1/chat/completions',
    ]);
    expect(gateway.reservations.map((request) => request.model)).toEqual([
      STRONG.model,
      BACKUP.model,
    ]);
    expect(
      gateway.settlements.map((settlement) => [
        settlement.provider,
        settlement.status,
        settlement.route ?? null,
      ]),
    ).toEqual([
      ['fireworks', 'failed', null],
      ['openai-compatible', 'succeeded', 'fallback'],
    ]);
  });

  test('a provider that cannot be reached is followed by the fallback too', async () => {
    const gateway = await start({ fallback: [BACKUP] }, (model) => {
      if (model === STRONG.model) throw new TypeError('connection refused');
      return ok(model);
    });
    expect((await gateway.post('hello')).status).toBe(200);
    expect(gateway.settlements.map((settlement) => settlement.status)).toEqual([
      'failed',
      'succeeded',
    ]);
  });

  test('a request the provider refuses as written is not sent elsewhere', async () => {
    const gateway = await start({ fallback: [BACKUP] }, () =>
      Response.json({ error: 'bad request' }, { status: 400 }),
    );
    expect((await gateway.post('hello')).status).toBe(502);
    expect(gateway.sent).toHaveLength(1);
  });

  test("without routes (the owner's own model) a rate limit is returned as it is", async () => {
    const gateway = await start(undefined, () => new Response('slow down', { status: 429 }));
    expect((await gateway.post('hello')).status).toBe(429);
    expect(gateway.sent).toHaveLength(1);
  });
});

describe('reasoning effort per role', () => {
  test('each provider gets its own parameter, only for models that reason, never over the request', () => {
    const input = { provider: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4' };
    expect(withEffort({}, { ...input, protocol: 'chat/completions', effort: 'medium' })).toEqual({
      reasoning_effort: 'medium',
    });
    expect(
      withEffort(
        { reasoning_effort: 'none' },
        { ...input, protocol: 'chat/completions', effort: 'high' },
      ),
    ).toEqual({ reasoning_effort: 'none' });
    expect(
      withEffort(
        {},
        { provider: 'openai', model: 'gpt-6-astra', protocol: 'responses', effort: 'low' },
      ),
    ).toEqual({ reasoning: { effort: 'low' } });
    expect(
      withEffort({}, { provider: 'openai', model: 'gpt-4o', protocol: 'responses', effort: 'low' }),
    ).toEqual({});
    expect(
      withEffort(
        {},
        { provider: 'anthropic', model: 'claude-opus-4', protocol: 'messages', effort: 'high' },
      ),
    ).toEqual({});
    expect(withEffort({}, { ...input, protocol: 'chat/completions', effort: 'off' })).toEqual({});
    expect(acceptsEffort('google', 'gemini-2.5-flash')).toBe(true);
    // Additive: other reasoning settings and structured-output fields stay.
    expect(
      withEffort(
        { reasoning: { summary: 'auto' }, text: { format: { type: 'json_schema' } } },
        { provider: 'openai', model: 'gpt-6-astra', protocol: 'responses', effort: 'low' },
      ),
    ).toEqual({
      reasoning: { summary: 'auto', effort: 'low' },
      text: { format: { type: 'json_schema' } },
    });
    expect(
      withEffort(
        { output_config: { format: { type: 'json_schema' } } },
        { provider: 'anthropic', model: 'claude-opus-4', protocol: 'messages', effort: 'high' },
      ),
    ).toEqual({ output_config: { format: { type: 'json_schema' } } });
    expect(
      withEffort(
        { response_format: { type: 'json_schema' } },
        { ...input, protocol: 'chat/completions', effort: 'low' },
      ),
    ).toEqual({ response_format: { type: 'json_schema' }, reasoning_effort: 'low' });
  });

  test("the gateway adds the role's effort to the request it sends", async () => {
    const gateway = await start(undefined, ok, { reasoningEffort: 'medium' });
    await gateway.post('think about it');
    expect(gateway.sent[0]?.body.reasoning_effort).toBe('medium');
  });

  test("a brief turn's calls think one step less than the agent's effort", async () => {
    const gateway = await start(undefined, ok, {
      reasoningEffort: 'medium',
      authenticate: async () => ({ ...principal(), briefTurn: true }),
    });
    await gateway.post('Got it, thanks');
    expect(gateway.sent[0]?.body.reasoning_effort).toBe('low');
    expect(
      (['high', 'medium', 'low', 'none', 'off', undefined] as const).map((effort) =>
        turnEffort(effort, true),
      ),
    ).toEqual(['medium', 'low', 'low', 'none', 'off', undefined]);
    expect(turnEffort('medium', false)).toBe('medium');
  });

  test('a turn thinks more when asked for depth or when its tools keep failing, and multi-step work at the agent’s effort', () => {
    expect(turnEffort('medium', { deep: true })).toBe('high');
    expect(turnEffort('medium', { brief: true, deep: true })).toBe('high');
    expect(turnEffort('medium', { brief: true, rounds: MULTI_STEP_ROUNDS - 1 })).toBe('low');
    expect(turnEffort('medium', { brief: true, rounds: MULTI_STEP_ROUNDS })).toBe('medium');
    expect(turnEffort('medium', { brief: true, failing: true })).toBe('medium');
    expect(turnEffort('medium', { failing: true })).toBe('high');
    expect(turnEffort('high', { deep: true, failing: true })).toBe('high');
    expect(turnEffort('none', { deep: true })).toBe('low');
    expect(turnEffort('off', { deep: true, failing: true })).toBe('off');
    expect(turnEffort(undefined, { deep: true })).toBeUndefined();
    expect(asksForDepth('Think it through before you answer')).toBe(true);
    expect(asksForDepth('Give me an in-depth comparison of the two plans')).toBe(true);
    expect(asksForDepth('Draft a carefully worded note to my landlord')).toBe(false);
    expect(asksForDepth('hi')).toBe(false);
  });

  test('the tool loop is read from the request itself', () => {
    expect(toolLoop(loopBody(), 'chat/completions')).toEqual({ rounds: 0, failing: false });
    expect(toolLoop(loopBody(...round('a', FAILED)), 'chat/completions')).toEqual({
      rounds: 1,
      failing: false,
    });
    expect(
      toolLoop(loopBody(...round('a', FAILED), ...round('b', FAILED)), 'chat/completions'),
    ).toEqual({ rounds: 2, failing: true });
    expect(
      toolLoop(loopBody(...round('a', FAILED), ...round('b', SUCCEEDED)), 'chat/completions')
        .failing,
    ).toBe(false);
    // A command that exited non-zero failed; a result whose error is null did not.
    expect(failedResult(JSON.stringify({ output: 'x', exit_code: 2 }))).toBe(true);
    expect(failedResult(JSON.stringify({ output: 'x', exit_code: 0, error: null }))).toBe(false);
    expect(failedResult('plain text')).toBe(false);
    expect(failedResult([{ type: 'text', text: JSON.stringify(FAILED) }])).toBe(true);
    // Over responses, calls made together are one round.
    expect(
      toolLoop(
        {
          input: [
            { type: 'message', role: 'user', content: 'go' },
            { type: 'function_call', call_id: 'a', name: 'web.search', arguments: '{}' },
            { type: 'function_call', call_id: 'b', name: 'web.fetch', arguments: '{}' },
            { type: 'function_call_output', call_id: 'a', output: JSON.stringify(FAILED) },
            { type: 'function_call_output', call_id: 'b', output: JSON.stringify(FAILED) },
          ],
        },
        'responses',
      ),
    ).toEqual({ rounds: 1, failing: true });
  });

  test("the gateway raises a turn's effort for a failing loop, a depth ask and multi-step work", async () => {
    const brief = async () => ({ ...principal(), briefTurn: true });
    const failing = await start(undefined, ok, { reasoningEffort: 'medium', authenticate: brief });
    await failing.post('go', [...round('a', FAILED), ...round('b', FAILED)]);
    expect(failing.sent[0]?.body.reasoning_effort).toBe('medium');
    const steps = await start(undefined, ok, { reasoningEffort: 'medium', authenticate: brief });
    await steps.post(
      'go',
      ['a', 'b', 'c'].flatMap((id) => round(id, SUCCEEDED)),
    );
    await steps.post(
      'go',
      ['a', 'b', 'c', 'd'].flatMap((id) => round(id, SUCCEEDED)),
    );
    expect(steps.sent.map((request) => request.body.reasoning_effort)).toEqual(['low', 'medium']);
    const deep = await start(undefined, ok, {
      reasoningEffort: 'medium',
      authenticate: async () => ({ ...principal(), briefTurn: true, deepTurn: true }),
    });
    await deep.post('Think hard: which plan is cheaper?');
    expect(deep.sent[0]?.body.reasoning_effort).toBe('high');
    // A service call's messages are never read as a tool loop.
    const service = await start(undefined, ok, {
      reasoningEffort: 'low',
      authenticate: async () => ({
        ...principal(),
        privacy: { kind: 'service', purpose: 'memory', spaceId: 'spc_routing', sourceJobId: null },
      }),
    });
    await service.post('x', [...round('a', FAILED), ...round('b', FAILED)]);
    expect(service.sent[0]?.body.reasoning_effort).toBe('low');
  });

  test('a model that refuses the added effort is asked once more without it', async () => {
    const gateway = await start(
      undefined,
      (model, body) =>
        body.reasoning_effort === undefined
          ? ok(model)
          : Response.json({ error: 'unknown field' }, { status: 400 }),
      { reasoningEffort: 'medium' },
    );
    expect((await gateway.post('think about it')).status).toBe(200);
    expect(gateway.sent.map((request) => request.body.reasoning_effort ?? null)).toEqual([
      'medium',
      null,
    ]);
    expect(gateway.settlements.map((settlement) => settlement.status)).toEqual([
      'failed',
      'succeeded',
    ]);
  });

  test('the defaults are medium for agent turns and low for side calls', () => {
    const env = loadEnv({});
    expect([env.MELETE_REASONING_EFFORT_AGENT, env.MELETE_REASONING_EFFORT_SIDE]).toEqual([
      'medium',
      'low',
    ]);
  });
});

describe('the price table', () => {
  test('the most specific entry wins, an operator price beats a default, and nothing unknown is free', () => {
    const table = new PriceTable(
      parseModelPrices(
        '{"fireworks/accounts/fireworks/models/deepseek-v4":{"input":1,"output":2}}',
      ),
    );
    expect(table.priceFor('fireworks', 'accounts/fireworks/models/deepseek-v4').entry).toBe(
      'fireworks/accounts/fireworks/models/deepseek-v4',
    );
    expect(table.priceFor('anthropic', 'claude-haiku-5').entry).toBe('anthropic/*haiku*');
    expect(table.priceFor('somewhere', 'mystery').entry).toBe('*');
    // A million fresh input tokens at $1, half a million cached at Fireworks'
    // share of the input price (a fifth), and a million output at $2.
    expect(
      table.cost('fireworks', 'accounts/fireworks/models/deepseek-v4', {
        inputTokens: 1_500_000,
        cachedInputTokens: 500_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(3.1, 6);
    expect(() => parseModelPrices('{"x": {"input": "cheap"}}')).toThrow('MELETE_MODEL_PRICES');
  });
});

describe("a model on the owner's own machine keeps its calls", () => {
  const LOCAL = { provider: 'openai-compatible', model: 'llama3.1:8b' };
  const FAST = { provider: 'fireworks', model: 'accounts/fireworks/models/llama-8b' };

  test('side calls stay on a local default model instead of the cloud fast model', async () => {
    const env = {
      MELETE_DEFAULT_PROVIDER: LOCAL.provider,
      MELETE_DEFAULT_MODEL: LOCAL.model,
      OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
    };
    expect(await serviceModelSource({ env, fast: FAST }).current()).toEqual(LOCAL);
    // The same default at a cloud address takes the fast model.
    expect(
      await serviceModelSource({
        env: { ...env, OPENAI_COMPAT_BASE_URL: 'https://models.example.net/v1' },
        fast: FAST,
      }).current(),
    ).toEqual(FAST);
  });

  test('a local model that fails is not followed by a cloud fallback, and its call is marked local', async () => {
    const sent: string[] = [];
    const settlements: GatewaySettlement[] = [];
    const server = createModelGateway({
      privacy: false,
      authenticate: async () => ({
        jobId: 'memory:sp_local',
        attemptId: 'memory:1',
        privacy: { kind: 'service', purpose: 'memory', spaceId: 'sp_local', sourceJobId: null },
        epoch: 0,
        revision: 0,
        maxRequests: 1,
        maxTokens: 10_000,
        allowedModels: [LOCAL, FAST],
        routes: { fallback: [FAST] },
      }),
      budget: {
        reserve: async (request) => ({ id: request.requestId }),
        settle: async (_reservation, settlement) => void settlements.push(settlement),
      },
      providers: providersFromEnv({
        FIREWORKS_API_KEY: 'fireworks-key',
        OPENAI_COMPAT_BASE_URL: 'http://127.0.0.1:11434/v1',
        OPENAI_COMPAT_API_KEY: 'local',
      }),
      defaultProvider: 'openai-compatible',
      fetch: async (request) => {
        sent.push(request.url);
        return new Response('busy', { status: 503 });
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected a TCP listener');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/providers/openai-compatible/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer melete-surrogate-test',
          'x-melete-capability': 'fixture',
        },
        body: JSON.stringify({
          model: LOCAL.model,
          max_tokens: 32,
          messages: [{ role: 'user', content: 'private words' }],
        }),
      },
    );
    expect(response.status).toBe(502);
    expect(sent).toEqual(['http://127.0.0.1:11434/v1/chat/completions']);
    expect(settlements[0]?.servedLocally).toBe(true);
  });

  test('a picture is never sent to a fallback', async () => {
    const gateway = await start({ fallback: [BACKUP] }, (model) =>
      model === STRONG.model ? new Response('slow down', { status: 429 }) : ok(model),
    );
    expect((await gateway.post(withPicture)).status).toBe(429);
    expect(gateway.sent).toHaveLength(1);
  });

  test("'none' is sent the way each model takes it, or not at all", () => {
    const none = (provider: string, model: string, protocol: 'responses' | 'chat/completions') =>
      withEffort({}, { provider, model, protocol, effort: 'none' });
    expect(none('openai', 'gpt-6-astra', 'responses')).toEqual({ reasoning: { effort: 'none' } });
    expect(none('openai', 'gpt-5', 'responses')).toEqual({ reasoning: { effort: 'minimal' } });
    expect(none('openai', 'o4-mini', 'responses')).toEqual({});
    expect(none('google', 'gemini-2.5-pro', 'chat/completions')).toEqual({});
  });

  test('the routing models are checked at start-up', () => {
    expect(
      routingWarnings(
        { FIREWORKS_API_KEY: 'k' },
        { fast: { provider: 'fireworkz', model: 'x' }, vision: null, fallback: [BACKUP] },
      ),
    ).toEqual([
      expect.stringContaining('MELETE_MODEL_FAST names the provider "fireworkz"'),
      expect.stringContaining('MELETE_MODEL_FALLBACK names openai-compatible'),
    ]);
  });
});

describe('a person’s secondary in the routing roles', () => {
  const operator: ModelRouting = {
    fast: { provider: 'fireworks', model: 'fast' },
    vision: { provider: 'fireworks', model: 'eyes' },
    fallback: [{ provider: 'fireworks', model: 'backup' }],
  };
  const secondary = { provider: 'fireworks', model: 'small' };

  test('with no secondary the operator’s roles stand as they are', () => {
    expect(withPersonRoles(operator, {})).toEqual(operator);
  });

  test('it fills only fast and background, never vision or fallback', () => {
    expect(withPersonRoles(operator, { fast: secondary, background: secondary })).toEqual({
      ...operator,
      fast: secondary,
      background: secondary,
    });
    expect(withPersonRoles(NO_ROUTING, { background: secondary })).toEqual({
      ...NO_ROUTING,
      background: secondary,
    });
  });
});

describe('a safety check stays off the secondary', () => {
  const env = { MELETE_DEFAULT_PROVIDER: STRONG.provider, MELETE_DEFAULT_MODEL: STRONG.model };
  const fast = { provider: 'fireworks', model: 'accounts/fireworks/models/llama-8b' };
  const secondary = { provider: 'fireworks', model: 'accounts/fireworks/models/small' };
  // Settings whose space owner has put side tasks on the secondary.
  const settings = {
    routingFor: async (_spaceId: string, routing: ModelRouting) => ({
      ...routing,
      fast: secondary,
    }),
    activeChoice: async () => ({ ...STRONG, vision: false }),
    servesLocally: async () => false,
  } as unknown as ModelSettingsService;

  test('sideTask: false keeps the operator’s fast model even when the space is passed', async () => {
    const guarded = serviceModelSource({ env, settings, fast, sideTask: false });
    expect(await guarded.current({ spaceId: 'sp_owner' })).toEqual(fast);
    // Without the flag the same call would take the secondary.
    const ordinary = serviceModelSource({ env, settings, fast });
    expect(await ordinary.current({ spaceId: 'sp_owner' })).toEqual(secondary);
  });
});
