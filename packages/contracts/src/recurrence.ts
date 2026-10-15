/**
 * Calendar rules for schedules: the RFC 5545 RRULE subset a person's routine
 * needs and cron cannot say, such as "every other Friday" or "the last
 * weekday of the month". A rule is read with a start, a local date and time in
 * the schedule's time zone, which anchors INTERVAL and sets the time of day.
 *
 * Supported: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, BYDAY (with
 * ordinals such as 1MO or -1FR under MONTHLY and YEARLY), BYMONTHDAY (negative
 * counts from the month's end), BYMONTH, COUNT, UNTIL and WKST. Dates a rule
 * names that do not exist (the 31st of a short month, February 29 in a common
 * year) are skipped, as RFC 5545 says. A start time that falls in a daylight
 * saving gap moves forward by the gap's length; one that happens twice takes
 * the first.
 */

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;

/** How a calendar rule is written, said wherever one is asked for or refused. */
export const RRULE_FORMAT =
  'Write an RFC 5545 rule with FREQ (DAILY, WEEKLY, MONTHLY or YEARLY) and any of INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT and UNTIL, and give its first time as starts, a local date and time such as "2026-10-16T09:00": "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR" is every other Friday from that start, "FREQ=MONTHLY;BYDAY=-1FR" the last Friday of each month and "FREQ=MONTHLY;BYMONTHDAY=-1" the last day of each month.';

export type Frequency = (typeof FREQS)[number];

/** A weekday in a rule: 0 is Sunday. `nth` is set for "the 2nd Monday" (2) or "the last Friday" (-1). */
export interface RuleDay {
  weekday: number;
  nth: number | null;
}

/** A local date and time with no zone of its own. */
export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface Recurrence {
  freq: Frequency;
  interval: number;
  byDay: RuleDay[];
  byMonthDay: number[];
  byMonth: number[];
  count: number | null;
  /** The last moment the rule may produce, inclusive: an instant, or a local time in the schedule's zone. */
  until: { at: Date } | { local: LocalTime } | null;
  /** The day weeks begin on for WEEKLY with an INTERVAL: 1 (Monday) unless WKST says otherwise. */
  weekStart: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

const fail = (problem: string): { ok: false; problem: string } => ({ ok: false, problem });

function wholeNumber(text: string): number | null {
  return /^[+-]?\d{1,4}$/.test(text) ? Number(text) : null;
}

function list<T>(value: string, read: (part: string) => T | null): T[] | null {
  const out: T[] = [];
  for (const part of value.split(',')) {
    const item = read(part.trim());
    if (item === null) return null;
    out.push(item);
  }
  return out;
}

/** `20261016`, `20261016T090000` (local) or `20261016T090000Z` (UTC). */
function readUntil(text: string): Recurrence['until'] {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part ?? 0));
  const local = {
    year: year ?? 0,
    month: month ?? 0,
    day: day ?? 0,
    hour: match[4] === undefined ? 23 : (hour ?? 0),
    minute: match[4] === undefined ? 59 : (minute ?? 0),
    second: match[4] === undefined ? 59 : (second ?? 0),
  };
  if (!validLocal(local)) return null;
  if (match[7])
    return {
      at: new Date(
        Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second),
      ),
    };
  return { local };
}

/**
 * Reads a rule such as `FREQ=WEEKLY;INTERVAL=2;BYDAY=FR`, with or without its
 * `RRULE:` name. Every refusal says what to change.
 */
