/**
 * Turning what a source read into observations.
 *
 * An observation is a small record: its kind from the connection's catalog,
 * what it is about, when it happened, where its words came from, and a few
 * typed fields. Bodies never travel in one: a message is referred to by the
 * key `email.read` opens it with.
 *
 * Calendar observations come from comparing a fresh read with the occurrences
 * kept from the last one (`subject_state`), so `calendar.event.changed` names
 * the fields that changed and what they were before. Everything here is a
 * plain function over rows: no reads, no writes, no clock but the one passed in.
 */
import { createHash } from 'node:crypto';
import {
  CALENDAR_EVENTS,
  type CalendarEventName,
  type JsonObject,
  MAIL_RECEIVED,
} from '@melete/contracts';
import { messageSender, messageSenderDomain } from '../companies/replies.ts';
import { instantMs } from './occurrences.ts';
import type { CalendarRead, NewMail, Occurrence } from './types.ts';

/** What an observation's words are: the account's own record, or text someone else wrote. */
export type ObservationOrigin = 'verified_connector' | 'external_content';

/** One observation, ready for `TriggerService.deliver`. */
export type Observation = {
  event_name: string;
  /** Makes a second sighting of the same thing, in the same state, the same event. */
  dedup_key: string;
  payload: JsonObject;
};

const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;

/**
 * A new message as an observation. The words in it were written by whoever
 * sent it, so it is marked as outside content, and only the headers a watch
 * can test travel: who sent it, to how many, its subject line, when.
 */
export function mailObservation(
  connectionId: string,
  message: NewMail,
  readAt: string,
): Observation {
  const receivedAt = message.date ?? readAt;
  return {
    event_name: MAIL_RECEIVED,
    dedup_key: `${MAIL_RECEIVED}:${message.key}`,
    payload: {
      kind: MAIL_RECEIVED,
      about: { type: 'mail_message', key: `mail:${connectionId}:${message.key}` },
      occurred_at: receivedAt,
      origin: 'external_content',
      message_id: message.message_id,
      read_key: message.read_key,
      from: clip(message.from, 300),
      sender: messageSender({
        messageId: message.key,
        from: message.from,
        ...(message.from_addresses ? { fromAddresses: message.from_addresses } : {}),
        subject: '',
        receivedAt,
      }),
      sender_domain: messageSenderDomain({
        messageId: message.key,
        from: message.from,
        ...(message.from_addresses ? { fromAddresses: message.from_addresses } : {}),
        subject: '',
        receivedAt,
      }),
      subject: clip(message.subject, 300),
      received_at: receivedAt,
      to_count: message.to_addresses?.length ?? 0,
      in_reply_to: message.in_reply_to ?? null,
      automated: message.automated === true,
    },
  };
}

// --------------------------------------------------------------------------
// calendar
// --------------------------------------------------------------------------

/** The fields kept for an occurrence and compared between reads. */
export const OCCURRENCE_FIELDS = [
  'title',
  'start',
  'end',
  'all_day',
  'location',
  'status',
  'attendees',
] as const;
type OccurrenceField = (typeof OCCURRENCE_FIELDS)[number];

export type OccurrenceFields = Pick<
  Occurrence,
  OccurrenceField | 'uid' | 'occurrence' | 'time_zone'
>;

/** The row kept for one occurrence between reads. */
export type KeptOccurrence = { subject_key: string; version: string; fields: OccurrenceFields };

export const occurrenceKey = (
  connectionId: string,
  occurrence: Pick<Occurrence, 'uid' | 'occurrence'>,
) => `calendar:${connectionId}:${occurrence.uid}:${occurrence.occurrence ?? ''}`;

export function occurrenceFields(occurrence: Occurrence): OccurrenceFields {
  return {
    uid: occurrence.uid,
    occurrence: occurrence.occurrence,
    title: clip(occurrence.title, 300),
    start: occurrence.start,
    end: occurrence.end,
    all_day: occurrence.all_day,
    location: clip(occurrence.location, 300),
    status: occurrence.status,
    attendees: occurrence.attendees,
    time_zone: occurrence.time_zone,
  };
}

