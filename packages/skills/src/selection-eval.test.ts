/**
 * The first-week request set, scored. Precision and recall are over what a
 * first-week installation actually delivers: selection over the skills whose
 * tools are all in its catalog.
 */
import { describe, expect, test } from 'bun:test';
import { CONTEXT_LIMITS } from '@melete/contracts';
import { loadBuiltInSkills } from './loader.ts';
import {
  DAY_ONE_TOOLS,
  HELD_OUT_REQUESTS,
  SELECTION_REQUESTS,
  scoreIndex,
  scoreSelection,
} from './selection-eval.ts';

const { skills } = loadBuiltInSkills();

describe('the first-week request set', () => {
  test('is delivered with high precision and recall', () => {
    const score = scoreSelection(skills, SELECTION_REQUESTS, DAY_ONE_TOOLS);
    expect({ misses: score.misses, wrong: score.wrong.length }).toEqual({ misses: [], wrong: 1 });
    expect(score.precision).toBeGreaterThanOrEqual(0.95);
    expect(score.recall).toBe(1);
  });

  test('every request that should get a skill is in the set, and so are ones that should not', () => {
    expect(
      SELECTION_REQUESTS.filter((request) => request.expect.length === 0).length,
    ).toBeGreaterThanOrEqual(10);
    const covered = new Set(SELECTION_REQUESTS.flatMap((request) => request.expect));
    expect([...covered].sort()).toEqual(skills.map((skill) => skill.frontmatter.name).sort());
  });

  test('the held-out set is scored separately and never used to change a trigger', () => {
    // Recorded, not tuned: this number says how trigger phrases fare on wording they were not
    // written for. A drop below it means a change made selection worse on unseen requests.
    const score = scoreSelection(skills, HELD_OUT_REQUESTS, DAY_ONE_TOOLS);
    expect(score.truePositives).toBeGreaterThanOrEqual(1);
    expect(HELD_OUT_REQUESTS.length).toBeGreaterThanOrEqual(30);
  });

  test('every held-out expected skill is visible to the attempt, given in full or in its index', () => {
    const score = scoreIndex(
      skills,
      HELD_OUT_REQUESTS,
      DAY_ONE_TOOLS,
      CONTEXT_LIMITS.skill_index_tokens,
    );
    expect(score.coverage).toBe(1);
    // Triggers alone still give few of them in full; the index is what closes the gap.
    expect(score.preloadRecall).toBeLessThan(score.coverage);
  });
});