export function parseRecurrence(text: string): Parsed<Recurrence> {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (!body) return fail(`The rule is empty. ${RRULE_FORMAT}`);
  if (/^DTSTART/i.test(body) || /\n/.test(body))
    return fail('Give only the RRULE part here; the first time goes in starts.');
  const parts = new Map<string, string>();
  for (const piece of body.split(';')) {
    if (!piece) continue;
    const at = piece.indexOf('=');
    if (at <= 0) return fail(`"${piece.slice(0, 40)}" is not NAME=VALUE. ${RRULE_FORMAT}`);
    const name = piece.slice(0, at).trim().toUpperCase();
    if (parts.has(name)) return fail(`${name} is given twice.`);
    parts.set(
      name,
      piece
        .slice(at + 1)
        .trim()
        .toUpperCase(),
    );
  }
  const known = new Set([
    'FREQ',
    'INTERVAL',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'COUNT',
    'UNTIL',
    'WKST',
  ]);
  for (const name of parts.keys())
    if (!known.has(name))
      return fail(
        `${name.slice(0, 20)} is not supported here. Use FREQ, INTERVAL, BYDAY, BYMONTHDAY, BYMONTH, COUNT and UNTIL; the time of day comes from starts.`,
      );
  const freq = parts.get('FREQ');
  if (!freq) return fail(`The rule needs a FREQ. ${RRULE_FORMAT}`);
  if (!(FREQS as readonly string[]).includes(freq))
    return fail(
      `FREQ=${freq.slice(0, 20)} is not supported: use DAILY, WEEKLY, MONTHLY or YEARLY. For something more often than daily, use a cron.`,
    );
  const frequency = freq as Frequency;

  let interval = 1;
  if (parts.has('INTERVAL')) {
    const value = wholeNumber(parts.get('INTERVAL') ?? '');
    if (value === null || value < 1 || value > 999)
      return fail('INTERVAL must be a whole number from 1 to 999.');
    interval = value;
  }

  let byDay: RuleDay[] = [];
  if (parts.has('BYDAY')) {
    const days = list(parts.get('BYDAY') ?? '', (part) => {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part);
      if (!match) return null;
      const nth = match[1] === undefined ? null : Number(match[1]);
      if (nth !== null && (nth === 0 || Math.abs(nth) > 53)) return null;
      return { weekday: WEEKDAY_CODES.indexOf(match[2] as (typeof WEEKDAY_CODES)[number]), nth };
    });
    if (!days?.length)
      return fail(
        'BYDAY takes days such as MO,WE,FR, or with a number, 1MO (the first Monday) or -1FR (the last Friday).',
      );
    if (days.some((day) => day.nth !== null)) {
      if (frequency === 'DAILY' || frequency === 'WEEKLY')
        return fail(
          'A numbered day such as 1MO or -1FR needs FREQ=MONTHLY (or YEARLY): "FREQ=MONTHLY;BYDAY=1MO" is the first Monday of each month.',
        );
      if (frequency === 'MONTHLY' && days.some((day) => day.nth !== null && Math.abs(day.nth) > 5))
        return fail('In a month, a numbered day runs from 1 to 5 or -1 to -5.');
    }
    byDay = days;
  }

  let byMonthDay: number[] = [];
  if (parts.has('BYMONTHDAY')) {
    if (frequency === 'WEEKLY')
      return fail('BYMONTHDAY does not go with FREQ=WEEKLY; use FREQ=MONTHLY.');
    const days = list(parts.get('BYMONTHDAY') ?? '', (part) => {
      const value = wholeNumber(part);
      return value !== null && value !== 0 && Math.abs(value) <= 31 ? value : null;
    });
    if (!days?.length)
      return fail('BYMONTHDAY takes days from 1 to 31, or -1 (the last day) to -31.');
    byMonthDay = days;
  }

  let byMonth: number[] = [];
  if (parts.has('BYMONTH')) {
    const months = list(parts.get('BYMONTH') ?? '', (part) => {
      const value = wholeNumber(part);
      return value !== null && value >= 1 && value <= 12 ? value : null;
    });
    if (!months?.length) return fail('BYMONTH takes months from 1 (January) to 12 (December).');
    byMonth = [...new Set(months)].sort((a, b) => a - b);
  }

  let count: number | null = null;
  if (parts.has('COUNT')) {
    const value = wholeNumber(parts.get('COUNT') ?? '');
    if (value === null || value < 1 || value > 9999)
      return fail('COUNT must be a whole number from 1 to 9999.');
    count = value;
  }

  let until: Recurrence['until'] = null;
  if (parts.has('UNTIL')) {
    if (count !== null) return fail('Give COUNT or UNTIL, not both.');
    until = readUntil(parts.get('UNTIL') ?? '');
    if (!until)
      return fail('UNTIL is a date such as 20261231, or a time such as 20261231T170000Z.');
  }

  let weekStart = 1;
  if (parts.has('WKST')) {
    const index = WEEKDAY_CODES.indexOf(parts.get('WKST') as (typeof WEEKDAY_CODES)[number]);
    if (index < 0) return fail('WKST is a day code such as MO or SU.');
    weekStart = index;
  }

  return {
    ok: true,
    value: { freq: frequency, interval, byDay, byMonthDay, byMonth, count, until, weekStart },
  };
}

