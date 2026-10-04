/**
 * Calendar truth: when the person is busy, whether a new event would land on
 * top of something, and who an event would invite.
 *
 * Free/busy is read from the same occurrences the signal poller reads (Google
 * lists instances with `singleEvents`, Graph with `calendarView`, and a CalDAV
 * collection or feed is expanded by `expandIcs` within its budget), so there is
 * one recurrence engine and one set of provider quirks. Each busy block keeps
 * the event's title, so a refusal can name what is in the way.
 *
 * What blocks time: an event that is not cancelled, not shown as free, and not
 * an invitation the calendar's own account declined. A tentative event blocks
 * it too, and is reported as tentative: a hold is a hold. An all-day event is
 * placed on the person's own day, in their time zone.
 *
 * The functions here are for any caller (the calendar tools, an undo, a later
 * coordination step); none of them writes anything.
 */
import { createHash } from 'node:crypto';
import type { Action, DispatchResult, JsonObject, JsonValue } from '@melete/contracts';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { calendarAddress, instantMs, zonedToUtc } from '../signals/occurrences.ts';
import {
  type CalendarOccurrences,
  type CalendarWindow,
  type Occurrence,
  type SignalSource,
  SourceError,
} from '../signals/types.ts';
import { ConnectorFaultError } from './faults.ts';

const DAY_MS = 86_400_000;
/** The longest window one free/busy read covers. */
export const MAX_FREEBUSY_DAYS = 62;

/** Time the calendar shows as taken, and by what. */
export type BusyBlock = {
  /** A UTC instant. An all-day event starts at the person's own midnight. */
  start: string;
  end: string;
  all_day: boolean;
  /** `tentative` for a hold or an invitation not yet answered yes. */
  status: 'busy' | 'tentative';
  title: string;
  /** Stable for the event (or the instance of a series) across reads; never a provider id. */
  ref: string;
};

export type FreeBusy = {
  window: CalendarWindow;
  time_zone: string;
  busy: BusyBlock[];
  /** The open stretches of the window between busy blocks. */
  free: { start: string; end: string }[];
  /** False when the calendar listed more than one read takes: anything past it is unknown. */
  complete: boolean;
};

/** Whether an IANA zone name is one this runtime knows. */
export function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Midnight of a date in a zone, as epoch milliseconds. */
function midnight(date: string, zone: string): number {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return zonedToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, zone);
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Where an occurrence sits, in epoch milliseconds, an all-day one on the person's own days. */
function placed(occurrence: Occurrence, zone: string): { start: number; end: number } {
  if (occurrence.all_day || isDate(occurrence.start)) {
    const start = midnight(occurrence.start.slice(0, 10), zone);
    const end = isDate(occurrence.end) ? midnight(occurrence.end, zone) : instantMs(occurrence.end);
    return { start, end: end > start ? end : start + DAY_MS };
  }
  return { start: instantMs(occurrence.start), end: instantMs(occurrence.end) };
}

/** Whether an occurrence takes the time it covers. */
export function blocksTime(occurrence: Occurrence): boolean {
  return occurrence.status !== 'cancelled' && !occurrence.transparent && !occurrence.declined;
}

/** A short, fixed-length name for one occurrence, the same on every read. */
export function blockRef(occurrence: Pick<Occurrence, 'uid' | 'occurrence'>): string {
  return createHash('sha256')
    .update(`${occurrence.uid}\u0000${occurrence.occurrence ?? ''}`)
    .digest('hex')
    .slice(0, 24);
}

const cleanTitle = (title: string) =>
  title
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * The busy blocks among occurrences that overlap `[from, to)`, earliest
 * first. Touching is not overlapping: a meeting ending at 15:00 leaves 15:00
 * free. An occurrence with no length blocks nothing.
 */
export function busyBlocks(
  occurrences: readonly Occurrence[],
  window: CalendarWindow,
  zone: string,
): BusyBlock[] {
  const from = instantMs(window.from);
  const to = instantMs(window.to);
  const seen = new Set<string>();
  const blocks: (BusyBlock & { at: number })[] = [];
  for (const occurrence of occurrences) {
    if (!blocksTime(occurrence)) continue;
    const { start, end } = placed(occurrence, zone);
    if (!(end > start) || Number.isNaN(start) || Number.isNaN(end)) continue;
    if (!(start < to && end > from)) continue;
    const ref = blockRef(occurrence);
    if (seen.has(ref)) continue;
    seen.add(ref);
    blocks.push({
      at: start,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      all_day: occurrence.all_day,
      status: occurrence.status === 'tentative' ? 'tentative' : 'busy',
      title: cleanTitle(occurrence.title),
      ref,
    });
  }
  return blocks.sort((a, b) => a.at - b.at).map(({ at: _at, ...block }) => block);
}

