import { expect, test } from 'bun:test';
import { cronWords } from './cron-words.ts';
import { CRON_FORMAT } from './runs.ts';

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
  expect(cronWords('0 9 * * 1#1')).toBe('On the first Monday of every month at 9:00');
  expect(cronWords('30 17 * * 5#2')).toBe('On the second Friday of every month at 17:30');
  expect(cronWords('0 18 * * 0#5')).toBe('On the fifth Sunday of every month at 18:00');
  expect(cronWords('0 9 * * 5L')).toBe('On the last Friday of every month at 9:00');
});

test('anything else gets a neutral line, never a wrong one', () => {
  for (const cron of [
    '0 9 * 1 *',
    '0 9 1 * 1',
    '*/5 9 * * *',
    '0 9 * * MON',
    '0 9 * * 1#6',
    '0 9 1-7 * 1',
    '0 9 * * 1#1,3#1',
    'nonsense',
    '',
  ])
    expect(cronWords(cron)).toBe('On a set schedule');
});

test('the format the agent is given shows a first-weekday schedule and warns about mixing day and weekday', () => {
  const examples = [...CRON_FORMAT.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  expect(examples).toContain('0 9 * * 1#1');
  expect(cronWords('0 9 * * 1#1')).toBe('On the first Monday of every month at 9:00');
  expect(CRON_FORMAT).toMatch(/0 9 1-7 \* 1" runs every Monday/);
  for (const example of examples.filter((e) => e !== '0 9 1-7 * 1'))
    expect(cronWords(example)).not.toBe('On a set schedule');
});
