import { describe, expect, test } from 'bun:test';
import {
  applyPromptCaching,
  markAnthropicCache,
  promptCacheKey,
  SESSION_AFFINITY_HEADER,
} from './caching.ts';
import { CACHED_INPUT_PRICE, chargedInputTokens, withChargedInput } from './metering.ts';

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
    const openai: Record<string, unknown> = { model: 'gpt-fixture', input: 'hello' };
    expect(
      applyPromptCaching(openai, { provider: 'openai', protocol: 'responses', jobId: 'job_a' }),
    ).toEqual({ markers: 0, key: true, headers: {} });
    expect(openai.prompt_cache_key).toBe(promptCacheKey('job_a'));
    expect(promptCacheKey('job_a')).toMatch(/^[0-9a-f]{32}$/);
    expect(promptCacheKey('job_a')).not.toBe(promptCacheKey('job_b'));
    // The job id itself never leaves.
    expect(String(openai.prompt_cache_key)).not.toContain('job_a');
    const chatgpt: Record<string, unknown> = { prompt_cache_key: 'set-by-the-engine' };
    applyPromptCaching(chatgpt, { provider: 'chatgpt', protocol: 'responses', jobId: 'job_a' });
    expect(chatgpt.prompt_cache_key).toBe('set-by-the-engine');
    const fireworks: Record<string, unknown> = { model: 'accounts/fireworks/models/x' };
    expect(
      applyPromptCaching(fireworks, {
        provider: 'fireworks',
        protocol: 'chat/completions',
        jobId: 'job_a',
      }),
    ).toEqual({
      markers: 0,
      key: false,
      headers: { [SESSION_AFFINITY_HEADER]: promptCacheKey('job_a') },
    });
    expect(fireworks).toEqual({ model: 'accounts/fireworks/models/x' });
    // An endpoint with no known control is left alone.
    const other: Record<string, unknown> = { model: 'm' };
    expect(
      applyPromptCaching(other, {
        provider: 'openai-compatible',
        protocol: 'chat/completions',
        jobId: 'j',
      }),
    ).toEqual({ markers: 0, key: false, headers: {} });
    expect(other).toEqual({ model: 'm' });
  });
});

describe('cached input is charged at its cached price', () => {
  test('a cache read costs its share, a cache write its premium, the rest full price', () => {
    // Anthropic: 1,000 fresh + 9,000 read at a tenth + 200 written at 1.25.
    expect(
      chargedInputTokens(
        { inputTokens: 10_200, cachedInputTokens: 9_000, cacheWriteInputTokens: 200 },
        'anthropic',
      ),
    ).toBe(1_000 + 900 + 250);
    expect(chargedInputTokens({ inputTokens: 10_000, cachedInputTokens: 8_000 }, 'openai')).toBe(
      2_800,
    );
    expect(chargedInputTokens({ inputTokens: 10_000, cachedInputTokens: 8_000 }, 'fireworks')).toBe(
      6_000,
    );
    expect(CACHED_INPUT_PRICE.google?.read).toBe(0.25);
  });

  test('an unknown provider, or the person’s own model, is charged as though nothing was cached', () => {
    for (const provider of ['openai-compatible', 'local', 'constructor', '__proto__'])
      expect(chargedInputTokens({ inputTokens: 10_000, cachedInputTokens: 8_000 }, provider)).toBe(
        10_000,
      );
  });

  test('impossible cached counts never charge below zero or above the input', () => {
    expect(chargedInputTokens({ inputTokens: 100, cachedInputTokens: 500 }, 'openai')).toBe(10);
    expect(
      chargedInputTokens(
        { inputTokens: 100, cachedInputTokens: 50, cacheWriteInputTokens: 500 },
        'anthropic',
      ),
    ).toBe(5 + Math.ceil(50 * 1.25));
    expect(chargedInputTokens({ inputTokens: 1, cachedInputTokens: 1 }, 'openai')).toBe(1);
    expect(
      withChargedInput(
        { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedInputTokens: 0 },
        'openai',
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      cachedInputTokens: 0,
      chargedInputTokens: 10,
    });
  });
});
