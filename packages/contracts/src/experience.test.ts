import { describe, expect, test } from 'bun:test';
import {
  agentFaceState,
  canonicalTimeZone,
  conversationCreate,
  experienceOperations,
  permissionDecision,
  profileInput,
  quickOptions,
  standingRuleBounds,
} from './experience.ts';

describe("a person's time zone", () => {
  test('is an IANA name in its canonical spelling, and anything else is UTC', () => {
    expect(canonicalTimeZone('utc')).toBe('UTC');
    expect(canonicalTimeZone('europe/london')).toBe('Europe/London');
    expect(canonicalTimeZone('Pacific/Chatham')).toBe('Pacific/Chatham');
    // An offset names no place and follows no daylight rules.
    expect(canonicalTimeZone('+05:30')).toBe('UTC');
    expect(canonicalTimeZone('-0800')).toBe('UTC');
    expect(canonicalTimeZone('Not/AZone')).toBe('UTC');
    expect(canonicalTimeZone(undefined)).toBe('UTC');
    expect(canonicalTimeZone('')).toBe('UTC');
  });

  test('is saved only by its name', () => {
    const profile = (time_zone: string) =>
      profileInput.safeParse({
        name: 'Alex',
        time_zone,
        day_hours: { start: '08:00', end: '22:00' },
      }).success;
    expect(profile('+05:30')).toBe(false);
    expect(profile('Not/AZone')).toBe(false);
    expect(profile('Asia/Kolkata')).toBe(true);
    expect(profile('utc')).toBe(true);
  });
});

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
