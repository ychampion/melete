import type {
  Action,
  ConnectorHealth,
  ConnectorManifest,
  DispatchResult,
  JsonObject,
  VerifyResult,
} from '@melete/contracts';
import { parseRecurrence, type Recurrence, recurrenceWords } from '@melete/contracts';
import { XMLParser } from 'fast-xml-parser';
import ICAL from 'ical.js';
import { z } from 'zod';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import {
  confirmFromIcs,
  expandIcs,
  icalInstant,
  instantMs,
  MAX_EXPANSION_STEPS,
  startNearWindow,
  wallTime,
  zonedToUtc,
} from '../signals/occurrences.ts';
import {
  type CalendarOccurrences,
  type Occurrence,
  type SignalSource,
  sourceError,
} from '../signals/types.ts';
import {
  bindCalendarCheck,
  calendarAhead,
  calendarAsksFirst,
  checkCalendarAhead,
  clearToWrite,
  freeBusy,
  invited,
  MAX_FREEBUSY_DAYS,
} from './calendar-truth.ts';
import { asConnectorFault, ConnectorFaultError } from './faults.ts';
import type { SecretAccess } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/**
 * `Retry-After` is either seconds or an HTTP date. Anything unreadable means
 * the server asked for a wait without saying how long, and the policy uses its
 * own default rather than inventing one here.
 */
export function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isInteger(seconds) && seconds >= 0) return Math.min(seconds, 86_400);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(Math.ceil((at - Date.now()) / 1000), 86_400));
}

export type CalendarConnection = {
  id: string;
  spaceId: string;
} & (
  | {
      mode: 'caldav';
      calendarUrl: string;
      username: string;
      secretRef: string;
      allowInsecureLocalForTests?: boolean;
    }
  | {
      mode: 'ics';
      /** An owner-imported file, never a URL supplied by a runtime. */
      ics: string;
    }
);

