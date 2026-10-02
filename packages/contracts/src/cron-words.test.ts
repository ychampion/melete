import { expect, test } from 'bun:test';
import { cronWords } from './cron-words.ts';

test('common schedules read in plain words', () => {
  expect(cronWords('0 9 * * 1-5')).toBe('Every weekday at 9:00');
  expect(cronWords('30 7 * * *')).toBe('Every day at 7:30');
  expect(cronWords('0 9,17 * * *')).toBe('Every day at 9:00 and 17:00');
  expect(cronWords('0 8 * * 1')).toBe('Every Monday at 8:00');
  expect(cronWords('0 8 * * 0,1,3,5')).toBe('Every Monday, Wednesday, Friday and Sunday at 8:00');
  expect(cronWords('0 10 * * 6,0')).toBe('Every Saturday and Sunday at 10:00');
  expect(cronWords('0 10 * * 0-6')).toBe('Every day at 10:00');
  expect(cronWords('0 9 1,15 * *')).toBe('On the 1st and 15th of every month at 9:00');
  expect(cronWords('0 9 22 * *')).toBe('On the 22nd of every month at 9:00');
  expect(cronWords('0 9 11 * *')).toBe('On the 11th of every month at 9:00');
  expect(cronWords('0 * * * *')).toBe('Every hour');
  expect(cronWords('15 * * * *')).toBe('Every hour, at 15 past');
  expect(cronWords('0 */3 * * *')).toBe('Every 3 hours');
  expect(cronWords('*/30 * * * *')).toBe('Every 30 minutes');
});

test('anything else gets a neutral line, never a wrong one', () => {
  for (const cron of ['0 9 * 1 *', '0 9 1 * 1', '*/5 9 * * *', '0 9 * * MON', 'nonsense', ''])
    expect(cronWords(cron)).toBe('On a set schedule');
});
