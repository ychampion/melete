/**
 * Local days and local wall times in a person's time zone, computed from the
 * platform's own tz database. A local day is not always 24 hours: the day the
 * clocks change is 23 or 25, and every window here is built from local wall
 * times so it follows the person's calendar rather than a fixed number of hours.
 */
import { calendarDay } from '../dates.ts';
import { zoneOffsetMinutes } from './tier0.ts';

/** "2026-09-27": the calendar day it is at that instant in that zone. */
export const localDay = (at: Date, timeZone: string) => calendarDay(at, timeZone);

/** The day `days` after (or before) a calendar day, as a calendar day. */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** 0 for Sunday through 6 for Saturday, of a calendar day. */
export function weekdayOf(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/**
 * The instant a local wall time happens in a zone. A wall time the clocks skip
 * (the spring-forward gap) lands just after the gap; one that happens twice
 * (the fall-back hour) is its first occurrence.
 */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  const first = zoneOffsetMinutes(timeZone, new Date(wall));
  const guess = wall - first * 60_000;
  const second = zoneOffsetMinutes(timeZone, new Date(guess));
  if (second === first) return new Date(guess);
  // The offset changed between the two readings: take the earlier instant that
  // still shows this wall time, or the moment right after a skipped one.
  const earlier = wall - Math.max(first, second) * 60_000;
  return localDay(new Date(earlier), timeZone) === day &&
    zoneOffsetMinutes(timeZone, new Date(earlier)) === Math.max(first, second)
    ? new Date(earlier)
    : new Date(wall - Math.min(first, second) * 60_000);
}

/** One local calendar day as a half-open window of instants. */
export function dayWindow(day: string, timeZone: string): { start: Date; end: Date } {
  return {
    start: zonedInstant(day, '00:00', timeZone),
    end: zonedInstant(addDays(day, 1), '00:00', timeZone),
  };
}

/** "Sep 29": month and day, as a person reads a recent date. */
export function shortDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}`;
}

/** The local time of day, "HH:MM", at an instant. */
export function localTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}