// ---------------------------------------------------------------------------
// Calendar arithmetic on local dates, as days since 1970-01-01.

function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function civil(days: number): { year: number; month: number; day: number } {
  const date = new Date(days * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

const weekdayOf = (days: number) => (((days + 4) % 7) + 7) % 7;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validLocal(local: LocalTime): boolean {
  return (
    local.year >= 1900 &&
    local.year <= 9999 &&
    local.month >= 1 &&
    local.month <= 12 &&
    local.day >= 1 &&
    local.day <= daysInMonth(local.year, local.month) &&
    local.hour <= 23 &&
    local.minute <= 59 &&
    local.second <= 59
  );
}

/** Reads a rule's start: `2026-10-16T09:00`, seconds optional, with no zone. */
export function parseStarts(text: string): Parsed<LocalTime> {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
  const local = match
    ? {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] ?? 0),
      }
    : null;
  if (!local || !validLocal(local))
    return fail(
      'starts is the first time as a local date and time with no zone, such as "2026-10-16T09:00". The schedule’s time zone says where.',
    );
  return { ok: true, value: local };
}

// ---------------------------------------------------------------------------
// Local times to instants, in an IANA time zone.

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(at: number, zone: string): LocalTime {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, format);
  }
  const value: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(at)))
    if (part.type !== 'literal') value[part.type] = Number(part.value);
  return {
    year: value.year ?? 0,
    month: value.month ?? 0,
    day: value.day ?? 0,
    hour: (value.hour ?? 0) % 24,
    minute: value.minute ?? 0,
    second: value.second ?? 0,
  };
}

const asUtc = (local: LocalTime) =>
  Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);

/** How far the zone's clock is ahead of UTC at an instant, in milliseconds. */
const offsetAt = (at: number, zone: string) =>
  asUtc(zoneParts(at, zone)) - Math.floor(at / 1000) * 1000;

/**
 * The instant a local time names in a zone. A time that happens twice (the
 * hour clocks go back) is the first; one that never happens (the hour they go
 * forward) is read with the offset before the change, which moves it later by
 * the gap, as RFC 5545 says.
 */
export function zonedInstant(local: LocalTime, zone: string): Date {
  const wall = asUtc(local);
  // A day either side brackets the change in every zone. Offsets run from -12
  // to +14 hours, so half a day is already past it in Auckland or Chatham.
  const before = offsetAt(wall - 24 * 3_600_000, zone);
  const after = offsetAt(wall + 24 * 3_600_000, zone);
  const fits = [...new Set([wall - before, wall - after])]
    .filter((at) => asUtc(zoneParts(at, zone)) === wall)
    .sort((a, b) => a - b);
  return new Date(fits[0] ?? wall - before);
}

// ---------------------------------------------------------------------------
// The dates a rule produces.

/** The days of `[first, last]` (day numbers) a BYDAY list names, ordinals counted within that span. */
function daysInSpan(first: number, last: number, byDay: RuleDay[]): Set<number> {
  const out = new Set<number>();
  for (const { weekday, nth } of byDay) {
    const offset = (weekday - weekdayOf(first) + 7) % 7;
    const matching: number[] = [];
    for (let day = first + offset; day <= last; day += 7) matching.push(day);
    if (nth === null) for (const day of matching) out.add(day);
    else {
      const pick = nth > 0 ? matching[nth - 1] : matching[matching.length + nth];
      if (pick !== undefined) out.add(pick);
    }
  }
  return out;
}

function monthDays(year: number, month: number, byMonthDay: number[]): number[] {
  const length = daysInMonth(year, month);
  const out: number[] = [];
  for (const value of byMonthDay) {
    const date = value > 0 ? value : length + value + 1;
    if (date >= 1 && date <= length) out.push(dayNumber(year, month, date));
  }
  return out;
}

