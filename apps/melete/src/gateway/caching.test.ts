import { describe, expect, test } from 'bun:test';
import {
  applyPromptCaching,
  markAnthropicCache,
  promptCacheKey,
  promptCacheScope,
  SESSION_AFFINITY_HEADER,
} from './caching.ts';
import { CACHE_PRICE_SHARE, PriceTable } from './prices.ts';

const SECRET = 'an-install-secret-of-at-least-thirty-two-characters';
const job = (jobId: string) => ({ jobId, attemptId: 'att_x', privacy: { kind: 'job' as const } });

type MessagesBody = {
  model: string;
  system: unknown;
  tools: Record<string, unknown>[];
  messages: { role: string; content: unknown }[];
};

const anthropicBody = (): MessagesBody => ({
  model: 'claude-fixture',
  system: 'You are Melete.',
  tools: [
    { name: 'first', input_schema: { type: 'object' } },
    { name: 'last', input_schema: { type: 'object' } },
  ],
  messages: [
    { role: 'user', content: 'An earlier turn, as written' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reply' }] },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result' }],
    },
  ],
});

describe('prompt-caching controls', () => {
  test('an unmarked Anthropic request gets breakpoints after its tools, system prompt and newest message', () => {
    const body = anthropicBody();
    expect(markAnthropicCache(body)).toBe(3);
    expect(body.tools[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(body.tools[0]).not.toHaveProperty('cache_control');
    expect(body.system).toEqual([
      { type: 'text', text: 'You are Melete.', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages[2]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: 'result',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // Earlier history is passed on exactly as it was written.
    expect(body.messages[0]).toEqual({ role: 'user', content: 'An earlier turn, as written' });
    expect(body.messages[1]?.content).toEqual([{ type: 'text', text: 'Reply' }]);
  });

  test('a request the engine already marked, or a plain-string newest message, is not reshaped', () => {
    const marked = anthropicBody();
    marked.system = [
      { type: 'text', text: 'You are Melete.', cache_control: { type: 'ephemeral' } },
    ];
    const before = JSON.stringify(marked);
    expect(markAnthropicCache(marked)).toBe(0);
    expect(JSON.stringify(marked)).toBe(before);
    const plain = {
      model: 'claude-fixture',
      messages: [{ role: 'user', content: 'only text' }],
    };
    expect(markAnthropicCache(plain)).toBe(0);
    expect(plain.messages[0]).toEqual({ role: 'user', content: 'only text' });
    // A thinking block cannot carry a breakpoint.
    const thinking = {
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '...' }] }],
    };
    expect(markAnthropicCache(thinking)).toBe(0);
  });

  test('OpenAI and the ChatGPT plan get one cache key per conversation; Fireworks gets session affinity', () => {
    const scope = promptCacheScope(job('job_a'));
    const openai: Record<string, unknown> = { model: 'gpt-fixture', input: 'hello' };
    expect(
      applyPromptCaching(openai, {
        provider: 'openai',
        protocol: 'responses',
        scope,
        secret: SECRET,
      }),
    ).toEqual({ markers: 0, key: true, headers: {} });
    expect(openai.prompt_cache_key).toBe(promptCacheKey(scope, SECRET));
    expect(promptCacheKey(scope, SECRET)).toMatch(/^[0-9a-f]{32}$/);
    // The job id itself never leaves.
    expect(String(openai.prompt_cache_key)).not.toContain('job_a');
    // A key the engine chose, perhaps from its session id, is replaced, never passed on.
    const chatgpt: Record<string, unknown> = { prompt_cache_key: 'job_a' };
    applyPromptCaching(chatgpt, {
      provider: 'chatgpt',
      protocol: 'responses',
      scope,
      secret: SECRET,
    });
    expect(chatgpt.prompt_cache_key).toBe(promptCacheKey(scope, SECRET));
    const compatible: Record<string, unknown> = { prompt_cache_key: 'job_a' };
    applyPromptCaching(compatible, {
      provider: 'openai-compatible',
      protocol: 'chat/completions',
      scope,
      secret: SECRET,
    });
    expect(compatible.prompt_cache_key).toBe(promptCacheKey(scope, SECRET));
    const fireworks: Record<string, unknown> = { model: 'accounts/fireworks/models/x' };
    expect(
      applyPromptCaching(fireworks, {
        provider: 'fireworks',
        protocol: 'chat/completions',
        scope,
        secret: SECRET,
      }),
    ).toEqual({
      markers: 0,
      key: false,
      headers: { [SESSION_AFFINITY_HEADER]: promptCacheKey(scope, SECRET) },
    });
    expect(fireworks).toEqual({ model: 'accounts/fireworks/models/x' });
    // An endpoint with no known control, sent no key, is left alone.
    const other: Record<string, unknown> = { model: 'm' };
    expect(
      applyPromptCaching(other, {
        provider: 'openai-compatible',
        protocol: 'chat/completions',
        scope,
      }),
    ).toEqual({ markers: 0, key: false, headers: {} });
    expect(other).toEqual({ model: 'm' });
  });

  test('no two people, spaces or installs share a key, and an id alone does not give one', () => {
    const service = (
      purpose: string,
      spaceId: string,
      sourceJobId: string | null,
      attemptId: string,
    ) =>
      promptCacheScope({
        jobId: purpose === 'companies' ? 'companies-scan' : `${purpose}:${spaceId}`,
        attemptId,
        privacy: { kind: 'service', purpose, spaceId, sourceJobId },
      });
    const keys = [
      // One fixed job name, two spaces.
      service('companies', 'sp_a', null, 'scan:aaaa'),
      service('companies', 'sp_b', null, 'scan:bbbb'),
      // One space, two people's conversations.
      service('memory', 'sp_a', 'job_person_one', 'memory:work-one'),
      service('memory', 'sp_a', 'job_person_two', 'memory:work-two'),
      // One space, two calls that carry no conversation.
      service('memory', 'sp_a', null, 'memory:work-three'),
      service('memory', 'sp_a', null, 'memory:work-four'),
      service('action_review', 'sp_a', 'job_person_one', 'review:t1'),
      promptCacheScope(job('job_person_one')),
    ].map((scope) => promptCacheKey(scope, SECRET));
    expect(new Set(keys).size).toBe(keys.length);
    // Two installs: the same conversation id under two secrets.
    const scope = promptCacheScope(job('job_a'));
    expect(promptCacheKey(scope, SECRET)).not.toBe(promptCacheKey(scope, `${SECRET}-other`));
    // Without the install's secret the key is not the plain digest of the id.
    expect(promptCacheKey(scope)).not.toBe(promptCacheKey(scope, SECRET));
  });

  test('a cache_control property inside a schema or tool input does not switch the breakpoints off', () => {
    const body = {
      system: 'Melete',
      tools: [{ name: 't', input_schema: { properties: { cache_control: { type: 'string' } } } }],
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'u', name: 't', input: { cache_control: 'x' } }],
        },
      ],
    };
    expect(markAnthropicCache(body)).toBe(3);
  });
});

