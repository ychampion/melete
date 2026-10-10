/**
 * Every time on screen is on the person's own clock, the zone in their profile
 * that the greeting is said in and routines run on, not this browser's.
 */
import { afterEach, expect, test } from 'bun:test';
import {
  clockTime,
  dayWords,
  dayKey,
  displayZone,
  hourOfDay,
  isYesterday,
  sameDay,
  setDisplayZone,
} from './clock.ts';
import { browserTimeZone } from './timezone.ts';

afterEach(() => setDisplayZone(null));

// 14:56 UTC: 7:56 AM in Los Angeles, 8:26 PM in Kolkata.
const at = new Date('2026-10-10T14:56:00Z');

test('the same instant reads on the profile’s clock, whatever the browser’s zone', () => {
  expect(clockTime(at, 'America/Los_Angeles')).toBe('7:56 AM');
  expect(clockTime(at, 'Asia/Kolkata')).toBe('8:26 PM');
  expect(hourOfDay(at, 'America/Los_Angeles')).toBeCloseTo(7 + 56 / 60);
  expect(hourOfDay(at, 'Asia/Kolkata')).toBeCloseTo(20 + 26 / 60);
});

test('the profile’s zone is used once it is known, and the browser’s only until then', () => {
  setDisplayZone(null);
  expect(displayZone()).toBe(browserTimeZone() ?? 'UTC');
  setDisplayZone('America/Los_Angeles');
  expect(displayZone()).toBe('America/Los_Angeles');
  expect(clockTime(at)).toBe('7:56 AM');
  // A name this browser does not know falls back rather than throwing.
  setDisplayZone('Mars/Olympus_Mons');
  expect(displayZone()).toBe(browserTimeZone() ?? 'UTC');
});

test('today and yesterday are the profile’s days', () => {
  // 1:30 AM on the 11th in Kolkata is still the 10th in Los Angeles.
  const late = new Date('2026-10-10T20:00:00Z');
  expect(dayKey(late, 'Asia/Kolkata')).toBe('2026-10-11');
  expect(dayKey(late, 'America/Los_Angeles')).toBe('2026-10-10');
  expect(sameDay(at, late, 'America/Los_Angeles')).toBe(true);
  expect(sameDay(at, late, 'Asia/Kolkata')).toBe(false);
  expect(isYesterday(at, late, 'Asia/Kolkata')).toBe(true);
  expect(isYesterday(at, late, 'America/Los_Angeles')).toBe(false);
  // Across a month's end, counted on the calendar.
  expect(
    isYesterday(new Date('2026-10-31T12:00:00Z'), new Date('2026-11-01T12:00:00Z'), 'UTC'),
  ).toBe(true);
});

test('a chat started on another day says which day, on the profile’s calendar', () => {
  const now = new Date('2026-10-10T14:56:00Z');
  expect(dayWords(new Date('2026-10-10T02:00:00Z'), now, 'America/Los_Angeles')).toBe('Yesterday');
  expect(dayWords(new Date('2026-10-10T02:00:00Z'), now, 'Asia/Kolkata')).toBe('Today');
  expect(dayWords(new Date('2026-10-03T12:00:00Z'), now, 'UTC')).toBe('Sat, Oct 3');
});
