import { expect, test } from 'bun:test';
import {
  FALLBACK_CONTEXT_WINDOW,
  hasKnownContextWindow,
  inputTokenAllowance,
  modelContextWindow,
} from './model-budget.ts';

test('context defaults leave room for output and explicit input limits only narrow them', () => {
  expect(inputTokenAllowance('scripted', { max_output_tokens: 8000 })).toBe(120000);
  expect(inputTokenAllowance('gpt-6-astra', { max_output_tokens: 8000 })).toBe(1042000);
  expect(
    inputTokenAllowance('scripted', { max_output_tokens: 8000, max_input_tokens: 150000 }),
  ).toBe(120000);
  expect(inputTokenAllowance('scripted', { max_output_tokens: 8000, max_input_tokens: 2000 })).toBe(
    2000,
  );
});

test('the catalog names both spellings of the default million-token model', () => {
  expect(modelContextWindow('accounts/fireworks/models/deepseek-v4p1-flash')).toBe(1_000_000);
  expect(modelContextWindow('deepseek-ai/DeepSeek-V4.1-Flash')).toBe(1_000_000);
  expect(hasKnownContextWindow('accounts/fireworks/models/deepseek-v4p1-flash')).toBe(true);
});

test('a model the catalog does not name falls back to the documented window', () => {
  expect(hasKnownContextWindow('a-model-nobody-listed')).toBe(false);
  expect(modelContextWindow('a-model-nobody-listed')).toBe(FALLBACK_CONTEXT_WINDOW);
  expect(FALLBACK_CONTEXT_WINDOW).toBe(128_000);
});
