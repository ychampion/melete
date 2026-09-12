import { expect, test } from 'bun:test';
import { describeDate, describeDay, numericDate } from './dates.ts';

// 19:00 UTC on Thursday 10 September is already Friday in Kolkata and still
// Thursday in Los Angeles. Every string below is built from named parts, so it
// reads the same on every ICU build.
const at = new Date('2026-09-10T19:00:00Z');

test('the day, the date and the numeric date come from parts in the profile zone', () => {
  expect(describeDate(at, 'Asia/Kolkata')).toBe('Friday, 11 September');
  expect(describeDate(at, 'America/Los_Angeles')).toBe('Thursday, 10 September');
  expect(describeDay(at)).toBe('10 September');
  expect(numericDate(at)).toBe('10/09/2026');
  expect(numericDate(new Date('2026-01-01T00:30:00Z'), 'Asia/Kolkata')).toBe('01/01/2026');
});

test('no rendering depends on the locale string punctuation', () => {
  const rendered = describeDate(at, 'UTC');
  expect(rendered.split(', ')).toEqual(['Thursday', '10 September']);
});