/** The candidate days of one month, for MONTHLY, or YEARLY with BYMONTH. */
function daysOfMonth(rule: Recurrence, year: number, month: number, start: LocalTime): number[] {
  const first = dayNumber(year, month, 1);
  const last = first + daysInMonth(year, month) - 1;
  if (rule.byMonthDay.length) {
    const days = monthDays(year, month, rule.byMonthDay);
    if (!rule.byDay.length) return days;
    const allowed = daysInSpan(first, last, rule.byDay);
    return days.filter((day) => allowed.has(day));
  }
  if (rule.byDay.length) return [...daysInSpan(first, last, rule.byDay)];
  return start.day <= daysInMonth(year, month) ? [dayNumber(year, month, start.day)] : [];
}

/** Where period `index` (0 is the one holding the start) begins and ends, as day numbers. */
function periodSpan(rule: Recurrence, start: LocalTime, index: number): [number, number] {
  const startDay = dayNumber(start.year, start.month, start.day);
  switch (rule.freq) {
    case 'DAILY': {
      const day = startDay + index * rule.interval;
      return [day, day];
    }
    case 'WEEKLY': {
      const begins =
        startDay - ((weekdayOf(startDay) - rule.weekStart + 7) % 7) + index * rule.interval * 7;
      return [begins, begins + 6];
    }
    case 'MONTHLY': {
      const months = start.year * 12 + (start.month - 1) + index * rule.interval;
      const year = Math.floor(months / 12);
      const month = (months % 12) + 1;
      const first = dayNumber(year, month, 1);
      return [first, first + daysInMonth(year, month) - 1];
    }
    case 'YEARLY': {
      const year = start.year + index * rule.interval;
      return [dayNumber(year, 1, 1), dayNumber(year, 12, 31)];
    }
  }
}

/** The candidate days of period `index`, in order. */
function periodDays(rule: Recurrence, start: LocalTime, index: number): number[] {
  const [first, last] = periodSpan(rule, start, index);
  const startDay = dayNumber(start.year, start.month, start.day);
  const inMonths = (day: number) => !rule.byMonth.length || rule.byMonth.includes(civil(day).month);
  let days: number[];
  switch (rule.freq) {
    case 'DAILY': {
      const date = civil(first);
      const keep =
        (!rule.byDay.length || rule.byDay.some((entry) => entry.weekday === weekdayOf(first))) &&
        (!rule.byMonthDay.length ||
          monthDays(date.year, date.month, rule.byMonthDay).includes(first));
      days = keep ? [first] : [];
      break;
    }
    case 'WEEKLY': {
      const weekdays = rule.byDay.length
        ? rule.byDay.map((entry) => entry.weekday)
        : [weekdayOf(startDay)];
      days = [];
      for (let day = first; day <= last; day++)
        if (weekdays.includes(weekdayOf(day))) days.push(day);
      break;
    }
    case 'MONTHLY': {
      const { year, month } = civil(first);
      days = daysOfMonth(rule, year, month, start);
      break;
    }
    case 'YEARLY': {
      const { year } = civil(first);
      if (rule.byMonth.length) {
        days = rule.byMonth.flatMap((month) => daysOfMonth(rule, year, month, start));
      } else if (rule.byMonthDay.length) {
        days = [];
        for (let month = 1; month <= 12; month++)
          days.push(...monthDays(year, month, rule.byMonthDay));
        if (rule.byDay.length) {
          // With no BYMONTH, a numbered day counts through the whole year.
          const allowed = daysInSpan(first, last, rule.byDay);
          days = days.filter((day) => allowed.has(day));
        }
      } else if (rule.byDay.length) {
        days = [...daysInSpan(first, last, rule.byDay)];
      } else {
        days =
          start.day <= daysInMonth(year, start.month)
            ? [dayNumber(year, start.month, start.day)]
            : [];
      }
      break;
    }
  }
  return [...new Set(days.filter(inMonths))].sort((a, b) => a - b);
}

/** A rule with nothing for this many years of calendar is taken to have ended. */
const EMPTY_YEARS = 12;

