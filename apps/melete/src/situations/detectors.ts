/**
 * The built-in detectors, as plain functions over typed fields.
 *
 * Each one reads what an account reported (an observation, or the fields kept
 * about each calendar occurrence) and says whether there is a situation, how
 * soon the person should hear, and why, in Melete's own words. None reads a
 * body, none calls a model, and none can make anything urgent: only a
 * deadline the person set or accepted can (see `urgencyFor`).
 *
 * Words from an account (a meeting's title, its place, a subject line) are
 * outside content. They travel in `evidence`, as fields, and never in a
 * situation's title or reason, so an invitation titled "URGENT: call me" says
 * nothing in Melete's voice. An invitation the person has not accepted is not
 * their meeting: it raises nothing.
 */
import { createHash } from 'node:crypto';
import { type DOCUMENT_TOUCHERS, SITUATION_KINDS, type Urgency } from '@melete/contracts';
import { registrableDomain } from '../companies/messages.ts';
import { baseSubject, isPersonalDomain } from '../companies/waiting.ts';
import { instantMs, zonedToUtc } from '../signals/occurrences.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A change this close to a meeting's start is worth telling. */
export const MEETING_CHANGE_HORIZON_MS = DAY;
/** At most this many overlapping pairs are raised from one look at a calendar. */
export const MAX_CONFLICTS = 50;
/** A deadline this close, set or accepted by the person, may break their quiet. */
export const URGENT_LEAD_SECONDS = 15 * 60;

/** Whose a situation is: one person, in one space. Keys never cross them. */
export type Scope = { spaceId: string; principalId: string };

/**
 * One live situation per key: whose it is, its kind, what it is about, and
 * the moment it belongs to. Two people watching the same document each have
 * their own.
 */
export const situationKey = (scope: Scope, kind: string, subjectKey: string, window = '') =>
  createHash('sha256')
    .update([scope.spaceId, scope.principalId, kind, subjectKey, window].join('\u0000'))
    .digest('hex')
    .slice(0, 40);

/** A short hash of what makes a sighting materially different from the last one. */
export const fingerprintOf = (parts: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

/** What a detector says should be raised. */
export type Finding = {
  kind: string;
  subjectKey: string;
  window: string;
  /**
   * What makes this sighting what it is. The same fingerprint again changes
   * nothing, and a situation the person dismissed comes back only with a
   * different one: the meeting moved, the overlap changed.
   */
  fingerprint: string;
  urgency: Urgency;
  title: string;
  reason: string;
  evidence: Record<string, unknown>;
  deadlineAt: string | null;
  expiresAt: string | null;
};

const ORDER: Record<Urgency, number> = { normal: 0, soon: 1, urgent: 2 };
export const higher = (left: Urgency, right: Urgency): Urgency =>
  ORDER[left] >= ORDER[right] ? left : right;
export const louder = (left: Urgency, right: Urgency): boolean => ORDER[left] > ORDER[right];

/**
 * How soon a deadline's person hears. Urgent only when the person set or
 * accepted it and it is this close. Any other deadline is at most `soon`: it
 * waits for the person's day like everything else, and a `ceiling` keeps it
 * lower still (a commitment found in mail that the person has not taken up
 * stays on Home).
 */
export function urgencyFor(input: {
  personSet: boolean;
  leadSeconds: number;
  ceiling?: Urgency;
}): Urgency {
  const wanted: Urgency =
    input.personSet && input.leadSeconds <= URGENT_LEAD_SECONDS ? 'urgent' : 'soon';
  const ceiling = input.ceiling ?? 'urgent';
  return ORDER[wanted] <= ORDER[ceiling] ? wanted : ceiling;
}

/** A time as the person reads it, in their own zone: "Tue 3:00 PM". */
export function spokenTime(iso: string, timeZone: string): string {
  const at = new Date(instantMs(iso));
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: zone,
    }).format(at);
  try {
    return format(timeZone);
  } catch {
    return `${format('UTC')} UTC`;
  }
}

/** A calendar date as the person reads it: "Sat, Oct 10". The date is the date; no zone moves it. */
export function spokenDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
}

