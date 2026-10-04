/**
 * Calendar occurrences, one per instance of a repeating event.
 *
 * A signal is about a particular Tuesday, not about "every Tuesday", so a
 * repeating event is expanded into its instances over a window: the rule
 * (RRULE), the extra dates (RDATE), the removed ones (EXDATE), and the
 * instances someone moved or changed (a VEVENT with a RECURRENCE-ID) replacing
 * the ones they override. The expansion is ical.js's, never a model's.
 *
 * Times are normalised to UTC instants. A time written in a named zone uses
 * the calendar's own VTIMEZONE when it carries one, and the zone's IANA rules
 * when it does not, so 09:00 in New York is 13:00Z in summer and 14:00Z in
 * winter. An all-day event keeps its date.
 */
import ICAL from 'ical.js';
import type { CalendarRead, CalendarWindow, Occurrence, OccurrenceStatus } from './types.ts';

/** Most instances a series is walked through looking for those inside the window. */
export const MAX_EXPANSION_STEPS = 5000;
/** Most occurrences one read hands back, whatever the calendar holds. */
export const MAX_OCCURRENCES = 2000;

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC at `at`, in milliseconds. */
function zoneOffset(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return wall - Math.floor(at / 1000) * 1000;
}

/**
 * A wall-clock time in an IANA zone as a UTC instant. A time that does not
 * exist (inside a spring-forward gap) lands just after the gap, and one that
 * happens twice (in the autumn) takes the first, as calendars do.
 */
