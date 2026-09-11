import { describe, expect, test } from 'bun:test';
import { normalizeAudience, qualifiedAudience } from './principals.ts';
import { skillFrontmatter } from './skills.ts';

describe('space-qualified skill audiences', () => {
  const spaceId = `sp_${'01J'.padEnd(26, '0')}`;
  test('preserves a qualified audience and refuses a different container', () => {
    const parsed = skillFrontmatter.parse({
      name: 'shared-check',
      description: 'A shared check.',
      triggers: ['check'],
      audience: `space:${spaceId}`,
    });
    expect(parsed.audience).toBe(`space:${spaceId}`);
    const audience = parsed.audience;
    if (!audience) throw new Error('Expected preserved audience');
    expect(normalizeAudience(audience, spaceId)).toEqual({
      audience: 'space',
      space_id: spaceId,
    });
    expect(() => normalizeAudience(audience, `sp_${'02J'.padEnd(26, '0')}`)).toThrow();
    expect(qualifiedAudience.safeParse('space:../../private').success).toBe(false);
  });
});
