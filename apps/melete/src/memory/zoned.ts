/**
 * Local days and local wall times in a person's time zone, computed from the
 * platform's own tz database. A local day is not always 24 hours: the day the
 * clocks change is 23 or 25, and every window here is built from local wall
 * times so it follows the person's calendar rather than a fixed number of hours.
 */
import { calendarDay, dateFormat } from '../dates.ts';
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
 * (the spring-forward gap) lands as far after the gap's start as it was meant
 * to be after it, so 02:30 in a one-hour gap is 03:30; one that happens twice
 * (the fall-back hour) is its first occurrence, so something set for that time
 * happens as soon as the clock first shows it, and once.
 */
export function zonedInstant(day: string, time: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, date, hour, minute);
  // The offsets in force a day either side cover any single change of clocks.
  const before = zoneOffsetMinutes(timeZone, new Date(wall - 86_400_000));
  const after = zoneOffsetMinutes(timeZone, new Date(wall + 86_400_000));
  const shows = (offset: number) =>
    zoneOffsetMinutes(timeZone, new Date(wall - offset * 60_000)) === offset;
  const candidates = [...new Set([before, after, zoneOffsetMinutes(timeZone, new Date(wall))])]
    .filter(shows)
    .map((offset) => wall - offset * 60_000);
  if (candidates.length) return new Date(Math.min(...candidates));
  // Skipped: read the wall time with the offset from before the change.
  return new Date(wall - before * 60_000);
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
  const parts = dateFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('month')} ${get('day')}`;
}

/** The local time of day, "HH:MM", at an instant. */
export function localTime(at: Date, timeZone: string): string {
  const parts = dateFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}
