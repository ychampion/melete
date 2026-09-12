import { expect, test } from 'bun:test';
import { inputTokenAllowance } from './model-budget.ts';

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
