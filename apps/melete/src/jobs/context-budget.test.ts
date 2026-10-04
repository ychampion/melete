import { expect, test } from 'bun:test';
import { BASELINE_CONTEXT_BUDGET } from '@melete/contracts';
import { attemptContextBudget } from './context-budget.ts';

const LARGE = 'accounts/fireworks/models/deepseek-v4p1-flash';
const defaults = { maxTurns: 150, compactionMaxTokens: 200_000, contextWindowLimit: undefined };

test("an attempt's budget is held to the job's input ceiling, the stated window and the trigger", () => {
  // Four tenths of the trigger the engine is configured with once pictures have
  // their reserve in the gateway's body: 0.4 x 131,072.
  expect(attemptContextBudget(LARGE, {}, defaults).transcript_tokens).toBe(52_428);
  // What ran before with a 60,000-token ceiling runs the same now.
  expect(attemptContextBudget(LARGE, { max_input_tokens: 60_000 }, defaults)).toMatchObject({
    ...BASELINE_CONTEXT_BUDGET,
    window: 60_000,
  });
  expect(attemptContextBudget(LARGE, {}, { ...defaults, contextWindowLimit: 200_000 }).window).toBe(
    200_000,
  );
  // A low compaction cap keeps the transcript at the baseline.
  expect(
    attemptContextBudget(LARGE, {}, { ...defaults, compactionMaxTokens: 16_000 }).transcript_tokens,
  ).toBe(BASELINE_CONTEXT_BUDGET.transcript_tokens);
});
