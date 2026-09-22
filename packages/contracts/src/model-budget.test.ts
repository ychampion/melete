import { expect, test } from 'bun:test';
import {
  FALLBACK_CONTEXT_WINDOW,
  hasKnownContextWindow,
  inputTokenAllowance,
  inputTokenCeiling,
  modelContextWindow,
} from './model-budget.ts';

test("a request's input allowance sets aside its own output and explicit input limits only narrow it", () => {
  expect(inputTokenAllowance('scripted', 8000)).toBe(120000);
  expect(inputTokenAllowance('gpt-6-astra', 8000)).toBe(1042000);
  expect(inputTokenAllowance('scripted', 8000, { max_input_tokens: 150000 })).toBe(120000);
  expect(inputTokenAllowance('scripted', 8000, { max_input_tokens: 2000 })).toBe(2000);
  // A request that asks for the whole window leaves no input, and never less than none.
  expect(inputTokenAllowance('scripted', 200_000)).toBe(0);
});

test('the input ceiling is the window narrowed by an explicit limit, whatever the output budget', () => {
  expect(inputTokenCeiling('scripted', {})).toBe(FALLBACK_CONTEXT_WINDOW);
  expect(inputTokenCeiling('gpt-6-astra', {})).toBe(1_050_000);
  expect(inputTokenCeiling('scripted', { max_input_tokens: 64_000 })).toBe(64_000);
  expect(inputTokenCeiling('scripted', { max_input_tokens: 150_000 })).toBe(128_000);
  // A job budget is accepted as the limits argument; its output ceiling plays no part.
  const budget: { max_output_tokens: number; max_input_tokens?: number } = {
    max_output_tokens: 250_000,
  };
  expect(inputTokenCeiling('scripted', budget)).toBe(128_000);
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
    expect(inputTokenAllowance(name, 8000, { max_input_tokens: 50_000 })).toBe(50_000);
    expect(inputTokenCeiling(name, { max_input_tokens: 50_000 })).toBe(50_000);
  }
});