/** The open stretches of a window once the busy blocks are taken out. */
export function freeStretches(
  busy: readonly BusyBlock[],
  window: CalendarWindow,
): { start: string; end: string }[] {
  const to = instantMs(window.to);
  let cursor = instantMs(window.from);
  const free: { start: string; end: string }[] = [];
  for (const block of busy) {
    const start = Date.parse(block.start);
    if (start > cursor) free.push({ start: new Date(cursor).toISOString(), end: block.start });
    cursor = Math.max(cursor, Date.parse(block.end));
    if (cursor >= to) break;
  }
  if (cursor < to) free.push({ start: new Date(cursor).toISOString(), end: window.to });
  return free;
}

/**
 * The occurrences to read for a window: a day either side, so an all-day
 * event, whose day the provider places in the calendar's own zone, is never
 * missed at the edges.
 */
function readWindow(window: CalendarWindow): CalendarWindow {
  return {
    from: new Date(instantMs(window.from) - DAY_MS).toISOString(),
    to: new Date(instantMs(window.to) + DAY_MS).toISOString(),
  };
}

/** Free and busy time in a window, read fresh from the calendar. */
export async function freeBusy(
  source: CalendarOccurrences,
  window: CalendarWindow,
  zone: string,
): Promise<FreeBusy> {
  const timeZone = validZone(zone) ? zone : 'UTC';
  const read = await source.occurrences(readWindow(window));
  const busy = busyBlocks(read.items, window, timeZone);
  return {
    window,
    time_zone: timeZone,
    busy,
    free: freeStretches(busy, window),
    complete: read.complete,
  };
}

export type Slot = { start: string; end: string };

/**
 * What a new or moved event at `slot` would land on. `mine` names the event
 * being changed, which never conflicts with itself. `complete` is false when
 * the calendar could not be read to the end, and then no answer is sure.
 */
export async function conflictsAt(
  source: CalendarOccurrences,
  slot: Slot,
  options: { zone: string; mine?: (occurrence: Occurrence) => boolean },
): Promise<{ conflicts: BusyBlock[]; complete: boolean }> {
  const zone = validZone(options.zone) ? options.zone : 'UTC';
  const window = { from: slot.start, to: slot.end };
  const read = await source.occurrences(readWindow(window));
  const items = options.mine ? read.items.filter((item) => !options.mine?.(item)) : read.items;
  return { conflicts: busyBlocks(items, window, zone), complete: read.complete };
}

/** A calendar connector's occurrences, or null for any other connector. */
export function calendarSource(connector: { signals?: SignalSource }): CalendarOccurrences | null {
  return connector.signals?.stream === 'calendar' ? connector.signals : null;
}

/**
 * The conflict check any caller can make against a connected calendar, for
 * example before an event is created without asking: the busy blocks a slot
 * would land on. Null when the connector is not a calendar.
 */
export async function calendarConflicts(
  connector: { signals?: SignalSource },
  slot: Slot,
  zone: string,
): Promise<{ conflicts: BusyBlock[]; complete: boolean } | null> {
  const source = calendarSource(connector);
  return source ? conflictsAt(source, slot, { zone }) : null;
}

/** One busy block in plain words, in the person's own zone. */
export function describeBlock(block: BusyBlock, zone: string): string {
  const timeZone = validZone(zone) ? zone : 'UTC';
  const title = block.title ? `“${block.title}”` : 'an untitled event';
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  if (block.all_day) return `${title} (all day, ${day.format(new Date(block.start))})`;
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const zoneName =
    new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date(block.start))
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  const tentative = block.status === 'tentative' ? ', tentative' : '';
  return `${title} (${day.format(new Date(block.start))}, ${time.format(new Date(block.start))}–${time.format(new Date(block.end))} ${zoneName}${tentative})`;
}