describe('cached input is charged at its cached price, from the one price table', () => {
  const prices = new PriceTable();

  test('a cache read costs its share, a cache write its premium, the rest full price', () => {
    // Anthropic: 1,000 fresh + 9,000 read at a tenth + 200 written at 1.25.
    expect(
      prices.chargedInputTokens('anthropic', 'claude-sonnet-fixture', {
        inputTokens: 10_200,
        cachedInputTokens: 9_000,
        cacheWriteInputTokens: 200,
        outputTokens: 0,
      }),
    ).toBe(1_000 + 900 + 250);
    expect(
      prices.chargedInputTokens('openai', 'gpt-fixture', {
        inputTokens: 10_000,
        cachedInputTokens: 8_000,
        outputTokens: 0,
      }),
    ).toBe(2_800);
    // Fireworks names no cached price, so its provider's share applies: half.
    expect(
      prices.chargedInputTokens('fireworks', 'accounts/fireworks/models/deepseek-v4p1-flash', {
        inputTokens: 10_000,
        cachedInputTokens: 8_000,
        outputTokens: 0,
      }),
    ).toBe(6_000);
    expect(CACHE_PRICE_SHARE.google?.read).toBe(0.25);
  });

  test('the dollar cost counts the same cached and written input the same way', () => {
    // anthropic/*sonnet*: $3 in, $0.30 cached, a write at 1.25 x $3.
    expect(
      prices.cost('anthropic', 'claude-sonnet-fixture', {
        inputTokens: 1_200_000,
        cachedInputTokens: 1_000_000,
        cacheWriteInputTokens: 100_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.3 + 0.3 * 1.25 + 0.3, 6);
    // Fireworks: half of the input price for a cache read.
    expect(
      prices.cost('fireworks', 'accounts/fireworks/models/llama-fixture', {
        inputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.1, 6);
    // An operator's own price for cached input wins over the share.
    const priced = new PriceTable({ 'fireworks/x': { input: 1, output: 1, cached_input: 0.2 } });
    expect(
      priced.chargedInputTokens('fireworks', 'x', {
        inputTokens: 1_000,
        cachedInputTokens: 1_000,
        outputTokens: 0,
      }),
    ).toBe(200);
  });

  test('an unknown provider is charged as though nothing was cached', () => {
    for (const provider of ['openai-compatible', 'constructor', '__proto__'])
      expect(
        prices.chargedInputTokens(provider, 'm', {
          inputTokens: 10_000,
          cachedInputTokens: 8_000,
          outputTokens: 0,
        }),
      ).toBe(10_000);
  });

  test('impossible cached counts never charge below zero or above the input', () => {
    const openai = (inputTokens: number, cachedInputTokens: number, cacheWriteInputTokens = 0) =>
      prices.chargedInputTokens('openai', 'gpt-fixture', {
        inputTokens,
        cachedInputTokens,
        cacheWriteInputTokens,
        outputTokens: 0,
      });
    expect(openai(100, 500)).toBe(10);
    expect(openai(1, 1)).toBe(1);
    expect(
      prices.chargedInputTokens('anthropic', 'claude-sonnet-fixture', {
        inputTokens: 100,
        cachedInputTokens: 50,
        cacheWriteInputTokens: 500,
        outputTokens: 0,
      }),
    ).toBe(5 + Math.ceil(50 * 1.25));
  });
});
