import { expect, test } from 'bun:test';
import {
  BASELINE_CONTEXT_BUDGET,
  CONTEXT_BUDGET_CAPS,
  contextBudget,
  contextBudgetForWindow,
} from './context-budget.ts';
import { CONTEXT_LIMITS } from './runtime.ts';

test('a model the catalog does not name keeps the thin-harness numbers exactly', () => {
  const unknown = contextBudget('a-model-nobody-listed');
  expect(unknown).toEqual(BASELINE_CONTEXT_BUDGET);
  expect(unknown).toMatchObject({
    window: 128_000,
    identity_tokens: CONTEXT_LIMITS.identity_tokens,
    max_skills: 3,
    skill_tokens: 400,
    knowledge_tokens: 2_000,
    max_tools: 15,
    core_catalog_tokens: 750,
    catalog_index_tokens: 250,
    skill_index_tokens: 500,
    // 32,000 characters of serialized transcript, as before.
    transcript_tokens: 8_000,
    transcript_messages: 100,
  });
});

test('a window smaller than the baseline never gets less than the baseline', () => {
  expect(contextBudgetForWindow(32_000)).toMatchObject({
    ...BASELINE_CONTEXT_BUDGET,
    window: 32_000,
  });
  expect(contextBudgetForWindow(Number.NaN)).toEqual(BASELINE_CONTEXT_BUDGET);
  expect(contextBudgetForWindow(-1)).toEqual(BASELINE_CONTEXT_BUDGET);
});

test('a million-token model gets room for its catalog, skills, knowledge and a long transcript', () => {
  const large = contextBudget('accounts/fireworks/models/deepseek-v4p1-flash');
  expect(large).toMatchObject({
    window: 1_000_000,
    identity_tokens: 250,
    skill_tokens: 400,
    max_skills: 6,
    knowledge_tokens: 8_000,
    max_tools: 64,
    core_catalog_tokens: 5_859,
    catalog_index_tokens: 1_000,
    skill_index_tokens: 2_000,
    transcript_tokens: 62_500,
    transcript_messages: 781,
  });
});

test('every budget grows with the window, never past its cap', () => {
  let previous = BASELINE_CONTEXT_BUDGET;
  for (const window of [200_000, 400_000, 1_000_000, 2_000_000, 10_000_000]) {
    const budget = contextBudgetForWindow(window);
    for (const [key, cap] of Object.entries(CONTEXT_BUDGET_CAPS)) {
      const name = key as keyof typeof CONTEXT_BUDGET_CAPS;
      expect(budget[name]).toBeGreaterThanOrEqual(previous[name]);
      expect(budget[name]).toBeLessThanOrEqual(cap);
    }
    previous = budget;
  }
  expect(contextBudgetForWindow(10_000_000)).toMatchObject(CONTEXT_BUDGET_CAPS);
});

test('a 200,000-token window sits between the two, in proportion', () => {
  expect(contextBudgetForWindow(200_000)).toMatchObject({
    max_skills: 4,
    knowledge_tokens: 3_125,
    max_tools: 23,
    core_catalog_tokens: 1_171,
    transcript_tokens: 12_500,
  });
});
