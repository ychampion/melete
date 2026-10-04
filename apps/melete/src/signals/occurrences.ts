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
import type {
  CalendarRead,
  CalendarWindow,
  Confirmed,
  Occurrence,
  OccurrenceStatus,
} from './types.ts';

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
 * A wall-clock time in an IANA zone as a UTC instant. A time that happens twice
 * (in the autumn) takes the first. A time that does not exist (inside a
 * spring-forward gap) is read with the offset in force before the gap, as
 * RFC 5545 says, so 02:30 on the morning New York springs forward is 03:30
 * daylight time.
 */
export function zonedToUtc(
  wall: { year: number; month: number; day: number; hour: number; minute: number; second: number },
  zone: string,
): number {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // The offsets on either side of any change near this time.
  const offsets = [
    ...new Set([zoneOffset(zone, guess - 86_400_000), zoneOffset(zone, guess + 86_400_000)]),
  ];
  const valid = offsets
    .filter((offset) => zoneOffset(zone, guess - offset) === offset)
    .map((offset) => guess - offset);
  if (valid.length) return Math.min(...valid);
  return guess - Math.min(...offsets);
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

/**
 * What the event says about how much it matters: TRANSP:TRANSPARENT is free
 * time, PRIORITY 1 to 4 is high, and a category named important or high
 * priority marks it too. Only what the event states is kept.
 */
function marksOf(component: ICAL.Component): { busy?: boolean; important?: boolean } {
  const transp = String(component.getFirstPropertyValue('transp') ?? '').toUpperCase();
  const priority = Number(component.getFirstPropertyValue('priority') ?? 0);
  const categories = component
    .getAllProperties('categories')
    .flatMap((property) => property.getValues())
    .map((value) => String(value).trim().toLowerCase());
  const important =
    (Number.isInteger(priority) && priority >= 1 && priority <= 4) ||
    categories.some((value) => value === 'important' || value === 'high priority');
  return {
    ...(transp === 'TRANSPARENT' ? { busy: false } : transp === 'OPAQUE' ? { busy: true } : {}),
    ...(important ? { important: true } : {}),
  };
}

/** Melete names every event it makes by the action that made it. */
const MELETE_UID = /^act_[A-Za-z0-9_-]+$/;

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
    ...marksOf(component),
    ...(MELETE_UID.test(uid) ? { melete_uid: uid } : {}),
  };
}

/** A recurrence id as the key it is kept under: the instance's original start. */
function recurrenceKey(component: ICAL.Component): string | null {
  const value = component.getFirstPropertyValue('recurrence-id');
  if (!(value instanceof ICAL.Time)) return null;
  return icalInstant(value, tzidOf(component, 'recurrence-id'));
}

/**
 * How much one read may spend expanding repeating events, across every series
 * in it: instances walked, occurrences kept, and time. A feed is written by
 * whoever publishes it, and a calendar collects other people's invitations, so
 * neither decides how long the service works on it.
 */
export type ExpansionBudget = { steps: number; occurrences: number; ms: number };
export const EXPANSION_BUDGET: ExpansionBudget = {
  steps: 20_000,
  occurrences: MAX_OCCURRENCES,
  ms: 2_000,
};
/** How many instances are walked between two yields to other work. */
const YIELD_EVERY = 250;

/** A calendar a read cannot finish within its budget. It is skipped, and the reason is kept. */
export class CalendarTooLarge extends Error {
  readonly code = 'calendar_too_large';
  constructor() {
    super(
      'This calendar has more repeating events than one read can check, so its changes are skipped until it is smaller.',
    );
  }
}

const SECONDS: Record<string, number> = {
  SECONDLY: 1,
  MINUTELY: 60,
  HOURLY: 3600,
  DAILY: 86_400,
  WEEKLY: 604_800,
};

/**
 * Move a long-running series' first instance up to just before the window,
 * by a whole number of its periods, so an old daily meeting is walked from
 * this week rather than from the year it began. The instances it yields are
 * the same ones, at the same wall-clock times, under the same recurrence ids.
 * A rule with COUNT is left alone: its last instance depends on where it began.
 */
function startNearWindow(event: ICAL.Event, zone: string | null, from: number): void {
  const rules = event.component.getAllProperties('rrule');
  if (rules.length !== 1) return;
  const rule = rules[0]?.getFirstValue() as ICAL.Recur | undefined;
  if (!rule || rule.count || !rule.freq) return;
  const interval = Math.max(1, rule.interval || 1);
  const start = event.startDate;
  const began = instantMs(icalInstant(start, zone));
  // Two days of margin, for a change of offset and for an instance under way.
  const gap = from - began - 2 * 86_400_000;
  if (!(gap > 0)) return;
  const moved = start.clone();
  const unit = SECONDS[rule.freq];
  if (unit) {
    const periods = Math.floor(gap / (unit * 1000 * interval)) * interval;
    if (periods <= 0) return;
    if (unit >= 86_400) moved.adjust((periods * unit) / 86_400, 0, 0, 0);
    else moved.adjust(0, 0, 0, periods * unit);
  } else if (rule.freq === 'MONTHLY' || rule.freq === 'YEARLY') {
    if (start.day > 28) return;
    const step = rule.freq === 'YEARLY' ? 12 * interval : interval;
    const months = Math.floor(gap / (31 * 86_400_000) / step) * step;
    if (months <= 0) return;
    const total = start.month - 1 + months;
    moved.year = start.year + Math.floor(total / 12);
    moved.month = (total % 12) + 1;
  } else return;
  const duration = event.duration;
  const endZone = tzidOf(event.component, 'dtend');
  const hadEnd = Boolean(event.component.getFirstProperty('dtend'));
  event.startDate = moved;
  // Setting a time drops the zone it was written in; it is put back.
  if (zone) event.component.getFirstProperty('dtstart')?.setParameter('tzid', zone);
  if (hadEnd) {
    const end = moved.clone();
    end.addDuration(duration);
    event.endDate = end;
    if (endZone) event.component.getFirstProperty('dtend')?.setParameter('tzid', endZone);
  }
}