/** The period holding `day` (a day number), counted as `periodSpan` counts them. */
function periodHolding(rule: Recurrence, start: LocalTime, day: number): number {
  switch (rule.freq) {
    case 'DAILY':
      return Math.floor((day - dayNumber(start.year, start.month, start.day)) / rule.interval);
    case 'WEEKLY':
      return Math.floor((day - periodSpan(rule, start, 0)[0]) / (7 * rule.interval));
    case 'MONTHLY': {
      const { year, month } = civil(day);
      return Math.floor((year * 12 + month - (start.year * 12 + start.month)) / rule.interval);
    }
    case 'YEARLY':
      return Math.floor((civil(day).year - start.year) / rule.interval);
  }
}

/**
 * The rule's occurrences as instants, in order, from its start. It ends at
 * COUNT or UNTIL, and also once a dozen years pass with none (a rule for
 * February 30 never comes round).
 *
 * With `from`, times well before it are not worked out: a rule with no COUNT
 * starts its search near `from`, and one with a COUNT only counts the days
 * before it. What comes out from `from` on is the same either way (but for
 * the dozen empty years, then counted from near `from`), and a daily rule
 * started years ago stays as quick to ask as a new one.
 */
export function* occurrences(
  rule: Recurrence,
  start: LocalTime,
  zone: string,
  from?: Date,
): Generator<Date, void, undefined> {
  const startDay = dayNumber(start.year, start.month, start.day);
  const until =
    rule.until === null
      ? null
      : 'at' in rule.until
        ? rule.until.at.getTime()
        : zonedInstant(rule.until.local, zone).getTime();
  // Two days before `from`'s UTC date: any local time that early, in any
  // zone and after any daylight saving shift, is an instant before `from`.
  const skipBefore = from ? Math.floor(from.getTime() / 86_400_000) - 2 : null;
  const firstIndex =
    skipBefore !== null && rule.count === null
      ? Math.max(0, periodHolding(rule, start, skipBefore))
      : 0;
  let produced = 0;
  let lastFound = Math.max(startDay, periodSpan(rule, start, firstIndex)[0]);
  for (let index = firstIndex; ; index++) {
    const days = periodDays(rule, start, index);
    for (const day of days) {
      if (day < startDay) continue;
      if (skipBefore !== null && day < skipBefore) {
        lastFound = day;
        produced++;
        if (rule.count !== null && produced >= rule.count) return;
        continue;
      }
      const date = civil(day);
      const at = zonedInstant(
        { ...date, hour: start.hour, minute: start.minute, second: start.second },
        zone,
      );
      if (until !== null && at.getTime() > until) return;
      yield at;
      lastFound = day;
      produced++;
      if (rule.count !== null && produced >= rule.count) return;
    }
    const [, reached] = periodSpan(rule, start, index);
    if (reached - lastFound > EMPTY_YEARS * 366 || civil(reached).year > 9999) return;
  }
}

/** The next `count` occurrences strictly after `after`. */
export function occurrencesAfter(
  rule: Recurrence,
  start: LocalTime,
  zone: string,
  after: Date,
  count: number,
): Date[] {
  const out: Date[] = [];
  for (const at of occurrences(rule, start, zone, after)) {
    if (at.getTime() <= after.getTime()) continue;
    out.push(at);
    if (out.length >= count) break;
  }
  return out;
}

/** The latest occurrence in `(from, to]`, if there is one. */
export function occurrenceBetween(
  rule: Recurrence,
  start: LocalTime,
  zone: string,
  from: Date,
  to: Date,
): Date | null {
  let found: Date | null = null;
  for (const at of occurrences(rule, start, zone, from)) {
    if (at.getTime() > to.getTime()) break;
    if (at.getTime() > from.getTime()) found = at;
  }
  return found;
}

// ---------------------------------------------------------------------------
// In plain words.

const listWords = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const ordinal = (n: number) =>
  n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

const NTH = ['first', 'second', 'third', 'fourth', 'fifth'];

function nthWords(nth: number): string | null {
  if (nth > 0) return NTH[nth - 1] ?? null;
  if (nth === -1) return 'last';
  if (nth === -2) return 'second-to-last';
  return null;
}