export function zonedToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  zone: string,
): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const first = zoneOffset(zone, guess);
  const utc = guess - first;
  const second = zoneOffset(zone, utc);
  return second === first ? utc : guess - second;
}

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** An ical.js time as a UTC ISO instant, or an all-day date. */
export function icalInstant(time: ICAL.Time, zone: string | null): string {
  if (time.isDate) return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}`;
  const tzid = time.zone?.tzid;
  // A zone the calendar defines (or UTC) is ical.js's to apply. A time it
  // could not place reads as floating; a named IANA zone still places it.
  if (tzid && tzid !== 'floating' && time.zone !== ICAL.Timezone.localTimezone)
    return new Date(time.toUnixTime() * 1000).toISOString();
  if (zone && validZone(zone))
    return new Date(
      zonedToUtc(
        {
          year: time.year,
          month: time.month,
          day: time.day,
          hour: time.hour,
          minute: time.minute,
          second: time.second,
        },
        zone,
      ),
    ).toISOString();
  // Floating, with no zone to place it in: read as UTC rather than as this
  // server's own local time, which would differ between installations.
  return new Date(
    Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second),
  ).toISOString();
}

/** Epoch milliseconds of an instant or a date (a date is its UTC midnight). */
export function instantMs(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
}

/** Whether an occurrence overlaps the window at all. */
export function touches(start: string, end: string, window: CalendarWindow): boolean {
  const from = instantMs(window.from);
  const to = instantMs(window.to);
  const begins = instantMs(start);
  const ends = Math.max(instantMs(end), begins);
  if (Number.isNaN(begins)) return false;
  return begins < to && (ends > from || (ends === begins && begins >= from));
}

const statusOf = (value: unknown): OccurrenceStatus => {
  const status = String(value ?? '').toLowerCase();
  return status === 'cancelled' ? 'cancelled' : status === 'tentative' ? 'tentative' : 'confirmed';
};

/** The TZID a property is written in, if any. */
function tzidOf(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstProperty(name)?.getParameter('tzid');
  return typeof value === 'string' && value ? value : null;
}

function attendeesOf(component: ICAL.Component): number {
  return component.getAllProperties('attendee').length;
}

function textOf(component: ICAL.Component, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** The occurrence an event component describes, between `start` and `end`. */
function occurrenceOf(
  component: ICAL.Component,
  uid: string,
  recurrenceId: string | null,
  start: ICAL.Time,
  end: ICAL.Time,
): Occurrence {
  const zone = tzidOf(component, 'dtstart');
  const endZone = tzidOf(component, 'dtend') ?? zone;
  const modified = component.getFirstPropertyValue('last-modified');
  return {
    uid,
    occurrence: recurrenceId,
    title: textOf(component, 'summary'),
    start: icalInstant(start, zone),
    end: icalInstant(end, endZone),
    all_day: start.isDate,
    location: textOf(component, 'location'),
    status: statusOf(component.getFirstPropertyValue('status')),
    attendees: attendeesOf(component),
    time_zone: zone,
    updated_at:
      modified instanceof ICAL.Time ? new Date(modified.toUnixTime() * 1000).toISOString() : null,
  };
}

/** A recurrence id as the key it is kept under: the instance's original start. */
function recurrenceKey(component: ICAL.Component): string | null {
  const value = component.getFirstPropertyValue('recurrence-id');
  if (!(value instanceof ICAL.Time)) return null;
  return icalInstant(value, tzidOf(component, 'recurrence-id'));
}

/**
 * Every occurrence touching the window in one or more iCalendar objects, as a
 * CalDAV collection or a feed holds them. A series is expanded; an instance
 * someone changed replaces the one it overrides, wherever it was moved to; an
 * instance whose series this calendar does not hold (an invitation to one
 * meeting of a series) stands alone.
 */
export function expandIcs(texts: readonly string[], window: CalendarWindow): CalendarRead {
  const out: Occurrence[] = [];
  for (const text of texts) {
    const root = new ICAL.Component(ICAL.parse(text));
    if (root.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
    const byUid = new Map<string, { master?: ICAL.Component; exceptions: ICAL.Component[] }>();
    for (const component of root.getAllSubcomponents('vevent')) {
      const uid = textOf(component, 'uid');
      if (!uid || !component.getFirstProperty('dtstart')) continue;
      const entry = byUid.get(uid) ?? { exceptions: [] };
      if (component.getFirstProperty('recurrence-id')) entry.exceptions.push(component);
      else entry.master = component;
      byUid.set(uid, entry);
    }
    for (const [uid, { master, exceptions }] of byUid) {
      if (!master) {
        for (const exception of exceptions) {
          const event = new ICAL.Event(exception);
          const occurrence = occurrenceOf(
            exception,
            uid,
            recurrenceKey(exception),
            event.startDate,
            event.endDate,
          );
          if (touches(occurrence.start, occurrence.end, window)) out.push(occurrence);
        }
        continue;
      }
      const event = new ICAL.Event(master, { exceptions });
      if (!event.isRecurring()) {
        const occurrence = occurrenceOf(master, uid, null, event.startDate, event.endDate);
        if (touches(occurrence.start, occurrence.end, window)) out.push(occurrence);
        continue;
      }
      const seen = new Set<string>();
      const to = instantMs(window.to);
      const iterator = event.iterator();
      const masterZone = tzidOf(master, 'dtstart');
      for (let step = 0; step < MAX_EXPANSION_STEPS; step++) {
        const next = iterator.next();
        if (!next) break;
        // The rule's own times are in the series' zone; past the window's end
        // no later instance of the rule can be inside it.
        if (instantMs(icalInstant(next, masterZone)) >= to) break;
        const details = event.getOccurrenceDetails(next);
        const item = details.item.component;
        const key = icalInstant(details.recurrenceId, masterZone);
        seen.add(key);
        const occurrence = occurrenceOf(item, uid, key, details.startDate, details.endDate);
        if (touches(occurrence.start, occurrence.end, window)) out.push(occurrence);
      }
      // An instance moved into the window from a date the walk above never
      // reached is still in the window.
      for (const exception of exceptions) {
        const key = recurrenceKey(exception);
        if (key === null || seen.has(key)) continue;
        const moved = new ICAL.Event(exception);
        const occurrence = occurrenceOf(exception, uid, key, moved.startDate, moved.endDate);
        if (touches(occurrence.start, occurrence.end, window)) out.push(occurrence);
      }
    }
  }
  out.sort((a, b) => instantMs(a.start) - instantMs(b.start) || a.uid.localeCompare(b.uid));
  return { items: out.slice(0, MAX_OCCURRENCES), complete: out.length <= MAX_OCCURRENCES };
}