export const MAX_CALENDAR_BYTES = 2 * 1024 * 1024;
/** How far ahead a listing looks when the caller names no end. */
export const DEFAULT_LIST_DAYS = 90;
const DAY_MS = 86_400_000;
const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);
export const listPayload = z
  .object({
    limit: z.number().int().min(1).max(100).default(50),
    from: instant.optional(),
    to: instant.optional(),
    time_zone: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || Date.parse(v.to) > Date.parse(v.from), {
    message: '`to` must be after `from`',
  });

export type ListWindow = { from: string; to: string };

/**
 * The window a listing covers. With neither end it starts yesterday, so an
 * event that is under way is still listed, and ends {@link DEFAULT_LIST_DAYS}
 * days later. With only `to`, it is the {@link DEFAULT_LIST_DAYS} days before
 * `to`, so an end in the past never makes an empty, inverted window; with only
 * `from`, it is the same span after `from`. The receipt always carries the
 * window, so whoever reads it knows what was and was not looked at.
 */
export function listWindow(payload: z.infer<typeof listPayload>, now = Date.now()): ListWindow {
  const span = DEFAULT_LIST_DAYS * DAY_MS;
  const to = payload.to
    ? eventInstant(payload.to, payload.time_zone ?? 'UTC')
    : (payload.from ? eventInstant(payload.from, payload.time_zone ?? 'UTC') : now - DAY_MS) + span;
  const from = payload.from
    ? eventInstant(payload.from, payload.time_zone ?? 'UTC')
    : payload.to
      ? to - span
      : now - DAY_MS;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** Events earliest first; one whose start cannot be read goes last. */
export function byStart(events: EventView[]): EventView[] {
  const at = (event: EventView) => {
    const time = Date.parse(event.start);
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  return [...events].sort((a, b) => at(a) - at(b));
}

/**
 * The receipt detail of a listing. `truncated` says more events fall in the
 * window than were returned, so the list must not be presented as complete.
 */
export function listDetail(
  events: EventView[],
  window: ListWindow,
  truncated: boolean,
  readOnly: boolean,
): JsonObject {
  return {
    events,
    read_only: readOnly,
    window,
    truncated,
    ...(truncated
      ? {
          note: events.some((event) => event.recurrence_status === 'unknown')
            ? 'Some repeating events could not be fully checked. Their next occurrence is unavailable; do not treat this list as complete.'
            : `Only the first ${events.length} events in this window are listed; more exist. Ask again with a narrower from/to before treating the list as complete.`,
        }
      : {}),
  };
}
const fields = {
  summary: z.string().min(1).max(1000),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  description: z.string().max(50_000).default(''),
  location: z.string().max(2000).default(''),
  /** Guests to invite, by address. Anyone outside the person's own accounts is asked about first. */
  attendees: z.array(z.email().max(320)).max(50).optional(),
  /** A hold: the time is kept, marked tentative, until it is confirmed or released. */
  tentative: z.boolean().optional(),
  /** Asked for only when the person wants this on top of something already there. */
  double_book: z.strictObject({ reason: z.string().trim().min(1).max(500) }).optional(),
  /** Bound by Melete before anyone is asked (see `bindCalendarCheck`); never the agent's. */
  checked: z.record(z.string(), z.unknown()).optional(),
};
export const createPayload = z
  .object(fields)
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
export const updatePayload = z
  .object({
    ...fields,
    uid: z.string().regex(/^act_[A-Za-z0-9_-]+$/),
    etag: z
      .string()
      .min(1)
      .max(500)
      .regex(/^"[^"\r\n]+"$/),
  })
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start));
export type WritePayload = z.infer<typeof createPayload>;
export const deletePayload = z.strictObject({
  uid: z.string().regex(/^act_[A-Za-z0-9_-]+$/),
  etag: z
    .string()
    .min(1)
    .max(500)
    .regex(/^"[^"\r\n]+"$/),
});
/** The event an update or a removal changes; anything else changes no existing event. */
export function changedUid(action: Pick<Action, 'kind' | 'canonical_payload'>): string {
  if (action.kind === 'calendar.update') return updatePayload.parse(action.canonical_payload).uid;
  if (action.kind === 'calendar.delete') return deletePayload.parse(action.canonical_payload).uid;
  throw new Error('Only an update or a removal changes an event');
}
const properties = {
  summary: { type: 'string', minLength: 1, maxLength: 1000 },
  start: { type: 'string', format: 'date-time' },
  end: { type: 'string', format: 'date-time' },
  description: { type: 'string', maxLength: 50000 },
  location: { type: 'string', maxLength: 2000 },
  attendees: {
    type: 'array',
    maxItems: 50,
    items: { type: 'string', maxLength: 320 },
    description:
      'Email addresses to invite. Inviting anyone outside the person’s own accounts asks the person first. Leave it out to put the event on their calendar only.',
  },
  tentative: {
    type: 'boolean',
    description:
      'true places a hold: the time is kept and marked tentative. Confirm it later with calendar.update and tentative false, or release it with calendar.delete.',
  },
  double_book: {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
    description:
      'Only when the person wants this on top of an event already there. The person is asked, with the reason.',
  },
  checked: {
    type: 'object',
    additionalProperties: true,
    description: 'Filled in by Melete. Leave it out.',
  },
};

/**
 * A free/busy read: a window of at most 62 days, and the zone all-day events are placed in.
 * The window is `start` and `end`: `from` and `to` are address fields to the
 * broker, which compares them in lower case.
 */
export const freebusyPayload = z
  .object({
    start: instant,
    end: instant,
    time_zone: z.string().min(1).max(100).optional(),
    /** Bound by Melete before the read; never the agent's. */
    checked: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((v) => instantMs(v.end) > instantMs(v.start), { message: '`end` must be after `start`' })
  .refine((v) => instantMs(v.end) - instantMs(v.start) <= MAX_FREEBUSY_DAYS * DAY_MS, {
    message: `a window of at most ${MAX_FREEBUSY_DAYS} days`,
  });

/** Free and busy time in a window, as the free/busy tool answers it. */
export async function freebusyDetail(
  source: CalendarOccurrences,
  payload: z.infer<typeof freebusyPayload>,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const window = {
    from: new Date(instantMs(payload.start)).toISOString(),
    to: new Date(instantMs(payload.end)).toISOString(),
  };
  const self = payload.checked?.self;
  const found = await freeBusy(source, window, payload.time_zone ?? 'UTC', {
    ...(signal ? { signal } : {}),
    ...(Array.isArray(self)
      ? { self: self.filter((value): value is string => typeof value === 'string') }
      : {}),
  });
  return {
    ...found,
    ...(found.complete
      ? {}
      : {
          note: 'The calendar has more events in this window than one read covers. Ask again for a shorter window before treating any time as free.',
        }),
  } as unknown as JsonObject;
}
export const calendarManifest: ConnectorManifest = {
  name: 'calendar',
  version: '0.1.0',
  provider: 'caldav',
  description: 'Read imported ICS calendars or read and update an approved CalDAV calendar.',
  credentials: [
    {
      key: 'app_password',
      description: 'CalDAV app password, sealed in the service; unnecessary for an ICS import.',
      secret: true,
    },
  ],
  health: true,
  tools: [
    {
      name: 'calendar.delete',
      description: 'Remove a Melete-created event only if its observed ETag still matches.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid', 'etag'],
        properties: {
          uid: { type: 'string', pattern: '^act_[A-Za-z0-9_-]+$' },
          etag: { type: 'string', maxLength: 500 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.delete'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'calendar.list',
      description:
        'List events and series, earliest first. Series show the next start/end on or after now (or from for explicit windows), recurrence_summary, series_start and ended/unknown status. Defaults: yesterday through 90 days later; one end covers 90 days after from or before to. Date-only windows use the person’s zone. If truncated, narrow the window before calling the list complete.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          from: {
            type: 'string',
            description: 'Start of the window, an ISO date or date-time. Defaults to yesterday.',
          },
          to: {
            type: 'string',
            description:
              'End of the window, an ISO date or date-time after `from`. Defaults to 90 days after `from`.',
          },
          time_zone: {
            type: 'string',
            description: 'IANA zone for floating and all-day events. Defaults to the person’s own.',
          },
        },
      },
      effect_class: 'read',
      required_scopes: ['calendar.list'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'calendar.freebusy',
      description:
        'When the person is busy and free between `start` and `end` (at most 62 days), every repeating event counted. Each busy block names its event and says busy or tentative; events shown as free and invitations they declined leave the time free. All-day events fill the person’s own day. Check this before proposing or booking a time.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: {
          start: { type: 'string', description: 'Start of the window, an ISO date or date-time.' },
          end: { type: 'string', description: 'End of the window, after `start`.' },
          time_zone: {
            type: 'string',
            description: 'IANA zone for all-day events. Defaults to the person’s own.',
          },
          checked: {
            type: 'object',
            additionalProperties: true,
            description: 'Filled in by Melete. Leave it out.',
          },
        },
      },
      effect_class: 'read',
      required_scopes: ['calendar.freebusy'],
      verify: false,
      requires_approval: false,
    },
    {
      name: 'calendar.create',
      description:
        'Create an event whose UID is the action ID. A time already taken is refused, naming what is there. `attendees` invites people; `tentative` places a hold.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'start', 'end'],
        properties,
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.create'],
      verify: true,
      requires_approval: true,
    },
    {
      name: 'calendar.update',
      description:
        'Update a Melete-created event by UID and its last observed ETag. Moving it onto a taken time is refused. `tentative: false` confirms a hold.',
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['uid', 'etag', 'summary', 'start', 'end'],
        properties: {
          ...properties,
          uid: { type: 'string', pattern: '^act_[A-Za-z0-9_-]+$' },
          etag: { type: 'string', maxLength: 500 },
        },
      },
      effect_class: 'write_external',
      required_scopes: ['calendar.update'],
      verify: true,
      requires_approval: true,
    },
  ],
};

/** The receipt of a create or update: the event, its version, and whether it is a hold or invites anyone. */
export function writeDetail(
  uid: string,
  etag: string | null,
  action: Pick<Action, 'id'>,
  payload: WritePayload,
): JsonObject {
  const guests = invited(payload as JsonObject);
  return {
    uid,
    etag,
    action_id: action.id,
    tentative: payload.tentative === true,
    ...(guests.length ? { attendees: guests } : {}),
  };
}

/** The tools a read-only calendar (an import or a feed) offers. */
export const READ_TOOLS = new Set(['calendar.list', 'calendar.freebusy']);

