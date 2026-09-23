import { describe, expect, test } from 'bun:test';
import { CONTEXT_LIMITS } from '@melete/contracts';
import { indexLine, indexSkills, loadBuiltInSkills } from './loader.ts';
import { estimateTokens } from './tokens.ts';

const { skills } = loadBuiltInSkills();

describe('the skill index an attempt carries', () => {
  test('names every built-in in one line each, within the allowance', () => {
    const index = indexSkills('', '', skills, CONTEXT_LIMITS.skill_index_tokens);
    expect(index.map((entry) => entry.name).sort()).toEqual(
      skills.map((skill) => skill.frontmatter.name).sort(),
    );
    const cost = estimateTokens(index.map((entry) => `${indexLine(entry)}\n`).join(''));
    expect(cost).toBeLessThanOrEqual(CONTEXT_LIMITS.skill_index_tokens);
    expect(JSON.stringify(index)).not.toContain('Read the thread before writing');
  });

  test('puts what the request matches first, so a tight allowance keeps it', () => {
    const tight = indexSkills('Summarise this PDF', 'Summarise this PDF', skills, 40);
    expect(tight[0]?.name).toBe('summarize-a-source');
    expect(
      estimateTokens(tight.map((entry) => `${indexLine(entry)}\n`).join('')),
    ).toBeLessThanOrEqual(40);
  });

  test('an allowance too small for any line gives an empty index', () => {
    expect(indexSkills('', '', skills, 1)).toEqual([]);
  });
});
