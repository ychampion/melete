import { expect, test } from 'bun:test';
import { dayResetLine, usageModelName } from './Usage.tsx';

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