/** Why a write over busy time was refused, naming what is in the way. */
export function overlapReason(conflicts: readonly BusyBlock[], zone: string): string {
  const named = conflicts.slice(0, 3).map((block) => describeBlock(block, zone));
  const more = conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : '';
  return `That time is already taken by ${named.join(', ')}${more}, so nothing was put on the calendar. Choose a free time (calendar.freebusy shows them), or, only if the person wants both, ask again with double_book and the reason.`;
}

// --------------------------------------------------------------------------
// What a create or update binds before anyone is asked
// --------------------------------------------------------------------------

/**
 * What the service found and bound into a calendar write before anyone was
 * asked: the person's time zone, the invited addresses outside the person's
 * own accounts, and (for a double-booking the agent asked for) the busy
 * blocks it would land on. The card shows it; the write is checked again
 * against it at dispatch.
 */
export type CalendarCheck = {
  time_zone: string;
  outside: string[];
  conflicts: BusyBlock[];
  /** False when the calendar could not be read before asking. */
  read: boolean;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The check bound into a payload, or null when none was. */
export function checkOf(payload: JsonObject): CalendarCheck | null {
  const checked = object(payload.checked);
  if (!Object.keys(checked).length) return null;
  return {
    time_zone: validZone(checked.time_zone) ? checked.time_zone : 'UTC',
    outside: Array.isArray(checked.outside)
      ? checked.outside.filter((value): value is string => typeof value === 'string')
      : [],
    conflicts: Array.isArray(checked.conflicts)
      ? (checked.conflicts.filter((value) => typeof object(value).ref === 'string') as BusyBlock[])
      : [],
    read: checked.read === true,
  };
}

/** Invited addresses, trimmed, lower case, each once. */
export function invited(payload: JsonObject): string[] {
  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  return [
    ...new Set(
      attendees.filter((value): value is string => typeof value === 'string').map(calendarAddress),
    ),
  ].filter(Boolean);
}

/** The person's time zone, as their profile has it. */
export async function spaceTimeZone(tx: Query, spaceId: string): Promise<string> {
  const [row] = await tx`select time_zone from experience_profile where space_id = ${spaceId}`;
  return validZone(row?.time_zone) ? row.time_zone : 'UTC';
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * The addresses that are the person's own: the address they sign in with and
 * every account connected in the space (a signed-in calendar or mailbox, a
 * mailbox's sending address, a CalDAV user name that is an address).
 */
export async function ownAddresses(tx: Query, spaceId: string): Promise<Set<string>> {
  const own = new Set<string>();
  const [owner] = await tx`select p.email from space s join principal p
    on p.id = s.owner_principal_id where s.id = ${spaceId} and p.kind = 'person'`;
  if (typeof owner?.email === 'string') own.add(calendarAddress(owner.email));
  const rows = await tx`select configuration from connection where space_id = ${spaceId}`;
  for (const row of rows) {
    const configuration = object(row.configuration);
    for (const value of [
      configuration.account,
      configuration.from,
      object(configuration.mail).from,
      object(configuration.mail).username,
      object(configuration.caldav).username,
      configuration.username,
    ])
      if (typeof value === 'string' && EMAIL.test(value.trim())) own.add(calendarAddress(value));
  }
  return own;
}

const WRITES = new Set(['calendar.create', 'calendar.update']);

/**
 * Bind a calendar write's check into its payload, under the proposal's
 * transaction (no calendar is read here: `ahead` read it before the lock). A
 * write over busy time that does not ask to double-book is refused here,
 * naming what is in the way. An empty guest list is dropped, so inviting no
 * one stays an event on the person's own calendar.
 */
export async function bindCalendarCheck(
  payload: JsonObject,
  spaceId: string,
  tx: Query,
  kind: string | undefined,
  ahead: JsonObject | null | undefined,
): Promise<JsonObject> {
  if (kind === 'calendar.freebusy')
    return validZone(payload.time_zone)
      ? payload
      : { ...payload, time_zone: await spaceTimeZone(tx, spaceId) };
  if (!kind || !WRITES.has(kind)) return payload;
  const { checked: _ignored, ...rest } = payload;
  const attendees = invited(rest);
  if (attendees.length) rest.attendees = attendees;
  else delete rest.attendees;
  const zone = await spaceTimeZone(tx, spaceId);
  const own = await ownAddresses(tx, spaceId);
  const looked = object(ahead);
  const read = Array.isArray(looked.conflicts) && looked.complete === true;
  const conflicts = read ? (looked.conflicts as BusyBlock[]) : [];
  if (conflicts.length && !rest.double_book)
    throw new BrokerFault('payload_invalid', overlapReason(conflicts, zone));
  const check: CalendarCheck = {
    time_zone: zone,
    outside: attendees.filter((address) => !own.has(address)),
    conflicts: rest.double_book ? conflicts : [],
    read,
  };
  return { ...rest, checked: check as unknown as JsonValue };
}

/**
 * Whether the person decides this write whatever their settings: it invites
 * someone outside their own accounts, or it asks to double-book. An
 * invitation whose check is missing counts every guest as outside.
 */
export function calendarAsksFirst(action: Pick<Action, 'kind' | 'canonical_payload'>): boolean {
  if (!WRITES.has(action.kind)) return false;
  const payload = action.canonical_payload;
  if (payload.double_book !== undefined) return true;
  if (!invited(payload).length) return false;
  const check = checkOf(payload);
  return check === null || check.outside.length > 0;
}

/**
 * Read the calendar before the proposal's lock, for what a write would land
 * on. Null when it could not be read, which leaves the check to dispatch.
 */
export async function calendarAhead(
  source: CalendarOccurrences | null,
  proposal: { kind: string; canonical_payload: JsonObject },
  zone: string,
  mine?: (occurrence: Occurrence) => boolean,
): Promise<JsonObject | null> {
  if (!source || !WRITES.has(proposal.kind)) return null;
  const { start, end } = proposal.canonical_payload;
  if (typeof start !== 'string' || typeof end !== 'string') return null;
  if (!(Date.parse(end) > Date.parse(start))) return null;
  try {
    const found = await conflictsAt(source, { start, end }, { zone, ...(mine ? { mine } : {}) });
    return { conflicts: found.conflicts as unknown as JsonValue, complete: found.complete };
  } catch {
    return null;
  }
}

/**
 * The check a write makes just before it is sent: the calendar is read again,
 * and anything now in the way that the person did not agree to double-book
 * stops it. A calendar that cannot be read stops it too; nothing is written
 * on a guess. Null means the write may go.
 */
const UNREAD =
  'Melete could not read the calendar to check that this time is free, so nothing was written.';

export async function clearToWrite(
  source: CalendarOccurrences,
  payload: JsonObject & { start: string; end: string },
  mine?: (occurrence: Occurrence) => boolean,
): Promise<DispatchResult | null> {
  const check = checkOf(payload);
  const zone = check?.time_zone ?? 'UTC';
  const agreed = new Set(
    payload.double_book !== undefined ? (check?.conflicts ?? []).map((block) => block.ref) : [],
  );
  let found: { conflicts: BusyBlock[]; complete: boolean };
  try {
    found = await conflictsAt(
      source,
      { start: payload.start, end: payload.end },
      { zone, ...(mine ? { mine } : {}) },
    );
  } catch (error) {
    // A refused credential or a request to slow down is the same fault the
    // write itself would meet, so the broker can repair it the same way.
    if (error instanceof SourceError) {
      if (error.status === 429 || error.status === 503)
        throw new ConnectorFaultError({
          kind: 'rate_limited',
          detail: 'the calendar server asked to be left alone for a while',
          retry_after: error.retryAfter,
        });
      if (error.status === 401)
        throw new ConnectorFaultError({
          kind: 'expired_credential',
          detail: 'the calendar server refused the credential this write carried',
        });
      if (error.status === 403)
        throw new ConnectorFaultError({
          kind: 'revoked_credential',
          detail: 'the calendar server no longer permits this account to write',
        });
    }
    return {
      outcome: 'failed',
      reason: UNREAD,
      // A server that refused the read outright will refuse it again.
      retryable: !(error instanceof SourceError && error.status >= 400 && error.status < 500),
    };
  }
  if (!found.complete) return { outcome: 'failed', reason: UNREAD, retryable: true };
  const fresh = found.conflicts.filter((block) => !agreed.has(block.ref));
  return fresh.length
    ? { outcome: 'failed', reason: overlapReason(fresh, zone), retryable: false }
    : null;
}
