/**
 * The first-week request set, scored. Precision and recall are over what a
 * first-week installation actually delivers: selection over the skills whose
 * tools are all in its catalog.
 */
import { describe, expect, test } from 'bun:test';
import { loadBuiltInSkills } from './loader.ts';
import { DAY_ONE_TOOLS, SELECTION_REQUESTS, scoreSelection } from './selection-eval.ts';

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
});
