import { describe, expect, test } from 'bun:test';
import { inputTokenCeiling } from '@melete/contracts';
import { STACK_JOB_BUDGET } from './compose.ts';

describe('the budget stack jobs are submitted with', () => {
  test("leaves the scripted model's requests room for their input", () => {
    // `configure.ts --fake` names this model; the stack scenarios all run on it.
    expect(inputTokenCeiling('scripted', STACK_JOB_BUDGET)).toBeGreaterThanOrEqual(32_000);
  });
});
