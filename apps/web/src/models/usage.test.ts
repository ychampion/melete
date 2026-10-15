import { expect, test } from 'bun:test';
import { dayResetLine, usageGroups, usageModelName } from './Usage.tsx';

const reset = '2026-10-04T00:00:00.000Z';

test("today's count says when it starts again in the reader's own time", () => {
  // Midnight UTC is 5:30 the next morning in India and 5 the same afternoon in San Francisco.
  expect(dayResetLine(reset, new Date('2026-10-03T12:00:00Z'), 'Asia/Kolkata')).toBe(
    'tomorrow at 5:30 AM',
  );
  expect(dayResetLine(reset, new Date('2026-10-03T12:00:00Z'), 'America/Los_Angeles')).toBe(
    'today at 5:00 PM',
  );
  expect(dayResetLine(reset, new Date('2026-10-03T22:10:00Z'), 'UTC')).toBe('tomorrow at 12:00 AM');
  // Past midnight in India the same instant is later today.
  expect(dayResetLine(reset, new Date('2026-10-03T21:40:00Z'), 'Asia/Kolkata')).toBe(
    'today at 5:30 AM',
  );
});

test('a reset further off is given as a date, never as the month', () => {
  expect(dayResetLine(reset, new Date('2026-10-01T12:00:00Z'), 'UTC')).toBe(
    'on October 4 at 12:00 AM',
  );
});

test('usage names each model as a person reads it, never by its provider path', () => {
  expect(usageModelName('accounts/fireworks/models/kimi-k3')).toBe('Kimi K3');
  expect(usageModelName('accounts/fireworks/models/deepseek-v4p1-flash')).toBe(
    'DeepSeek V4.1 Flash',
  );
  expect(usageModelName('accounts/fireworks/models/glm-5p3')).toBe('GLM 5.3');
  expect(usageModelName('nomic-ai/nomic-embed-text-v1.5')).toBe('Memory search');
});

const personal = {
  space_id: 'sp_2',
  name: 'Personal',
  kind: 'personal' as const,
  calls: 1,
  usd: 0.5,
  tokens: 100,
  budget_usd: null,
};

test('spending by space and by person names the limit and marks one that is reached', () => {
  const groups = usageGroups({
    by_space: [
      {
        space_id: 'sp_1',
        name: 'Launch',
        kind: 'shared',
        calls: 12,
        usd: 20,
        tokens: 9000,
        budget_usd: 20,
      },
      personal,
    ],
    by_member: [
      { principal_id: 'p_1', name: 'Ada', calls: 3, usd: 4.2, tokens: 10, limit_usd: 10 },
    ],
  });
  expect(groups.spaces).toEqual([
    { key: 'sp_1', name: 'Launch (room)', line: '$20.00 of $20.00 · 12 calls', reached: true },
    { key: 'sp_2', name: 'Personal', line: '$0.50 · 1 call', reached: false },
  ]);
  // One person, but with a limit of their own: still worth showing.
  expect(groups.members).toEqual([
    { key: 'p_1', name: 'Ada', line: '$4.20 of $10.00 · 3 calls', reached: false },
  ]);
});

test('a single space with no budget, and no people list, add nothing to the totals', () => {
  expect(usageGroups({ by_space: [personal], by_member: null })).toEqual({
    spaces: [],
    members: [],
  });
});
