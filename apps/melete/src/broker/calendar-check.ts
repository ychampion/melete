/**
 * Whether a change on the person's own calendar touches something that
 * matters to them.
 *
 * An event Melete puts on the person's own calendar, with no guests, or a
 * removal of one it made, goes ahead without asking when it can be undone
 * and touches nothing important. Important is read conservatively. A change
 * is important when what it creates, moves or removes:
 *
 * - starts within the next few hours (`IMPORTANT_WITHIN_HOURS`), or has passed;
 * - runs longer than a day;
 * - overlaps a repeating meeting;
 * - overlaps an event with guests;
 * - overlaps an event marked important or high priority;
 * - overlaps an event the person made themselves that blocks the time
 *   (anything not marked free, or declined).
 *
 * Melete's own events with no guests, and the person's events marked free,
 * may be overlapped. A calendar that could not be read in full counts as
 * important too. Each answer is one plain sentence that says why, which the
 * person sees when they are asked.
 */
import type { JsonObject } from '@melete/contracts';
import { instantMs, zonedToUtc } from '../signals/occurrences.ts';
import type { CalendarRead, CalendarWindow, Occurrence } from '../signals/types.ts';

/** A change starting sooner than this asks first. */
export const IMPORTANT_WITHIN_HOURS = 4;

/** The calendar tools this check covers. */
export const OWN_CALENDAR_CHANGES = new Set([
  'calendar.create',
  'calendar.update',
  'calendar.delete',
]);

/** A span of time a change creates, moves or removes. */
export type Span = { start: string; end: string };

/** What a change to the calendar means for the time it touches; null concern is clear. */
export type CalendarCheck = { concern: string | null; reversible: boolean };

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The spans a change touches: the new times of a create or an update, and the
 * times the event had before for an update or a removal (`before`, Melete's
 * own record of the event).
 */
export function spansOf(kind: string, payload: JsonObject, before: JsonObject | null): Span[] {
  const spans: Span[] = [];
  const add = (value: Record<string, unknown>) => {
    if (typeof value.start === 'string' && typeof value.end === 'string')
      spans.push({ start: value.start, end: value.end });
  };
  if (kind === 'calendar.create' || kind === 'calendar.update') add(object(payload));
  if (kind === 'calendar.update' || kind === 'calendar.delete') add(object(before));
  return spans;
}

/** A day either side: an all-day event is a date, which in a time zone far from UTC begins up to 14 hours earlier or ends up to 12 hours later. */
const READ_MARGIN_MS = 86_400_000;

/**
 * The window a calendar is read over to check these spans, a day wider on
 * each side so an all-day event on the person's own day is read even where its
 * date, taken as UTC, would fall outside the spans.
 */
export function windowOf(spans: readonly Span[]): CalendarWindow | null {
  const starts = spans.map((span) => instantMs(span.start));
  const ends = spans.map((span) => instantMs(span.end));
  if (!spans.length || [...starts, ...ends].some(Number.isNaN)) return null;
  return {
    from: new Date(Math.min(...starts) - READ_MARGIN_MS).toISOString(),
    to: new Date(Math.max(...ends) + READ_MARGIN_MS).toISOString(),
  };
}

/** A change longer than this asks first: it would block the person's time for days. */
export const LONGEST_UNASKED_MS = 86_400_000;

/** The earliest a date begins and the latest it ends anywhere on Earth (UTC+14 to UTC−12). */
const EARLIEST_MS = 14 * 3600_000;
const LATEST_MS = 12 * 3600_000;

/** Midnight at the start of a date (`YYYY-MM-DD`) in a time zone, as epoch milliseconds. */
function midnightIn(date: string, zone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, zone);
}

/**
 * The instants an all-day event covers. A date names a day in someone's time
 * zone: the event's own when it says, and the person's. Each such day counts;
 * with neither known, the date is taken as wide as it can be anywhere.
 */
function allDayRanges(occurrence: Occurrence, zones: readonly string[]): [number, number][] {
  const first = occurrence.start.slice(0, 10);
  const endDate = occurrence.end.slice(0, 10);
  const last = endDate > first ? endDate : null;
  const known = [...new Set([occurrence.time_zone, ...zones].filter(Boolean))] as string[];
  const ranges: [number, number][] = [];
  for (const zone of known) {
    try {
      const start = midnightIn(first, zone);
      const end = last ? midnightIn(last, zone) : start + 86_400_000;
      if (Number.isFinite(start) && Number.isFinite(end)) ranges.push([start, end]);
    } catch {
      // An unknown zone name is left to the widest reading below.
    }
  }
  if (ranges.length) return ranges;
  const start = instantMs(first);
  const end = last ? instantMs(last) : start + 86_400_000;
  return [[start - EARLIEST_MS, end + LATEST_MS]];
}

/** An event's title as it can be quoted in one line. */
function titled(occurrence: Occurrence): string {
  // Control and direction-changing characters become spaces, so the title reads as written.
  const title = [...occurrence.title]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0x200b && code <= 0x200f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
        ? ' '
        : char;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return 'an event';
  return `“${title.length > 60 ? `${title.slice(0, 57)}…` : title}”`;
}

const overlaps = (occurrence: Occurrence, span: Span, zones: readonly string[]) => {
  // An all-day event covers its whole day (or days) where the person is.
  const ranges = occurrence.all_day
    ? allDayRanges(occurrence, zones)
    : [[instantMs(occurrence.start), instantMs(occurrence.end)] as [number, number]];
  return ranges.some(([start, end]) => start < instantMs(span.end) && end > instantMs(span.start));
};

/** Why an existing event makes a change important, or null when it may be overlapped. */
function concernAbout(occurrence: Occurrence): string | null {
  const name = titled(occurrence);
  if (occurrence.occurrence !== null) return `It overlaps ${name}, a repeating meeting.`;
  if (occurrence.attendees > 0) return `It overlaps ${name}, which has guests.`;
  if (occurrence.important) return `It overlaps ${name}, which is marked important.`;
  if (!occurrence.melete && !occurrence.transparent && !occurrence.declined)
    return `It overlaps ${name} on your calendar, which blocks that time.`;
  return null;
}

/**
 * Why this change should be the person's to decide, or null when it touches
 * nothing important. `read` is the calendar over `windowOf(spans)`.
 */
export function calendarConcern(input: {
  spans: readonly Span[];
  read: CalendarRead;
  now: number;
  /** The person's time zone, when they chose or confirmed one. */
  zones?: readonly string[];
}): string | null {
  const { spans, read, now } = input;
  const zones = input.zones ?? [];
  if (!spans.length) return 'Melete could not tell when this event is.';
  if (spans.some((span) => instantMs(span.end) - instantMs(span.start) > LONGEST_UNASKED_MS))
    return 'It runs longer than a day.';
  const soon = now + IMPORTANT_WITHIN_HOURS * 3600_000;
  if (spans.some((span) => instantMs(span.start) < soon))
    return `It is within the next ${IMPORTANT_WITHIN_HOURS} hours.`;
  for (const occurrence of read.items) {
    if (occurrence.status === 'cancelled') continue;
    if (!spans.some((span) => overlaps(occurrence, span, zones))) continue;
    const concern = concernAbout(occurrence);
    if (concern) return concern;
  }
  if (!read.complete) return 'Melete could not read all of your calendar around that time.';
  return null;
}