export type EventView = {
  uid: string;
  summary: string;
  start: string;
  end: string;
  description: string;
  location: string;
  recurrence: string | null;
  etag: string | null;
  series_start?: string;
  recurrence_summary?: string;
  recurrence_status?: 'active' | 'ended' | 'unknown';
};

type ParsedEvent = { view: EventView; event: ICAL.Event };

/** Parse structured ICS, including folded/escaped fields, without executing embedded URLs. */
export type CalendarReference = { now?: number; timeZone?: string; includeEnded?: boolean };

export function importIcs(
  ics: string,
  etag: string | null = null,
  reference: CalendarReference = {},
): EventView[] {
  const budget = readBudget();
  return parseIcs(ics, etag).map(({ view, event }) =>
    nextEventView(view, event, reference.now ?? Date.now(), reference.timeZone ?? 'UTC', budget),
  );
}

const propertyZone = (event: ICAL.Event, field: string): string | null => {
  const zone = event.component.getFirstProperty(field)?.getParameter('tzid');
  return typeof zone === 'string' ? zone : null;
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

/** A date-only event fills the person's day, independent of the server's clock. */
function dateInZone(at: number, timeZone: string): string {
  const wall = wallTime(at, timeZone) ?? wallTime(at, 'UTC');
  return wall ? `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}` : '';
}

/**
 * How much ical.js may work on one read's series, in calls to its iterator's
 * stepping functions, across the read and for any one series. Its iterator
 * can loop without end on a rule no date satisfies (a February 30th) and
 * never yields in between, so the guard is inside those calls.
 */
const READ_STEPS = 200_000;
const SERIES_STEPS = 50_000;
/** Larger intervals make ical.js normalise its dates for a very long time. */
const MAX_INTERVAL = 999;

type ReadBudget = { steps: number };
const readBudget = (): ReadBudget => ({ steps: READ_STEPS });

class SeriesTooCostly extends Error {}
let iteratorSteps = Number.POSITIVE_INFINITY;
{
  const stepping = ICAL.RecurIterator.prototype as unknown as Record<
    string,
    (...args: unknown[]) => unknown
  >;
  for (const name of [
    'next_second',
    'next_minute',
    'next_hour',
    'next_day',
    'next_week',
    'next_month',
    'next_year',
    'increment_month',
    'increment_year',
  ]) {
    const original = stepping[name];
    if (typeof original !== 'function') continue;
    stepping[name] = function (this: unknown, ...args: unknown[]) {
      if (--iteratorSteps < 0) throw new SeriesTooCostly();
      return original.apply(this, args);
    };
  }
}

/** Run `work` with at most `steps` iterator steps; returns what it used. */
function withinSteps<T>(steps: number, work: () => T): { value: T; used: number } {
  const outer = iteratorSteps;
  iteratorSteps = steps;
  try {
    const value = work();
    return { value, used: steps - iteratorSteps };
  } finally {
    iteratorSteps = outer;
  }
}

const daysOf = (wall: { year: number; month: number; day: number }) =>
  Math.floor(Date.UTC(wall.year, wall.month - 1, wall.day) / 86_400_000);

/**
 * A rule said in words on the person's own clock, as the card shows its
 * time. `shown` is the instance the words are read from, at `wall` on the
 * series' own clock. When the person's date differs from the series' (a
 * Tuesday 17:00 in UTC is Tuesday morning in California, but 02:00 UTC on
 * Wednesday is Tuesday evening), plain weekdays move with it; a rule tied to
 * dates of the month is said on the series' dates, without a time.
 */
function ruleWords(
  rule: Recurrence,
  shown: number,
  wall: ICAL.Time,
  timeZone: string,
  seriesZone: string,
): string {
  if (wall.isDate) return recurrenceWords(rule, wall, { zone: seriesZone, includeTime: false });
  const local = wallTime(shown, timeZone);
  if (!local) return recurrenceWords(rule, wall, { zone: seriesZone });
  const shift = daysOf(local) - daysOf(wall);
  if (!shift) return recurrenceWords(rule, local, { zone: timeZone });
  const weekdaysOnly =
    !rule.byMonthDay.length &&
    rule.byDay.every((day) => day.nth === null) &&
    (rule.freq === 'DAILY' ||
      rule.freq === 'WEEKLY' ||
      (rule.freq === 'MONTHLY' && rule.byDay.length > 0));
  if (!weekdaysOnly) return recurrenceWords(rule, wall, { zone: seriesZone, includeTime: false });
  const byDay = rule.byDay.map((day) => ({
    ...day,
    weekday: (((day.weekday + shift) % 7) + 7) % 7,
  }));
  return recurrenceWords({ ...rule, byDay }, local, { zone: timeZone });
}

/**
 * Whether an instance is on a date its rule allows. ical.js rolls a date that
 * does not exist into the next month, so a yearly February 29th would come
 * round on March 1st; such an instance is skipped instead (RFC 5545 3.3.10).
 */
function onRuleDate(time: ICAL.Time, rule: ICAL.Recur, first: ICAL.Time): boolean {
  if (rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') return true;
  const parts = rule.parts ?? {};
  if (parts.BYDAY?.length || parts.BYYEARDAY?.length || parts.BYWEEKNO?.length) return true;
  const monthDays = (parts.BYMONTHDAY as number[] | undefined) ?? [];
  const months = (parts.BYMONTH as number[] | undefined) ?? [];
  const length = ICAL.Time.daysInMonth(time.month, time.year);
  const days = monthDays.length
    ? monthDays.map((day) => (day < 0 ? length + 1 + day : day))
    : [first.day];
  if (!days.includes(time.day)) return false;
  if (months.length) return months.includes(time.month);
  return rule.freq !== 'YEARLY' || monthDays.length > 0 || time.month === first.month;
}

/** Whether a rule's month days fall in none of its months (February 30th). */
function neverOnDate(rule: ICAL.Recur): boolean {
  const parts = rule.parts ?? {};
  const monthDays = (parts.BYMONTHDAY as number[] | undefined) ?? [];
  if (!monthDays.length) return false;
  const months = (parts.BYMONTH as number[] | undefined) ?? [];
  const longest = (month: number) => (month === 2 ? 29 : ICAL.Time.daysInMonth(month, 2001));
  return (months.length ? months : [1, 3, 5, 7, 8, 10, 12]).every((month) =>
    monthDays.every((day) => Math.abs(day) > longest(month)),
  );
}

function eventInstant(value: string, timeZone: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return instantMs(value);
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number);
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

/**
 * Project a series onto its next occurrence, retaining its original anchor.
 * The existing iCalendar iterator applies RRULE, COUNT, UNTIL, RDATE, EXDATE
 * and changed instances; the shared timezone conversion preserves wall time
 * across daylight saving changes. Exhaustion and an unfinished read differ.
 *
 * A series that cannot be read within its share of the read's budget, or
 * that ical.js refuses, keeps its first start and says only "Repeats", so
 * one bad invitation never fails the whole list.
 */
export function nextEventView(
  view: EventView,
  event: ICAL.Event,
  from: number,
  timeZone = 'UTC',
  budget: ReadBudget = readBudget(),
): EventView {
  const zone = propertyZone(event, 'dtstart') ?? timeZone;
  const endZone = propertyZone(event, 'dtend') ?? zone;
  const start = icalInstant(event.startDate, zone);
  const end = icalInstant(event.endDate, endZone);
  if (!event.isRecurring()) return { ...view, start, end };
  const unread: EventView = {
    ...view,
    start,
    end,
    series_start: start,
    recurrence_summary: 'Repeats',
    recurrence_status: 'unknown',
  };
  const huge = event.component
    .getAllProperties('rrule')
    .some((property) => (property.getFirstValue() as ICAL.Recur).interval > MAX_INTERVAL);
  if (huge || budget.steps <= 0) return unread;
  const steps = Math.min(budget.steps, SERIES_STEPS);
  let used = steps;
  try {
    const projected = withinSteps(steps, () =>
      projectSeries(view, event, from, timeZone, zone, endZone, start),
    );
    used = projected.used;
    return projected.value ?? unread;
  } catch {
    return unread;
  } finally {
    budget.steps -= used;
  }
}

function projectSeries(
  view: EventView,
  event: ICAL.Event,
  from: number,
  timeZone: string,
  zone: string,
  endZone: string,
  start: string,
): EventView | null {
  const rule = view.recurrence?.split(/\r?\n/).find((line) => /^RRULE:/i.test(line));
  const parsed = parseRecurrence(rule ?? view.recurrence ?? '');
  // The rule's clock: UTC for a time written in UTC, the person's for a
  // floating one, otherwise its own zone.
  const seriesZone = event.startDate.zone?.tzid === 'UTC' ? 'UTC' : zone;
  const words = (shown: number, wall: ICAL.Time) =>
    parsed.ok ? ruleWords(parsed.value, shown, wall, timeZone, seriesZone) : 'On a set schedule';
  const series = { ...view, series_start: start };
  const ended = (): EventView => ({
    ...series,
    recurrence_summary: words(instantMs(start), event.startDate),
    start: '',
    end: '',
    recurrence_status: 'ended',
  });
  const today = dateInZone(from, timeZone);
  // An instance still under way is the current one.
  const eligible = (begins: string, ends: string) => {
    const last = instantMs(ends) > instantMs(begins) ? ends : begins;
    return /^\d{4}-\d{2}-\d{2}$/.test(last)
      ? last > today || begins >= today
      : instantMs(last) > from || instantMs(begins) >= from;
  };
  // startNearWindow changes the event's anchor. Preserve the parsed series so
  // projecting it a second time still counts from the original DTSTART.
  const component = new ICAL.Component(structuredClone(event.component.toJSON()));
  component.parent = event.component.parent;
  const recurs = component
    .getAllProperties('rrule')
    .map((property) => property.getFirstValue() as ICAL.Recur);
  // UNTIL is enforced here on normalized instants: for IANA-only or floating
  // times the iterator cannot compare a UTC UNTIL correctly, and a date-only
  // UNTIL on a timed series runs through that whole local date, where
  // ical.js would stop at its midnight.
  let until =
    parsed.ok && parsed.value.until && 'at' in parsed.value.until
      ? parsed.value.until.at.getTime()
      : null;
  const rrule = recurs.length === 1 ? recurs[0] : undefined;
  if (rrule?.until?.isDate && !event.startDate.isDate) {
    const date = rrule.until;
    // Midnight after the date, on the series' clock (UTC for a zone only the
    // calendar defines), less a millisecond.
    const after = date.clone();
    after.adjust(1, 0, 0, 0);
    until =
      zonedToUtc(
        { year: after.year, month: after.month, day: after.day, hour: 0, minute: 0, second: 0 },
        wallTime(0, seriesZone) ? seriesZone : 'UTC',
      ) - 1;
  }
  // RDATE is independent of RRULE's UNTIL, so keep those candidates apart.
  const extraDates: ICAL.Time[] = [];
  if (until !== null) {
    for (const property of component.getAllProperties('rrule')) {
      const rule = property.getFirstValue();
      if (rule instanceof ICAL.Recur) {
        rule.until = null;
        property.setValue(rule);
      }
    }
    for (const property of component.getAllProperties('rdate')) {
      for (const value of property.getValues())
        if (value instanceof ICAL.Time) extraDates.push(value);
    }
    component.removeAllProperties('rdate');
  }
  if (recurs.some(neverOnDate)) return null;
  // Only a lone rule without extra dates is checked for rolled-over dates.
  const checkDates = rrule && !component.getFirstProperty('rdate') ? rrule : null;
  // An instance that ended two days before `from` cannot be the next one in
  // any zone. An instance someone changed is weighed on its own below.
  const length = Math.max(0, instantMs(icalInstant(event.endDate, endZone)) - instantMs(start));
  const stale = (original: string) => instantMs(original) + length + 2 * 86_400_000 < from;
  // Compare exclusions as instants. An IANA-only TZID is floating to ical.js,
  // so its iterator alone cannot match an EXDATE written in UTC to that zone.
  const excluded = new Set(
    component.getAllProperties('exdate').flatMap((property) => {
      const named = property.getParameter('tzid');
      return property
        .getValues()
        .filter((value): value is ICAL.Time => value instanceof ICAL.Time)
        .map((value) => icalInstant(value, typeof named === 'string' ? named : zone));
    }),
  );
  component.removeAllProperties('exdate');
  const projected = new ICAL.Event(component, { exceptions: Object.values(event.exceptions) });
  startNearWindow(projected, zone, from);
  // The best instance so far, and the regular time its rule gave it, which
  // the rule's words are read from even when this one instance was moved.
  type Shown = { view: EventView; regular: ICAL.Time; at: number };
  let best: Shown | null = null;
  const consider = (
    item: ICAL.Event,
    begins: ICAL.Time,
    ends: ICAL.Time,
    regular: ICAL.Time,
    at: number,
  ): void => {
    if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const start = icalInstant(begins, propertyZone(item, 'dtstart') ?? zone);
    const end = icalInstant(ends, propertyZone(item, 'dtend') ?? endZone);
    if (!eligible(start, end) || (best && instantMs(best.view.start) <= instantMs(start))) return;
    best = {
      view: {
        ...series,
        summary: item.summary ?? view.summary,
        location: item.location ?? view.location,
        start,
        end,
        recurrence_status: 'active',
      },
      regular,
      at,
    };
  };
  const found = (): EventView => {
    const shown = best as Shown | null;
    if (!shown) return ended();
    return { ...shown.view, recurrence_summary: words(shown.at, shown.regular) };
  };
  // An exception can move into the window from beyond the iterator's next
  // date, or move that next date later than the following regular instance.
  for (const exception of Object.values(projected.exceptions)) {
    const id = exception.component.getFirstPropertyValue('recurrence-id');
    const regular = id instanceof ICAL.Time ? id : exception.startDate;
    const key = icalInstant(regular, propertyZone(exception, 'recurrence-id') ?? zone);
    if (id instanceof ICAL.Time && excluded.has(key)) continue;
    consider(exception, exception.startDate, exception.endDate, regular, instantMs(key));
  }
  for (const extra of extraDates) {
    const key = icalInstant(extra, zone);
    if (excluded.has(key)) continue;
    const details = projected.getOccurrenceDetails(extra);
    consider(details.item, details.startDate, details.endDate, extra, instantMs(key));
  }
  const iterator = projected.iterator();
  for (let step = 0; step < MAX_EXPANSION_STEPS; step++) {
    const next = iterator.next();
    if (!next) return found();
    if (step > 0 && checkDates && !onRuleDate(next, checkDates, event.startDate)) continue;
    const original = icalInstant(next, zone);
    if (until !== null && instantMs(original) > until) return found();
    const current = best as Shown | null;
    if (current && instantMs(original) >= instantMs(current.view.start)) return found();
    if (excluded.has(original) || stale(original)) continue;
    const details = projected.getOccurrenceDetails(next);
    consider(details.item, details.startDate, details.endDate, next.clone(), instantMs(original));
  }
  return null;
}

/** The events in a window, earliest first, and whether any were left out. */
export function eventsInWindow(
  parsed: ParsedEvent[],
  window: ListWindow,
  limit: number,
  reference: CalendarReference = {},
): { events: EventView[]; truncated: boolean } {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const zone = reference.timeZone ?? 'UTC';
  const budget = readBudget();
  const inside = parsed
    .flatMap(({ view, event }) => {
      const projected = nextEventView(view, event, reference.now ?? from, zone, budget);
      if (projected.recurrence_status === 'ended')
        return reference.includeEnded ? [{ view: projected, at: Number.POSITIVE_INFINITY }] : [];
      if (projected.recurrence_status === 'unknown') return [{ view: projected, at: from }];
      const at = eventInstant(projected.start, zone);
      const end = eventInstant(projected.end, zone);
      return at < to && (end > from || at >= from) ? [{ view: projected, at }] : [];
    })
    .sort((a, b) => a.at - b.at);
  return {
    events: inside.slice(0, limit).map((item) => item.view),
    truncated:
      inside.length > limit || inside.some(({ view }) => view.recurrence_status === 'unknown'),
  };
}

export function parseIcs(ics: string, etag: string | null = null): ParsedEvent[] {
  if (Buffer.byteLength(ics) > MAX_CALENDAR_BYTES) throw new Error('Calendar import too large');
  const component = new ICAL.Component(ICAL.parse(ics));
  if (component.name !== 'vcalendar') throw new Error('Expected VCALENDAR');
  const components = component.getAllSubcomponents('vevent');
  return components
    .filter(
      (item) =>
        !item.getFirstProperty('recurrence-id') ||
        !components.some(
          (other) =>
            !other.getFirstProperty('recurrence-id') &&
            other.getFirstPropertyValue('uid') === item.getFirstPropertyValue('uid'),
        ),
    )
    .map((item) => {
      const uid = item.getFirstPropertyValue('uid');
      const exceptions = components.filter(
        (other) =>
          !item.getFirstProperty('recurrence-id') &&
          other.getFirstProperty('recurrence-id') &&
          other.getFirstPropertyValue('uid') === uid,
      );
      const event = new ICAL.Event(item, { exceptions });
      if (!event.uid || !event.startDate) throw new Error('Malformed calendar event');
      const view: EventView = {
        uid: event.uid,
        summary: event.summary ?? '',
        start: event.startDate.toString(),
        end: event.endDate.toString(),
        description: event.description ?? '',
        location: event.location ?? '',
        recurrence: item.getFirstPropertyValue('rrule')?.toString() ?? null,
        etag,
      };
      return { view, event };
    });
}

function eventIcs(
  action: Action,
  uid: string,
  payload: WritePayload,
  organizer: string | null,
): string {
  const calendar = new ICAL.Component('vcalendar');
  calendar.updatePropertyWithValue('version', '2.0');
  calendar.updatePropertyWithValue('prodid', '-//Melete//Calendar//EN');
  const component = new ICAL.Component('vevent');
  component.updatePropertyWithValue('uid', uid);
  component.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(action.created_at), true),
  );
  component.updatePropertyWithValue('dtstart', ICAL.Time.fromJSDate(new Date(payload.start), true));
  component.updatePropertyWithValue('dtend', ICAL.Time.fromJSDate(new Date(payload.end), true));
  component.updatePropertyWithValue('summary', payload.summary);
  component.updatePropertyWithValue('description', payload.description);
  component.updatePropertyWithValue('location', payload.location);
  component.updatePropertyWithValue('status', payload.tentative ? 'TENTATIVE' : 'CONFIRMED');
  component.updatePropertyWithValue('transp', 'OPAQUE');
  const guests = invited(payload as JsonObject);
  if (guests.length && organizer)
    component.updatePropertyWithValue('organizer', `mailto:${organizer}`);
  for (const guest of guests) {
    const attendee = new ICAL.Property('attendee');
    attendee.setParameter('partstat', 'NEEDS-ACTION');
    attendee.setParameter('rsvp', 'TRUE');
    attendee.setValue(`mailto:${guest}`);
    component.addProperty(attendee);
  }
  component.updatePropertyWithValue('x-melete-action-id', action.id);
  component.updatePropertyWithValue('x-melete-payload-hash', action.payload_hash);
  calendar.addSubcomponent(component);
  return `${calendar.toString()}\r\n`;
}

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Shared with the calendar feed reader so both stop at the same size. */
export async function boundedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? '0') > MAX_CALENDAR_BYTES)
    throw new Error('Calendar response too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_CALENDAR_BYTES) throw new Error('Calendar response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString('utf8');
}