/**
 * When a deadline given only as a date is due: the end of that day where the
 * person is, so a commitment due on the 10th is due until their midnight.
 */
export function endOfLocalDay(date: string, timeZone: string): number {
  const [year = 1970, month = 1, day = 1] = date.slice(0, 10).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const wall = {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
  };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return zonedToUtc(wall, timeZone);
  } catch {
    return zonedToUtc(wall, 'UTC');
  }
}

/** When a deadline given only as a day is taken to be due there: the end of a working day. */
export const DATE_ONLY_DUE = '17:00';

/** An instant for a wall-clock time on a date where the person is; an unknown zone reads as UTC. */
export function localInstant(date: string, clock: string, timeZone: string): number {
  const [year = 1970, month = 1, day = 1] = date.slice(0, 10).split('-').map(Number);
  const [hour = 0, minute = 0] = clock.split(':').map(Number);
  const wall = { year, month, day, hour, minute, second: 0 };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return zonedToUtc(wall, timeZone);
  } catch {
    return zonedToUtc(wall, 'UTC');
  }
}

/** The person's calendar date at an instant, in their zone. */
export function localDate(at: number, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: zone,
    }).format(new Date(at));
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/**
 * The first moment at or after `at` inside the person's day: `at` itself when
 * it already is, otherwise the next start of their day.
 */
export function withinDay(
  at: number,
  day: { start: string; end: string; timeZone: string },
  quiet: (at: number) => boolean,
): number {
  if (!quiet(at)) return at;
  for (let offset = -1; offset <= 2; offset += 1) {
    const date = localDate(at + offset * DAY, day.timeZone);
    const start = localInstant(date, day.start, day.timeZone);
    if (start > at) return start;
  }
  return at;
}

/** The words for when a deadline is due: a time, or for a date alone, the day. */
export function dueWords(due: string, timeZone: string, dateOnly: string | null): string {
  return dateOnly ? spokenDate(dateOnly) : spokenTime(due, timeZone);
}

/**
 * Whether an event is the person's own meeting: one they organise or
 * accepted. An invitation they have not answered, said maybe to, or declined
 * is not, and neither is one whose answer their calendar does not show; a
 * source that keeps no answers at all (a feed) counts what it lists.
 */
export function ownMeeting(response: unknown): boolean {
  return (
    response === undefined ||
    response === null ||
    response === 'organizer' ||
    response === 'accepted'
  );
}

type CalendarPayload = {
  about?: { key?: unknown };
  title?: unknown;
  start?: unknown;
  end?: unknown;
  all_day?: unknown;
  location?: unknown;
  status?: unknown;
  attendees?: unknown;
  response?: unknown;
  changed?: unknown;
  previous?: Record<string, unknown>;
  reason?: unknown;
};

