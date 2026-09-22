import { expect, test } from 'bun:test';
import { DEFAULT_BUDGET, impossibleBudget } from './service.ts';

test('an output budget of any size is one an attempt can run under', () => {
  expect(impossibleBudget(DEFAULT_BUDGET)).toBeNull();
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_output_tokens: 250_000 })).toBeNull();
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_output_tokens: 10_000_000 })).toBeNull();
});

test('an input limit that cannot hold the framing of one request is refused', () => {
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_input_tokens: 0 })).toContain(
    'max_input_tokens',
  );
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_input_tokens: 256 })).toContain(
    'max_input_tokens',
  );
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_input_tokens: 257 })).toBeNull();
});

test('a wall-time limit longer than a timer can hold is refused', () => {
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_wall_ms: 2 ** 31 })).toContain('max_wall_ms');
  expect(impossibleBudget({ ...DEFAULT_BUDGET, max_wall_ms: 2 ** 31 - 1 })).toBeNull();
});