/** The same fields are the same version, whatever order a provider listed them in. */
export function fieldsVersion(fields: OccurrenceFields): string {
  const ordered = Object.fromEntries(
    Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex').slice(0, 32);
}

/** What the last read covered, kept in the calendar stream's cursor. */
export type CalendarCursor = { window_end: string } | null;

/** The writes a calendar read leads to, beside the observations it delivers. */
export type CalendarDiff = {
  observations: Observation[];
  upsert: KeptOccurrence[];
  remove: string[];
  /** How far this read saw, for the next read's cursor. */
  window_end: string;
};

function readHorizon(read: CalendarRead, window: { to: string }): string {
  if (read.complete || !read.items.length) return window.to;
  const last = Math.max(...read.items.map((item) => instantMs(item.start)));
  return new Date(Math.min(last, instantMs(window.to))).toISOString();
}

function observation(
  connectionId: string,
  name: CalendarEventName,
  key: string,
  version: string,
  fields: OccurrenceFields,
  occurredAt: string,
  extra: JsonObject = {},
): Observation {
  return {
    event_name: name,
    dedup_key: `${name}:${key}:${version}`,
    payload: {
      kind: name,
      about: { type: 'calendar_occurrence', key },
      occurred_at: occurredAt,
      // Titles and places can come from whoever sent the invitation.
      origin: 'external_content',
      connection_id: connectionId,
      ...fields,
      ...extra,
    },
  };
}

/**
 * Compare a fresh read with what was kept.
 *
 * - An occurrence never seen before is `created` when it starts inside the
 *   part of the window the last read already covered. One that only came into
 *   view because the window moved on (next month's Tuesday) is kept quietly.
 *   The first read of a calendar keeps everything quietly: it is where
 *   watching starts, not news.
 * - A kept occurrence whose fields differ is `changed`, naming the fields and
 *   their previous values. One whose status turned to cancelled is
 *   `cancelled`.
 * - A kept occurrence that has not ended and that the read no longer holds,
 *   though it lies inside what both reads covered, was removed: `cancelled`.
 *   Kept occurrences that have ended are let go quietly.
 */
export function diffCalendar(input: {
  connectionId: string;
  kept: readonly KeptOccurrence[];
  read: CalendarRead;
  previous: CalendarCursor;
  window: { from: string; to: string };
  now: number;
}): CalendarDiff {
  const { connectionId, previous, now } = input;
  const at = new Date(now).toISOString();
  const kept = new Map(input.kept.map((row) => [row.subject_key, row]));
  const horizon = readHorizon(input.read, input.window);
  const out: CalendarDiff = { observations: [], upsert: [], remove: [], window_end: horizon };
  const covered = previous ? Math.min(instantMs(previous.window_end), instantMs(horizon)) : null;
  const seen = new Set<string>();
  for (const occurrence of input.read.items) {
    const key = occurrenceKey(connectionId, occurrence);
    if (seen.has(key)) continue;
    seen.add(key);
    const fields = occurrenceFields(occurrence);
    const version = fieldsVersion(fields);
    const before = kept.get(key);
    const occurredAt = occurrence.updated_at ?? at;
    if (!before) {
      out.upsert.push({ subject_key: key, version, fields });
      const isNew =
        covered !== null &&
        occurrence.status !== 'cancelled' &&
        instantMs(occurrence.start) < covered;
      if (isNew)
        out.observations.push(
          observation(connectionId, CALENDAR_EVENTS.created, key, version, fields, occurredAt),
        );
      continue;
    }
    if (before.version === version) continue;
    out.upsert.push({ subject_key: key, version, fields });
    const changed = OCCURRENCE_FIELDS.filter(
      (field) => JSON.stringify(before.fields[field]) !== JSON.stringify(fields[field]),
    );
    if (!changed.length) continue;
    const previousValues = Object.fromEntries(
      changed.map((field) => [field, before.fields[field] ?? null]),
    ) as JsonObject;
    if (fields.status === 'cancelled' && before.fields.status !== 'cancelled')
      out.observations.push(
        observation(connectionId, CALENDAR_EVENTS.cancelled, key, version, fields, occurredAt, {
          reason: 'cancelled',
        }),
      );
    else if (fields.status !== 'cancelled')
      out.observations.push(
        observation(connectionId, CALENDAR_EVENTS.changed, key, version, fields, occurredAt, {
          changed: [...changed],
          previous: previousValues,
        }),
      );
  }
  for (const [key, row] of kept) {
    if (seen.has(key)) continue;
    // Past what this read could see: nothing is known about it either way.
    if (instantMs(row.fields.start) >= instantMs(horizon)) continue;
    const ends = Math.max(instantMs(row.fields.end), instantMs(row.fields.start));
    out.remove.push(key);
    if (ends <= now || covered === null) continue;
    if (row.fields.status === 'cancelled') continue;
    if (instantMs(row.fields.start) >= covered) continue;
    out.observations.push(
      observation(
        connectionId,
        CALENDAR_EVENTS.cancelled,
        key,
        `removed-${row.version}`,
        row.fields,
        at,
        {
          reason: 'removed',
        },
      ),
    );
  }
  return out;
}
