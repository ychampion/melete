/**
 * Dates for people, assembled from parts rather than taken from a locale
 * string. `Intl` names a weekday or a month the same way on every build, but the
 * punctuation between them is the ICU version's choice ("Saturday, 12
 * September" on one host, "Saturday 12 September" on another), and a projector
 * that renders differently on two machines is a projector with a bug on one.
 */

export type CalendarParts = { weekday: string; day: number; month: string; year: number };

export function calendarParts(at: Date, timeZone: string): CalendarParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: get('weekday'),
    day: Number(get('day')),
    month: get('month'),
    year: Number(get('year')),
  };
}

/** "12 September" */
export function describeDay(at: Date, timeZone = 'UTC'): string {
  const { day, month } = calendarParts(at, timeZone);
  return `${day} ${month}`;
}

/** "Saturday, 12 September" */
export function describeDate(at: Date, timeZone = 'UTC'): string {
  const { weekday, day, month } = calendarParts(at, timeZone);
  return `${weekday}, ${day} ${month}`;
}

/** "12/09/2026": day first, the way en-GB writes it. */
export function numericDate(at: Date, timeZone = 'UTC'): string {
  const { day, year } = calendarParts(at, timeZone);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone, month: '2-digit' }).format(at);
  return `${String(day).padStart(2, '0')}/${month}/${year}`;
}

/** "2026-09-12": the calendar day it is at that instant in that zone, sortable as text. */
export function calendarDay(at: Date, timeZone = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