const xmlText = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
/** An instant as CalDAV's time-range wants it: `20261005T120000Z`. */
const caldavTime = (iso: string) =>
  new Date(Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso))
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/**
 * Narrows a REPORT to the events touching a window, which the server works
 * out with their recurrence rules, or to one event by its UID, so a large
 * calendar is never read whole.
 */
function eventFilter(only: { window?: ListWindow; uid?: string }): string {
  if (only.uid !== undefined)
    return `<c:prop-filter name="UID"><c:text-match collation="i;octet">${xmlText(only.uid)}</c:text-match></c:prop-filter>`;
  if (only.window)
    return `<c:time-range start="${caldavTime(only.window.from)}" end="${caldavTime(only.window.to)}"/>`;
  return '';
}

export class CalendarConnector implements Connector {
  readonly manifest: ConnectorManifest;
  private readonly base: URL | null;

  constructor(
    private readonly config: CalendarConnection,
    private readonly secrets: SecretAccess,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.manifest =
      config.mode === 'ics'
        ? {
            ...calendarManifest,
            credentials: [],
            tools: calendarManifest.tools.filter((tool) => READ_TOOLS.has(tool.name)),
          }
        : calendarManifest;
    this.base = config.mode === 'caldav' ? new URL(config.calendarUrl) : null;
    if (this.base && config.mode === 'caldav') {
      const local =
        config.allowInsecureLocalForTests &&
        ['127.0.0.1', '[::1]', 'localhost'].includes(this.base.hostname);
      if (
        (this.base.protocol !== 'https:' && !(local && this.base.protocol === 'http:')) ||
        this.base.username ||
        this.base.password ||
        this.base.search ||
        this.base.hash
      )
        throw new Error('CalDAV requires a trusted HTTPS calendar URL');
      if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    }
    if (config.mode === 'ics') parseIcs(config.ics);
  }