const text = (value: unknown) => (typeof value === 'string' ? value : null);
const timed = (value: unknown) => {
  const at = text(value);
  if (!at || /^\d{4}-\d{2}-\d{2}$/.test(at)) return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * `meeting.changed`: a meeting with other people moved, changed place, or was
 * cancelled, and it starts (or was to start) within a day. A change further
 * out is left to the calendar. An all-day event, one with nobody else on it,
 * or an invitation the person has not accepted is not a meeting.
 */
export function meetingChange(
  eventName: string,
  payload: CalendarPayload,
  now: number,
  timeZone: string,
): Finding | null {
  const subjectKey = text(payload.about?.key);
  if (!subjectKey || payload.all_day === true || !ownMeeting(payload.response)) return null;
  const others = Math.max(
    Number(payload.attendees ?? 0) || 0,
    Number(payload.previous?.attendees ?? 0) || 0,
  );
  if (others < 1) return null;
  const cancelled = eventName === 'calendar.event.cancelled';
  const changed = Array.isArray(payload.changed) ? payload.changed.map(String) : [];
  const moved = changed.includes('start') || changed.includes('end');
  const placed = changed.includes('location');
  if (!cancelled && (eventName !== 'calendar.event.changed' || (!moved && !placed))) return null;
  const start = timed(payload.start);
  const before = timed(payload.previous?.start) ?? start;
  if (start === null || before === null) return null;
  const near = [start, before].some((at) => at >= now && at - now <= MEETING_CHANGE_HORIZON_MS);
  if (!near) return null;
  const end = timed(payload.end) ?? start + HOUR;
  const newTime = spokenTime(new Date(start).toISOString(), timeZone);
  const oldTime = spokenTime(new Date(before).toISOString(), timeZone);
  const title = cancelled
    ? 'A meeting was cancelled'
    : moved
      ? 'A meeting moved'
      : 'A meeting changed place';
  const reason = cancelled
    ? `It was to start ${oldTime}.`
    : moved
      ? `It now starts ${newTime}; it was ${oldTime}.`
      : `It starts ${newTime}, somewhere new.`;
  return {
    kind: SITUATION_KINDS.meetingChanged,
    subjectKey,
    window: '',
    fingerprint: fingerprintOf([start, end, text(payload.location), cancelled]),
    urgency: 'soon',
    title,
    reason,
    evidence: {
      title: text(payload.title),
      start: text(payload.start),
      end: text(payload.end),
      location: text(payload.location),
      changed: cancelled ? ['status'] : changed,
      previous: payload.previous ?? null,
      cancelled,
    },
    deadlineAt: null,
    // Worth showing until the meeting would have ended either way.
    expiresAt: new Date(Math.max(end, before + (end - start), now + HOUR)).toISOString(),
  };
}

/** One occurrence kept about a calendar, as conflicts read it. */
export type KeptMeeting = {
  subjectKey: string;
  connectionId: string;
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  status: string;
  attendees: number;
  response?: string | null;
};

export type Conflict = Finding & { pair: [string, string]; connections: string[] };

/**
 * `meeting.conflict`: two of the person's meetings overlap. Both are timed,
 * confirmed, theirs (organised or accepted), not over, and at least one has
 * other people on it. The same event seen on two calendars (the same uid, or
 * the same title at the same times) is one meeting, not a conflict. A pair is
 * named in a fixed order, so the same overlap found from either side is one
 * situation; its fingerprint is both meetings' times, so moving either one is
 * a new sighting.
 */
export function meetingConflicts(meetings: readonly KeptMeeting[], now: number): Conflict[] {
  const live = meetings
    .filter((m) => !m.allDay && m.status === 'confirmed' && ownMeeting(m.response))
    .map((m) => ({ ...m, from: timed(m.start), to: timed(m.end) }))
    .filter(
      (m): m is typeof m & { from: number; to: number } =>
        m.from !== null && m.to !== null && m.to > m.from && m.to > now,
    )
    .sort((a, b) => a.from - b.from || a.subjectKey.localeCompare(b.subjectKey));
  const found: Conflict[] = [];
  for (let i = 0; i < live.length && found.length < MAX_CONFLICTS; i += 1) {
    const first = live[i];
    if (!first) continue;
    for (let j = i + 1; j < live.length && found.length < MAX_CONFLICTS; j += 1) {
      const second = live[j];
      if (!second) continue;
      if (second.from >= first.to) break;
      if (first.uid === second.uid) continue;
      if (first.from === second.from && first.to === second.to && first.title === second.title)
        continue;
      if (first.attendees < 1 && second.attendees < 1) continue;
      const ordered = [first, second].sort((a, b) => a.subjectKey.localeCompare(b.subjectKey));
      const pair = ordered.map((m) => m.subjectKey) as [string, string];
      const earliest = Math.min(first.from, second.from);
      found.push({
        pair,
        connections: [...new Set(ordered.map((m) => m.connectionId))],
        kind: SITUATION_KINDS.meetingConflict,
        subjectKey: `conflict:${createHash('sha256').update(pair.join('\u0000')).digest('hex').slice(0, 40)}`,
        window: '',
        fingerprint: fingerprintOf(ordered.map((m) => [m.start, m.end])),
        urgency: earliest - now <= DAY ? 'soon' : 'normal',
        title: 'Two meetings overlap',
        reason: '',
        evidence: {
          meetings: ordered.map((m) => ({
            subject_key: m.subjectKey,
            connection_id: m.connectionId,
            title: m.title,
            start: m.start,
            end: m.end,
          })),
        },
        deadlineAt: null,
        expiresAt: new Date(Math.min(first.to, second.to)).toISOString(),
      });
    }
  }
  return found;
}

/** The words for a conflict, once the person's time zone is known. */
export function conflictReason(conflict: Conflict, timeZone: string): string {
  const meetings = conflict.evidence.meetings as Array<{ start: string }>;
  const later = meetings
    .map((m) => m.start)
    .sort()
    .at(-1);
  return later
    ? `Both are on your calendar at ${spokenTime(later, timeZone)}.`
    : 'Both are on your calendar at once.';
}

/** A message the person sent that waits on an answer, as `awaited_reply` keeps it. */
export type Awaited = {
  messageId: string;
  toAddress: string;
  subject: string;
  sentAt: string;
};

/** The fields of a `mail.received` observation the reply rule reads. */
export type ArrivedMail = {
  sender?: unknown;
  sender_domain?: unknown;
  subject?: unknown;
  in_reply_to?: unknown;
  received_at?: unknown;
  automated?: unknown;
};

/**
 * Whether new mail answers a message the person is waiting on, by the
 * waiting-on rule: a reply in the thread, anything from the person asked, or,
 * for a company, a colleague of theirs writing on the same subject. An
 * automatic reply answers nothing, and neither does mail from before the
 * message was sent.
 */
export function answers(awaited: Awaited, mail: ArrivedMail): boolean {
  if (mail.automated === true) return false;
  const received = text(mail.received_at);
  if (received && Date.parse(received) < Date.parse(awaited.sentAt)) return false;
  const inReplyTo = text(mail.in_reply_to)?.trim();
  if (inReplyTo && inReplyTo === awaited.messageId.trim()) return true;
  const sender = text(mail.sender)?.toLowerCase() ?? null;
  const to = awaited.toAddress.toLowerCase();
  if (sender && sender === to) return true;
  const domain = registrableDomain(to);
  const from = text(mail.sender_domain)?.toLowerCase() ?? null;
  return (
    domain !== null &&
    !isPersonalDomain(domain) &&
    from === domain &&
    baseSubject(text(mail.subject) ?? '') === baseSubject(awaited.subject)
  );
}

// --------------------------------------------------------------------------
// documents
// --------------------------------------------------------------------------

/** Whose change ends a deadline on a file: the person's own, or someone else's. */
export type DocumentToucher = (typeof DOCUMENT_TOUCHERS)[number];

/**
 * When a deadline on a Drive file is still at risk, as a clock's predicate over
 * the file's metadata. Drive cannot say a file was signed, so only the kind of
 * change the deadline names ends it:
 *
 * - `me`: the person changed it at or after `since` (`modified_by_me_time`,
 *   which Drive keeps per person, so a collaborator's edit never counts);
 * - `others`: it changed at or after `since` and Drive says the last change was
 *   not the person's (`last_modifier_me` explicitly false). An editor Drive
 *   does not name (an anonymous link, an app) is unknown, and stays at risk.
 *
 * A field Drive leaves out reads as no such change.
 */
export function documentAtRisk(since: string, by: DocumentToucher) {
  if (by === 'me')
    return {
      any: [
        { field: 'modified_by_me_time', op: 'lt' as const, value: since },
        { field: 'modified_by_me_time', op: 'eq' as const, value: null },
      ],
    };
  return {
    any: [
      { field: 'modified_time', op: 'lt' as const, value: since },
      { field: 'modified_time', op: 'eq' as const, value: null },
      { field: 'last_modifier_me', op: 'eq' as const, value: true },
      { field: 'last_modifier_me', op: 'eq' as const, value: null },
    ],
  };
}

/** Whether anyone changed the file at or after `since`: a change, but maybe not the one asked for. */
export function changedSince(fields: Record<string, unknown>, since: string): boolean {
  const at = typeof fields.modified_time === 'string' ? Date.parse(fields.modified_time) : NaN;
  return !Number.isNaN(at) && at >= Date.parse(since);
}