/** Weekdays read from Monday, as people say them: "Monday, Wednesday and Friday". */
function weekdayWords(weekdays: number[]): string {
  const set = [...new Set(weekdays)].sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '1,2,3,4,5') return 'weekday';
  if (key === '0,1,2,3,4,5,6') return 'day';
  const ordered = [...set.filter((day) => day !== 0), ...set.filter((day) => day === 0)];
  return listWords(ordered.map((day) => DAYS[day] ?? ''));
}

function monthDayWords(value: number): string {
  if (value === -1) return 'last day';
  if (value === -2) return 'second-to-last day';
  return value > 0 ? ordinal(value) : `${ordinal(-value)} day from the end`;
}

/** "every month", "every other month", "every 3 months". */
function everyWords(interval: number, unit: string): string {
  if (interval === 1) return `every ${unit}`;
  if (interval === 2) return `every other ${unit}`;
  return `every ${interval} ${unit}s`;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The date an UNTIL instant falls on in the zone, or in UTC when the zone is not one. */
function untilDate(at: Date, zone: string | undefined): LocalTime {
  try {
    return zoneParts(at.getTime(), zone ?? 'UTC');
  } catch {
    return zoneParts(at.getTime(), 'UTC');
  }
}

/** The day-of-month part of a rule: "the 1st and 15th", "the first Monday", or null when it has no plain words. */
function whichDays(rule: Recurrence, start: LocalTime): string | null {
  if (rule.byMonthDay.length && !rule.byDay.length)
    return `the ${listWords(rule.byMonthDay.map(monthDayWords))}`;
  if (rule.byDay.length && !rule.byMonthDay.length) {
    const named = rule.byDay.map((day) => {
      const nth = day.nth === null ? null : nthWords(day.nth);
      return nth ? `${nth} ${DAYS[day.weekday]}` : null;
    });
    return named.every(Boolean) ? `the ${listWords(named as string[])}` : null;
  }
  if (!rule.byDay.length && !rule.byMonthDay.length) return `the ${ordinal(start.day)}`;
  return null;
}

/**
 * A rule in plain words, for the shapes people ask for: "Every other Friday
 * at 9:00", "On the last day of every month at 18:00", "Every year on
 * March 15 at 9:00, 3 times". Anything else gets a neutral line, never a
 * wrong one.
 */
export function recurrenceWords(
  rule: Recurrence,
  start: LocalTime,
  options: {
    /** The schedule's zone, so an UNTIL given in UTC is said as the local date. */
    zone?: string | undefined;
    /** "9:00" and "17:00" (the default), or "9:00 AM" and "5:00 PM" where a page says times that way. */
    clock?: '24h' | '12h';
  } = {},
): string {
  const minutes = String(start.minute).padStart(2, '0');
  const time =
    options.clock === '12h'
      ? `at ${start.hour % 12 || 12}:${minutes} ${start.hour < 12 ? 'AM' : 'PM'}`
      : `at ${start.hour}:${minutes}`;
  const startWeekday = weekdayOf(dayNumber(start.year, start.month, start.day));
  const plainDays = rule.byDay.length > 0 && rule.byDay.every((day) => day.nth === null);
  const months = listWords(rule.byMonth.map((month) => MONTHS[month - 1] ?? ''));
  let words: string | null = null;
  let inMonths = Boolean(months);
  switch (rule.freq) {
    case 'DAILY':
      if (rule.byMonthDay.length) break;
      if (!rule.byDay.length) words = `${capital(everyWords(rule.interval, 'day'))} ${time}`;
      else if (rule.interval === 1)
        words = `Every ${weekdayWords(rule.byDay.map((day) => day.weekday))} ${time}`;
      break;
    case 'WEEKLY': {
      const days = weekdayWords(
        rule.byDay.length ? rule.byDay.map((day) => day.weekday) : [startWeekday],
      );
      // "Every other Friday" is clear for one day; for several it would read
      // as every other one of them, so the weeks are said apart.
      const single = new Set(rule.byDay.map((day) => day.weekday)).size <= 1;
      const on =
        days === 'weekday' ? ' on weekdays' : days === 'day' ? ', every day,' : ` on ${days}`;
      if (rule.interval === 1) words = `Every ${days} ${time}`;
      else if (single && rule.interval === 2) words = `Every other ${days} ${time}`;
      else words = `${capital(everyWords(rule.interval, 'week'))}${on} ${time}`;
      break;
    }
    case 'MONTHLY': {
      if (plainDays) {
        if (rule.interval === 1 && !rule.byMonthDay.length)
          words = `Every ${weekdayWords(rule.byDay.map((day) => day.weekday))} ${time}`;
        break;
      }
      const which = whichDays(rule, start);
      if (which) words = `On ${which} of ${everyWords(rule.interval, 'month')} ${time}`;
      break;
    }
    case 'YEARLY': {
      const every = capital(everyWords(rule.interval, 'year'));
      inMonths = false;
      if (!rule.byMonth.length) {
        if (!rule.byDay.length && !rule.byMonthDay.length)
          words = `${every} on ${MONTHS[start.month - 1]} ${start.day} ${time}`;
        break;
      }
      const single = rule.byMonth.length === 1 ? MONTHS[(rule.byMonth[0] ?? 1) - 1] : null;
      const date = !rule.byDay.length
        ? rule.byMonthDay.length === 0
          ? start.day
          : rule.byMonthDay.length === 1 && (rule.byMonthDay[0] ?? 0) > 0
            ? rule.byMonthDay[0]
            : null
        : null;
      if (single && date) words = `${every} on ${single} ${date} ${time}`;
      else if (!plainDays) {
        const which = whichDays(rule, start);
        if (which) words = `${every} on ${which} of ${months} ${time}`;
      }
      break;
    }
  }
  if (!words) return 'On a set schedule';
  if (inMonths) words += ` in ${months}`;
  if (rule.count !== null) words += rule.count === 1 ? ', once' : `, ${rule.count} times`;
  if (rule.until) {
    const { year, month, day } =
      'local' in rule.until ? rule.until.local : untilDate(rule.until.at, options.zone);
    words += `, until ${MONTHS[month - 1]} ${day}, ${year}`;
  }
  return words;
}

/** A rule and its start, read together: the rule, or what is wrong with either. */
export function readRecurrence(
  rrule: string,
  starts: string | undefined,
): Parsed<{ rule: Recurrence; start: LocalTime }> {
  const rule = parseRecurrence(rrule);
  if (!rule.ok) return rule;
  if (!starts) return fail(`A rule needs starts, its first time. ${RRULE_FORMAT}`);
  const start = parseStarts(starts);
  if (!start.ok) return start;
  return { ok: true, value: { rule: rule.value, start: start.value } };
}

/** The parts of a schedule that say when: a cron, or a calendar rule and its start. */
export interface ScheduleTiming {
  cron?: string | undefined;
  rrule?: string | undefined;
  starts?: string | undefined;
  timezone?: string | undefined;
}

/**
 * What is wrong with how a schedule says when, or null: it needs a cron or a
 * rule, not both, and a rule needs its start. `field` is where to point; a
 * schedule with neither is "missing", for the caller to say how to write one.
 */
export function scheduleTimingProblem(
  timing: ScheduleTiming,
): { field: 'cron' | 'rrule' | 'starts'; problem: string } | null {
  if (timing.rrule === undefined) {
    if (timing.starts !== undefined)
      return { field: 'starts', problem: 'starts goes with rrule; a cron has no start.' };
    if (timing.cron === undefined) return { field: 'cron', problem: 'missing' };
    return null;
  }
  if (timing.cron !== undefined)
    return { field: 'rrule', problem: 'Give a cron or an rrule, not both.' };
  const rule = parseRecurrence(timing.rrule);
  if (!rule.ok) return { field: 'rrule', problem: rule.problem };
  // The rule reads, so what is left wrong is its start.
  const read = readRecurrence(timing.rrule, timing.starts);
  return read.ok ? null : { field: 'starts', problem: read.problem };
}

/** A schedule's rule and start, read, when it has a valid one. */
export function scheduleRecurrence(
  timing: ScheduleTiming,
): { rule: Recurrence; start: LocalTime } | null {
  if (timing.rrule === undefined) return null;
  const read = readRecurrence(timing.rrule, timing.starts);
  return read.ok ? read.value : null;
}