  private assertContext(action: Action, ctx: ConnectorContext): void {
    if (
      action.connection_id !== this.config.id ||
      ctx.space_id !== this.config.spaceId ||
      action.job_id !== ctx.job_id ||
      ctx.idempotency_key !== action.id ||
      action.idempotency_key !== action.id
    )
      throw new Error('Calendar action context mismatch');
    ctx.signal?.throwIfAborted();
  }

  private request(
    method: string,
    uid: string | null,
    body: string | null,
    ctx?: ConnectorContext,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const config = this.config;
    if (config.mode !== 'caldav' || !this.base) throw new Error('Imported calendars are read-only');
    if (uid && !/^act_[A-Za-z0-9_-]+$/.test(uid)) throw new Error('Invalid calendar UID');
    const url = uid ? new URL(`${encodeURIComponent(uid)}.ics`, this.base) : this.base;
    return this.secrets.withSecret(config.secretRef, config.spaceId, (password) =>
      this.fetcher(url, {
        method,
        headers: {
          ...headers,
          authorization: `Basic ${Buffer.from(`${config.username}:${password}`).toString('base64')}`,
        },
        body,
        redirect: 'error',
        signal: ctx?.signal
          ? AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000),
      }),
    );
  }

  private success(action: Action, detail: JsonObject, uid: string | null = null): DispatchResult {
    return {
      outcome: 'succeeded',
      receipt: {
        action_id: action.id,
        connection_id: action.connection_id,
        external_ref: uid,
        detail,
        received_at: new Date().toISOString(),
        late: false,
      },
    };
  }

  /** Every calendar object the collection holds, as iCalendar text with its ETag. */
  private async calendarObjects(
    ctx?: ConnectorContext,
    only: { window?: ListWindow; uid?: string } = {},
  ): Promise<{ ics: string; etag: string | null }[]> {
    const response = await this.request(
      'REPORT',
      null,
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">${eventFilter(only)}</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
      ctx,
      { depth: '1', 'content-type': 'application/xml; charset=utf-8' },
    );
    if (response.status !== 207) throw await sourceError(response);
    const xml = await boundedText(response);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('XML declarations are not accepted');
    const parsed: unknown = new XMLParser({
      removeNSPrefix: true,
      ignoreAttributes: true,
    }).parse(xml);
    const objects: { ics: string; etag: string | null }[] = [];
    for (const item of array(object(object(parsed).multistatus).response)) {
      for (const propstat of array(object(item).propstat)) {
        const prop = object(object(propstat).prop);
        if (
          typeof prop['calendar-data'] === 'string' &&
          /\s200\s/.test(String(object(propstat).status))
        ) {
          objects.push({
            ics: prop['calendar-data'],
            etag: typeof prop.getetag === 'string' ? prop.getetag : null,
          });
        }
      }
    }
    return objects;
  }

  /**
   * Every occurrence touching the window, a repeating event expanded into its
   * instances. An imported file is read as it was imported; a CalDAV
   * collection is read fresh.
   */
  readonly signals: SignalSource = {
    stream: 'calendar',
    occurrences: async (window, options) =>
      expandIcs(
        this.config.mode === 'ics'
          ? [this.config.ics]
          : (
              await this.calendarObjects(
                options?.signal ? ({ signal: options.signal } as ConnectorContext) : undefined,
                { window },
              )
            ).map((object) => object.ics),
        window,
        undefined,
        [...this.selfAddresses(), ...(options?.self ?? [])],
        options?.zone ?? null,
      ),
    confirm: async ({ uid, occurrence }) =>
      confirmFromIcs(
        this.config.mode === 'ics'
          ? [this.config.ics]
          : (await this.calendarObjects(undefined, { uid })).map((object) => object.ics),
        uid,
        occurrence,
      ),
  };

  /** The account's own address, when its user name is one: who organises and who declined. */
  private selfAddresses(): string[] {
    return this.config.mode === 'caldav' && /^[^\s@]+@[^\s@]+$/.test(this.config.username)
      ? [this.config.username]
      : [];
  }

  /** The event a change rewrites, which never conflicts with itself. */
  private static mine(uid: string | null) {
    return uid ? (occurrence: Occurrence) => occurrence.uid === uid : undefined;
  }

  /** What a write would land on, read before the proposal's lock. */
  async ahead(
    proposal: Pick<Action, 'kind' | 'canonical_payload'>,
    ctx: ConnectorContext,
    sql: Query,
  ): Promise<JsonObject | null> {
    if (this.config.mode !== 'caldav') return null;
    const uid = proposal.canonical_payload.uid;
    const mine = CalendarConnector.mine(typeof uid === 'string' ? uid : null);
    return calendarAhead(this.signals as CalendarOccurrences, proposal, {
      sql,
      ctx,
      connectionId: this.config.id,
      ...(mine ? { mine } : {}),
    });
  }

  async prepare(payload: JsonObject, ctx: ConnectorContext, tx: Query, kind?: string) {
    // Guests are invited by the account that organises the event; a CalDAV
    // account whose user name is not an address cannot be named as one.
    if (
      (kind === 'calendar.create' || kind === 'calendar.update') &&
      invited(payload).length &&
      !this.selfAddresses().length
    )
      throw new BrokerFault(
        'payload_invalid',
        'This calendar’s account name is not an email address, so it cannot send invitations. Create the event without attendees, or use a calendar signed in with its address.',
      );
    return bindCalendarCheck(payload, ctx, tx, kind);
  }

  checkAhead(proposal: Pick<Action, 'kind' | 'canonical_payload'>, ctx: ConnectorContext) {
    checkCalendarAhead(proposal, ctx);
  }

  asksFirst(action: Pick<Action, 'kind' | 'canonical_payload'>): boolean {
    return calendarAsksFirst(action);
  }

  async execute(action: Action, ctx: ConnectorContext): Promise<DispatchResult> {
    let dispatched = false;
    try {
      this.assertContext(action, ctx);
      if (action.kind === 'calendar.freebusy') {
        const payload = freebusyPayload.parse(action.canonical_payload);
        try {
          return this.success(
            action,
            await freebusyDetail(this.signals as CalendarOccurrences, payload, ctx.signal),
          );
        } catch {
          return {
            outcome: 'failed',
            reason: 'The calendar could not be read just now.',
            retryable: true,
          };
        }
      }
      if (action.kind === 'calendar.list') {
        const payload = listPayload.parse(action.canonical_payload);
        const now = Date.now();
        const window = listWindow(payload, now);
        const reference = {
          now: payload.from || payload.to ? Date.parse(window.from) : now,
          timeZone: payload.time_zone ?? 'UTC',
          includeEnded: !payload.from && !payload.to,
        };
        if (this.config.mode === 'ics') {
          const listed = eventsInWindow(
            parseIcs(this.config.ics),
            window,
            payload.limit,
            reference,
          );
          return this.success(action, listDetail(listed.events, window, listed.truncated, true));
        }
        const events: ParsedEvent[] = [];
        for (const object of await this.calendarObjects(ctx, { window }))
          events.push(...parseIcs(object.ics, object.etag));
        const listed = eventsInWindow(events, window, payload.limit, reference);
        return this.success(action, listDetail(listed.events, window, listed.truncated, false));
      }
      if (this.config.mode === 'ics')
        return {
          outcome: 'failed',
          reason: 'Imported ICS calendars are read-only.',
          retryable: false,
        };
      if (action.kind === 'calendar.delete') {
        const payload = deletePayload.parse(action.canonical_payload);
        dispatched = true;
        const response = await this.request('DELETE', payload.uid, null, ctx, {
          'if-match': payload.etag,
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 300)
          return this.success(action, { uid: payload.uid, removed: true }, payload.uid);
        return [401, 403, 404, 409, 412].includes(response.status)
          ? {
              outcome: 'failed',
              reason: 'The event changed or could not be removed.',
              retryable: false,
            }
          : { outcome: 'unknown', reason: 'Removal was not confirmed. Check the calendar.' };
      }
      if (action.kind !== 'calendar.create' && action.kind !== 'calendar.update')
        return { outcome: 'failed', reason: 'Unknown calendar tool.', retryable: false };
      const update =
        action.kind === 'calendar.update' ? updatePayload.parse(action.canonical_payload) : null;
      const payload = update ?? createPayload.parse(action.canonical_payload);
      const uid = update?.uid ?? action.id;
      const blocked = await clearToWrite(
        this.signals as CalendarOccurrences,
        payload as JsonObject & WritePayload,
        CalendarConnector.mine(uid),
        { actionId: action.id, ...(ctx.signal ? { signal: ctx.signal } : {}) },
      );
      // A change that does not say whether it is a hold keeps what the event is now.
      const tentative =
        payload.tentative ??
        (update ? (await this.currentStatus(update.uid, ctx)) === 'TENTATIVE' : false);
      if (blocked) return blocked;
      const ics = eventIcs(action, uid, { ...payload, tentative }, this.selfAddresses()[0] ?? null);
      const condition: Record<string, string> = update
        ? { 'if-match': update.etag }
        : { 'if-none-match': '*' };
      await ctx.beforeCalendarWrite?.();
      dispatched = true;
      const response = await this.request('PUT', uid, ics, ctx, {
        'content-type': 'text/calendar; charset=utf-8',
        ...condition,
      });
      await response.body?.cancel();
      if (response.status >= 200 && response.status < 300)
        return this.success(
          action,
          writeDetail(uid, response.headers.get('etag'), action, { ...payload, tentative }),
          uid,
        );
      // Three statuses mean something specific enough to repair rather than
      // report. All three are definitive non-execution: the server answered
      // the write and did not perform it.
      if (response.status === 429) {
        throw new ConnectorFaultError({
          kind: 'rate_limited',
          detail: 'the calendar server asked to be left alone for a while',
          retry_after: retryAfterSeconds(response.headers.get('retry-after')),
        });
      }
      if (response.status === 401) {
        throw new ConnectorFaultError({
          kind: 'expired_credential',
          detail: 'the calendar server refused the credential this write carried',
        });
      }
      if (response.status === 403) {
        throw new ConnectorFaultError({
          kind: 'revoked_credential',
          detail: 'the calendar server no longer permits this account to write',
        });
      }
      if ([400, 404, 409, 412, 415, 422].includes(response.status))
        return {
          outcome: 'failed',
          reason: `Calendar server rejected the write (${response.status}).`,
          retryable: false,
        };
      return {
        outcome: 'unknown',
        reason: 'Calendar write was not confirmed. Verify its UID before deciding.',
      };
    } catch (error) {
      // A typed fault has already said what happened; do not flatten it into a
      // guess about the outcome.
      if (asConnectorFault(error)) throw error;
      return dispatched
        ? {
            outcome: 'unknown',
            reason: 'Calendar write was not acknowledged. Verify its UID before deciding.',
          }
        : {
            outcome: 'failed',
            reason: 'Calendar request rejected or connection unavailable.',
            retryable: false,
          };
    }
  }

  /** The STATUS the event stored under `uid` has now, upper case; null when it has none. */
  private async currentStatus(uid: string, ctx: ConnectorContext): Promise<string | null> {
    const response = await this.request('GET', uid, null, ctx);
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
    const event = calendar
      .getAllSubcomponents('vevent')
      .find((component) => new ICAL.Event(component).uid === uid);
    const status = event?.getFirstPropertyValue('status');
    return typeof status === 'string' ? status.toUpperCase() : null;
  }

  /** The attendees of the event an update rewrites, across every instance stored under its UID. */
  async existingGuests(action: Action, ctx: ConnectorContext): Promise<number> {
    this.assertContext(action, ctx);
    const uid = changedUid(action);
    const response = await this.request('GET', uid, null, ctx);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Calendar event unavailable');
    }
    const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
    const events = calendar
      .getAllSubcomponents('vevent')
      .filter((component) => new ICAL.Event(component).uid === uid);
    if (events.length === 0) throw new Error('Calendar event unavailable');
    return events.reduce(
      (count, component) => count + component.getAllProperties('attendee').length,
      0,
    );
  }

  async verify(action: Action, ctx: ConnectorContext): Promise<VerifyResult> {
    if (this.config.mode === 'caldav' && action.kind === 'calendar.delete') {
      try {
        this.assertContext(action, ctx);
        const payload = deletePayload.parse(action.canonical_payload);
        const response = await this.request('GET', payload.uid, null, ctx);
        await response.body?.cancel();
        // Absence proves the desired state, but cannot attribute an uncertain deletion.
        return {
          decision: 'undecided',
          reason:
            response.status === 404
              ? 'The event is absent, but this removal has no acknowledgement.'
              : 'The event removal could not be confirmed.',
        };
      } catch {
        return { decision: 'undecided', reason: 'Calendar verification unavailable.' };
      }
    }
    if (this.config.mode === 'ics' || !['calendar.create', 'calendar.update'].includes(action.kind))
      return {
        decision: 'unsupported',
        reason: 'This calendar operation has no external verification.',
      };
    try {
      this.assertContext(action, ctx);
      const update =
        action.kind === 'calendar.update' ? updatePayload.parse(action.canonical_payload) : null;
      const payload = update ?? createPayload.parse(action.canonical_payload);
      const uid = update?.uid ?? action.id;
      const response = await this.request('GET', uid, null, ctx);
      if (!response.ok) {
        await response.body?.cancel();
        return {
          decision: 'undecided',
          reason:
            'Calendar UID unavailable; absence cannot establish whether a write previously happened.',
        };
      }
      const calendar = new ICAL.Component(ICAL.parse(await boundedText(response)));
      const events = calendar.getAllSubcomponents('vevent');
      const found = events.find((component) => {
        const event = new ICAL.Event(component);
        return (
          event.uid === uid &&
          component.getFirstPropertyValue('x-melete-action-id') === action.id &&
          component.getFirstPropertyValue('x-melete-payload-hash') === action.payload_hash &&
          event.summary === payload.summary &&
          (event.description ?? '') === payload.description &&
          (event.location ?? '') === payload.location &&
          event.startDate.toUnixTime() * 1000 === Date.parse(payload.start) &&
          event.endDate.toUnixTime() * 1000 === Date.parse(payload.end)
        );
      });
      if (!found)
        return {
          decision: 'undecided',
          reason: 'Calendar resource does not confirm this exact action and payload.',
        };
      const result = this.success(action, { uid, verified_action_id: action.id }, uid);
      return {
        decision: 'succeeded',
        evidence: { uid, action_id: action.id, payload_hash: action.payload_hash },
        receipt: result.outcome === 'succeeded' ? result.receipt : null,
      };
    } catch {
      return { decision: 'undecided', reason: 'Calendar verification unavailable.' };
    }
  }

  async health(): Promise<ConnectorHealth> {
    try {
      if (this.config.mode === 'ics') parseIcs(this.config.ics);
      else {
        const response = await this.request(
          'PROPFIND',
          null,
          '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
          undefined,
          { depth: '0', 'content-type': 'application/xml' },
        );
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403)
          return {
            status: 'failing',
            detail: 'Calendar connection unavailable.',
            checked_at: new Date().toISOString(),
            reason: 'credential_refused',
          };
        if (response.status !== 207) throw new Error('Calendar unavailable');
      }
      return {
        status: 'ok',
        detail: 'Calendar is available.',
        checked_at: new Date().toISOString(),
      };
    } catch {
      return {
        status: 'failing',
        detail: 'Calendar connection unavailable.',
        checked_at: new Date().toISOString(),
      };
    }
  }
}
