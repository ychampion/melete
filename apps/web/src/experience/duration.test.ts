import { expect, test } from 'bun:test';
import { lastActivity, spanOf } from './duration.ts';

test('durations read as a person would say them, never as thousands of seconds', () => {
  expect(spanOf(12)).toBe('12s');
  expect(spanOf(59.4)).toBe('59s');
  expect(spanOf(120)).toBe('2 min');
  expect(spanOf(3600)).toBe('1 h');
  expect(spanOf(3900)).toBe('1 h 5 min');
  expect(spanOf(55_820)).toBe('15 h 30 min');
  expect(spanOf(3 * 86_400)).toBe('3 days');
});

test('a turn ends where its last tool entry did', () => {
  expect(lastActivity([])).toBeNull();
  expect(
    lastActivity([
      { started_at: '2026-10-02T10:00:00.000Z', ended_at: '2026-10-02T10:00:05.000Z' },
      { started_at: '2026-10-02T10:01:00.000Z', ended_at: null },
    ]),
  ).toBe(Date.parse('2026-10-02T10:01:00.000Z'));
});