/**
 * Every occurrence touching the window in one or more iCalendar objects, as a
 * CalDAV collection or a feed holds them. A series is expanded; an instance
 * someone changed replaces the one it overrides, wherever it was moved to; an
 * instance whose series this calendar does not hold (an invitation to one
 * meeting of a series) stands alone.
 *
 * The whole read shares one budget and yields to other work as it goes. A
 * calendar that would exceed it is refused with {@link CalendarTooLarge}
 * rather than read in part.
 */
export async function expandIcs(
  texts: readonly string[],
  window: CalendarWindow,
  budget: ExpansionBudget = EXPANSION_BUDGET,
): Promise<CalendarRead> {
  const out: Occurrence[] = [];
  const began = performance.now();
  const from = instantMs(window.from);
  const to = instantMs(window.to);
  let steps = 0;
  const spend = async () => {
    steps += 1;
    if (steps > budget.steps) throw new CalendarTooLarge();
    if (steps % YIELD_EVERY === 0) {
      if (performance.now() - began > budget.ms) throw new CalendarTooLarge();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const keep = (occurrence: Occurrence) => {
    if (!touches(occurrence.start, occurrence.end, window)) return;
    if (out.length >= budget.occurrences) throw new CalendarTooLarge();
    out.push(occurrence);
  };
  for (const text of texts) {
    const root = new ICAL.Component(ICAL.parse(text));
    if (root.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
    const byUid = new Map<string, { master?: ICAL.Component; exceptions: ICAL.Component[] }>();
    for (const component of root.getAllSubcomponents('vevent')) {
      await spend();
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
          await spend();
          const event = new ICAL.Event(exception);
          keep(
            occurrenceOf(exception, uid, recurrenceKey(exception), event.startDate, event.endDate),
          );
        }
        continue;
      }
      const event = new ICAL.Event(master, { exceptions });
      if (!event.isRecurring()) {
        await spend();
        keep(occurrenceOf(master, uid, null, event.startDate, event.endDate));
        continue;
      }
      const masterZone = tzidOf(master, 'dtstart');
      startNearWindow(event, masterZone, from);
      const seen = new Set<string>();
      const iterator = event.iterator();
      for (let step = 0; step < MAX_EXPANSION_STEPS; step++) {
        await spend();
        const next = iterator.next();
        if (!next) break;
        // The rule's own times are in the series' zone; past the window's end
        // no later instance of the rule can be inside it.
        if (instantMs(icalInstant(next, masterZone)) >= to) break;
        const details = event.getOccurrenceDetails(next);
        const item = details.item.component;
        const key = icalInstant(details.recurrenceId, masterZone);
        seen.add(key);
        keep(occurrenceOf(item, uid, key, details.startDate, details.endDate));
      }
      // An instance moved into the window from a date the walk above never
      // reached is still in the window.
      for (const exception of exceptions) {
        const key = recurrenceKey(exception);
        if (key === null || seen.has(key)) continue;
        await spend();
        const moved = new ICAL.Event(exception);
        keep(occurrenceOf(exception, uid, key, moved.startDate, moved.endDate));
      }
    }
  }
  out.sort((a, b) => instantMs(a.start) - instantMs(b.start) || a.uid.localeCompare(b.uid));
  return { items: out, complete: true };
}

/**
 * What became of one occurrence, read from the calendar objects that hold its
 * event: `gone` when the event is not there at all or the instance was
 * removed (EXDATE), the occurrence where it now is when a single event or a
 * changed instance moved, and `unknown` otherwise.
 */
export function confirmFromIcs(
  texts: readonly string[],
  uid: string,
  occurrence: string | null,
): Confirmed {
  let master: ICAL.Component | undefined;
  const exceptions: ICAL.Component[] = [];
  for (const text of texts) {
    const root = new ICAL.Component(ICAL.parse(text));
    for (const component of root.getAllSubcomponents('vevent')) {
      if (textOf(component, 'uid') !== uid || !component.getFirstProperty('dtstart')) continue;
      if (component.getFirstProperty('recurrence-id')) exceptions.push(component);
      else master = component;
    }
  }
  if (!master && !exceptions.length) return 'gone';
  if (occurrence === null) {
    if (!master || master.getFirstProperty('rrule')) return 'unknown';
    const event = new ICAL.Event(master);
    return occurrenceOf(master, uid, null, event.startDate, event.endDate);
  }
  const changed = exceptions.find((exception) => recurrenceKey(exception) === occurrence);
  if (changed) {
    const event = new ICAL.Event(changed);
    return occurrenceOf(changed, uid, occurrence, event.startDate, event.endDate);
  }
  if (!master) return 'gone';
  for (const property of master.getAllProperties('exdate')) {
    const zone = property.getParameter('tzid');
    for (const value of property.getValues())
      if (
        value instanceof ICAL.Time &&
        icalInstant(value, typeof zone === 'string' ? zone : null) === occurrence
      )
        return 'gone';
  }
  return 'unknown';
}
