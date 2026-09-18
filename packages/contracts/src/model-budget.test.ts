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

test('a model named after an inherited property is still a model the catalog does not name', () => {
  // A lookup that reaches the object prototype answers with a function, and a
  // function that reaches the allowance arithmetic makes it NaN — which no
  // comparison is ever greater than, so the input-context refusal stops firing
  // altogether rather than failing closed.
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    expect(hasKnownContextWindow(name)).toBe(false);
    expect(modelContextWindow(name)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(inputTokenAllowance(name, { max_output_tokens: 8000, max_input_tokens: 50_000 })).toBe(
      50_000,
    );
  }
});
