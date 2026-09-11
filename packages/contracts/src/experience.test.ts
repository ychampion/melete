import { describe, expect, test } from 'bun:test';
import {
  agentFaceState,
  conversationCreate,
  experienceOperations,
  permissionDecision,
  quickOptions,
  standingRuleBounds,
} from './experience.ts';

describe('experience contracts', () => {
  test('all fifteen surfaces have explicit operations', () => {
    expect(Object.keys(experienceOperations).length).toBeGreaterThanOrEqual(55);
    expect(agentFaceState.options).toHaveLength(9);
  });
  test('conversation requests cannot supply session identities', () => {
    expect(
      conversationCreate.safeParse({ title: 'Dinner', agent_id: 'agent-1', space_id: 'elsewhere' })
        .success,
    ).toBe(false);
    expect(
      conversationCreate.safeParse({
        title: 'Dinner',
        agent_id: 'agent-1',
        owner_id: 'someone-else',
      }).success,
    ).toBe(false);
  });
  test('always requires each standing-grant bound', () => {
    expect(permissionDecision.safeParse({ option: 'always', version: 'v1' }).success).toBe(false);
    const bounds = { count_cap: 5, expires_at: '2026-10-01T00:00:00Z', reconsent_after_days: 7 };
    for (const key of Object.keys(bounds)) {
      const incomplete: Record<string, unknown> = { ...bounds };
      delete incomplete[key];
      expect(standingRuleBounds.safeParse(incomplete).success).toBe(false);
    }
    expect(permissionDecision.safeParse({ option: 'always', version: 'v1', bounds }).success).toBe(
      true,
    );
  });
  test('quick answers reject duplicate identities and a fifth option', () => {
    expect(
      quickOptions.safeParse([
        { id: 'a', label: 'Yes' },
        { id: 'a', label: 'No' },
      ]).success,
    ).toBe(false);
    expect(
      quickOptions.safeParse(
        Array.from({ length: 5 }, (_, i) => ({ id: String(i), label: 'Choice' })),
      ).success,
    ).toBe(false);
  });
});
