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
 * - overlaps a repeating meeting;
 * - overlaps an event with guests;
 * - overlaps an event marked important or high priority;
 * - overlaps an event the person made themselves that blocks the time
 *   (anything not marked free).
 *
 * Melete's own events with no guests, and the person's events marked free,
 * may be overlapped. A calendar that could not be read in full counts as
 * important too. Each answer is one plain sentence that says why, which the
 * person sees when they are asked.
 */
import type { JsonObject } from '@melete/contracts';
import { instantMs } from '../signals/occurrences.ts';
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

/** The window a calendar is read over to check these spans. */
export function windowOf(spans: readonly Span[]): CalendarWindow | null {
  const starts = spans.map((span) => instantMs(span.start));
  const ends = spans.map((span) => instantMs(span.end));
  if (!spans.length || [...starts, ...ends].some(Number.isNaN)) return null;
  return {
    from: new Date(Math.min(...starts)).toISOString(),
    to: new Date(Math.max(...ends)).toISOString(),
  };
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

const overlaps = (occurrence: Occurrence, span: Span) => {
  const start = instantMs(occurrence.start);
  // An all-day event covers its whole day (or days).
  const end = occurrence.all_day
    ? Math.max(instantMs(occurrence.end), start + 86_400_000)
    : instantMs(occurrence.end);
  return start < instantMs(span.end) && end > instantMs(span.start);
};

/** Why an existing event makes a change important, or null when it may be overlapped. */
function concernAbout(occurrence: Occurrence): string | null {
  const name = titled(occurrence);
  if (occurrence.occurrence !== null) return `It overlaps ${name}, a repeating meeting.`;
  if (occurrence.attendees > 0) return `It overlaps ${name}, which has guests.`;
  if (occurrence.important) return `It overlaps ${name}, which is marked important.`;
  if (!occurrence.melete && occurrence.busy !== false)
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
}): string | null {
  const { spans, read, now } = input;
  if (!spans.length) return 'Melete could not tell when this event is.';
  const soon = now + IMPORTANT_WITHIN_HOURS * 3600_000;
  if (spans.some((span) => instantMs(span.start) < soon))
    return `It is within the next ${IMPORTANT_WITHIN_HOURS} hours.`;
  for (const occurrence of read.items) {
    if (occurrence.status === 'cancelled') continue;
    if (!spans.some((span) => overlaps(occurrence, span))) continue;
    const concern = concernAbout(occurrence);
    if (concern) return concern;
  }
  if (!read.complete) return 'Melete could not read all of your calendar around that time.';
  return null;
}
