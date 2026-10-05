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
  DOCUMENT_CHANGED,
  type JsonObject,
  MAIL_RECEIVED,
} from '@melete/contracts';
import { messageSender, messageSenderDomain } from '../companies/replies.ts';
import { instantMs } from './occurrences.ts';
import { senderAuthentication } from './sender-auth.ts';
import type {
  CalendarRead,
  DocumentChange,
  DocumentFile,
  Lookup,
  NewMail,
  Occurrence,
} from './types.ts';

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
 * A provider's id as it may appear in an indexed key: a fixed-length hash. An
 * id is whatever the provider or a sender chose, of any length, and an
 * over-long one must never stop an account's reads. The id itself travels,
 * clipped, in the observation.
 */
export const keyOf = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 40);

/** The dedup key a message is delivered under, from the key its source gave it. */
export const mailDedupKey = (key: string) => `${MAIL_RECEIVED}:${keyOf(key)}`;

/**
 * A new message as an observation. The words in it were written by whoever
 * sent it, so it is marked as outside content, and only the headers a watch
 * can test travel: who sent it, to how many, its subject line, when, the thread
 * it continues, whether the receiving server authenticated its sender, and
 * whether the provider filed it as spam.
 */
export function mailObservation(
  connectionId: string,
  message: NewMail,
  readAt: string,
): Observation {
  const receivedAt = message.date ?? readAt;
  return {
    event_name: MAIL_RECEIVED,
    dedup_key: mailDedupKey(message.key),
    payload: {
      kind: MAIL_RECEIVED,
      about: { type: 'mail_message', key: `mail:${connectionId}:${keyOf(message.key)}` },
      occurred_at: receivedAt,
      origin: 'external_content',
      message_id: message.message_id === null ? null : clip(message.message_id, 500),
      read_key:
        typeof message.read_key === 'string' ? clip(message.read_key, 600) : message.read_key,
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
      in_reply_to:
        message.in_reply_to === null || message.in_reply_to === undefined
          ? null
          : clip(message.in_reply_to, 500),
      // The thread's last few Message-IDs: enough to tell a reply to the person's own message.
      references: (message.references ?? []).slice(-20).map((id) => clip(id, 500)),
      automated: message.automated === true,
      // Whether the receiving server authenticated the sender for the From domain.
      sender_auth: message.sender_verified
        ? 'pass'
        : senderAuthentication(message.authentication_results, message.from_addresses ?? []),
      in_inbox: message.spam !== true,
    },
  };
}

// --------------------------------------------------------------------------
// documents
// --------------------------------------------------------------------------

/** What a deadline on a file is kept and checked by: one per connection and file. */
export const documentSubjectKey = (connectionId: string, fileId: string) =>
  `document:${connectionId}:${keyOf(fileId)}`;

/**
 * The state a deadline on a file reads: when it last changed, whether the
 * account's own person changed it and when, whether it is shared or in the
 * bin. No name and no editor: a file's words stay in its observation.
 */
export type DocumentFields = {
  file_id: string;
  modified_time: string | null;
  modified_by_me_time: string | null;
  last_modifier_me: boolean | null;
  shared: boolean;
  trashed: boolean;
  version: string | null;
};

export function documentFields(file: DocumentFile): DocumentFields {
  return {
    file_id: clip(file.id, 200),
    modified_time: file.modified_time,
    modified_by_me_time: file.modified_by_me_time,
    last_modifier_me: file.last_modifier_me,
    shared: file.shared,
    trashed: file.trashed,
    version: file.version === null ? null : clip(file.version, 40),
  };
}

/**
 * A file that changed, as an observation. Its name and its last editor were
 * written by people, so it is marked as outside content and carries only the
 * metadata a watch can test; never the file's contents. The same change read
 * twice (two polls, or a cursor read again) has the same key, so it is one
 * event; a later change to the same file is a new one.
 */
export function documentObservation(
  connectionId: string,
  change: DocumentChange,
  readAt: string,
): Observation {
  const file = change.file;
  const gone = change.removed || file === null;
  const state = gone
    ? ['removed']
    : [
        file.version,
        file.modified_time,
        file.trashed,
        file.shared,
        file.name,
        file.last_modifier,
        file.last_modifier_me,
      ];
  return {
    event_name: DOCUMENT_CHANGED,
    dedup_key: `${DOCUMENT_CHANGED}:${keyOf(change.file_id)}:${keyOf(JSON.stringify(state))}`,
    payload: {
      kind: DOCUMENT_CHANGED,
      about: { type: 'document', key: documentSubjectKey(connectionId, change.file_id) },
      occurred_at: (!gone && file.modified_time) || readAt,
      origin: 'external_content',
      file_id: clip(change.file_id, 200),
      removed: gone,
      ...(gone
        ? {}
        : {
            name: clip(file.name, 300),
            mime_type: clip(file.mime_type, 200),
            modified_time: file.modified_time,
            modified_by_me_time: file.modified_by_me_time,
            last_modifier_me: file.last_modifier_me,
            last_modifier: file.last_modifier === null ? null : clip(file.last_modifier, 200),
            shared: file.shared,
            trashed: file.trashed,
          }),
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
> & {
  ref?: string | null;
  response?: Occurrence['response'];
  /** How many lookups of an occurrence the read no longer lists have failed so far. */
  unconfirmed?: number;
};

/** How many failed lookups an unlisted occurrence is kept through before it is let go. */
export const MAX_UNCONFIRMED = 3;

/** The row kept for one occurrence between reads. */
export type KeptOccurrence = { subject_key: string; version: string; fields: OccurrenceFields };

export const occurrenceKey = (
  connectionId: string,
  occurrence: Pick<Occurrence, 'uid' | 'occurrence'>,
) => `calendar:${connectionId}:${keyOf(`${occurrence.uid}\u0000${occurrence.occurrence ?? ''}`)}`;

export function occurrenceFields(occurrence: Occurrence): OccurrenceFields {
  return {
    uid: clip(occurrence.uid, 500),
    occurrence: occurrence.occurrence,
    title: clip(occurrence.title, 300),
    start: occurrence.start,
    end: occurrence.end,
    all_day: occurrence.all_day,
    location: clip(occurrence.location, 300),
    status: occurrence.status,
    attendees: occurrence.attendees,
    time_zone: occurrence.time_zone === null ? null : clip(occurrence.time_zone, 100),
    ...(occurrence.ref ? { ref: clip(occurrence.ref, 500) } : {}),
    // Kept only where the source says, so a source that cannot tell keeps its versions.
    ...(occurrence.response ? { response: occurrence.response } : {}),
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
  /** Something about this read worth telling the person, in plain words. */
  note?: string;
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
 *   though it lies inside what both reads covered, is reported only on what a
 *   lookup says: `cancelled` when the provider says it is gone, `changed` when
 *   it was moved (out of the window, say), and nothing when it cannot tell.
 *   Kept occurrences that have ended are let go quietly.
 */
export function diffCalendar(input: {
  connectionId: string;
  kept: readonly KeptOccurrence[];
  read: CalendarRead;
  previous: CalendarCursor;
  window: { from: string; to: string };
  now: number;
  /** What a lookup said about each occurrence the read no longer lists; missing means unknown. */
  confirmed?: ReadonlyMap<string, Lookup>;
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
  const handled = new Set<string>();
  for (const row of vanished({ ...input, seen, horizon })) {
    handled.add(row.subject_key);
    const { unconfirmed = 0, ...last } = row.fields;
    const answer = input.confirmed?.get(row.subject_key);
    // Not looked up this time, or the lookup failed: kept, and asked about
    // again on the next read. Only a failure counts toward letting it go.
    if (answer === undefined || answer === 'failed') {
      const tries = unconfirmed + (answer === 'failed' ? 1 : 0);
      if (tries >= MAX_UNCONFIRMED) {
        out.remove.push(row.subject_key);
        out.note =
          'A meeting this calendar stopped listing could not be checked with the calendar, so whether it was cancelled is not known.';
        continue;
      }
      if (tries !== unconfirmed) {
        const fields = { ...last, unconfirmed: tries };
        out.upsert.push({ subject_key: row.subject_key, version: fieldsVersion(fields), fields });
      }
      continue;
    }
    if (answer === 'gone') {
      out.remove.push(row.subject_key);
      out.observations.push(
        observation(
          connectionId,
          CALENDAR_EVENTS.cancelled,
          row.subject_key,
          `removed-${fieldsVersion(last)}`,
          last,
          at,
          { reason: 'removed' },
        ),
      );
      continue;
    }
    if (answer === 'unknown') {
      // Not listed, and nothing says why: it may have moved past the window.
      // Saying nothing is better than a cancellation that did not happen.
      out.remove.push(row.subject_key);
      continue;
    }
    // Found elsewhere: it moved out of the window, or was cancelled there.
    const fields: OccurrenceFields = {
      ...occurrenceFields(answer),
      ...(row.fields.ref ? { ref: row.fields.ref } : {}),
    };
    const version = fieldsVersion(fields);
    out.upsert.push({ subject_key: row.subject_key, version, fields });
    if (version === row.version) continue;
    const changed = OCCURRENCE_FIELDS.filter(
      (field) => JSON.stringify(row.fields[field]) !== JSON.stringify(fields[field]),
    );
    if (fields.status === 'cancelled')
      out.observations.push(
        observation(connectionId, CALENDAR_EVENTS.cancelled, row.subject_key, version, fields, at, {
          reason: 'cancelled',
        }),
      );
    else if (changed.length)
      out.observations.push(
        observation(connectionId, CALENDAR_EVENTS.changed, row.subject_key, version, fields, at, {
          changed: [...changed],
          previous: Object.fromEntries(
            changed.map((field) => [field, row.fields[field] ?? null]),
          ) as JsonObject,
        }),
      );
  }
  for (const [key, row] of kept) {
    if (seen.has(key) || handled.has(key)) continue;
    // Past what this read could see: nothing is known about it either way.
    if (instantMs(row.fields.start) >= instantMs(horizon)) continue;
    // Ended, already cancelled, or never news: let it go quietly.
    out.remove.push(key);
    if (row.fields.unconfirmed)
      out.note =
        'A meeting this calendar stopped listing started before the calendar could confirm whether it was cancelled.';
  }
  return out;
}

/**
 * The kept occurrences a read no longer lists although it should have: not
 * yet ended, not already cancelled, and inside what both this read and the
 * last one covered. Each is looked up before anything is said about it.
 */
export function vanished(input: {
  connectionId: string;
  kept: readonly KeptOccurrence[];
  read: CalendarRead;
  previous: CalendarCursor;
  window: { from: string; to: string };
  now: number;
  seen?: ReadonlySet<string>;
  horizon?: string;
}): KeptOccurrence[] {
  if (!input.previous) return [];
  const horizon = instantMs(input.horizon ?? readHorizon(input.read, input.window));
  const covered = Math.min(instantMs(input.previous.window_end), horizon);
  const seen =
    input.seen ?? new Set(input.read.items.map((item) => occurrenceKey(input.connectionId, item)));
  return input.kept.filter((row) => {
    if (seen.has(row.subject_key) || row.fields.status === 'cancelled') return false;
    const start = instantMs(row.fields.start);
    const ends = Math.max(instantMs(row.fields.end), start);
    return ends > input.now && start < covered && start < horizon;
  });
}
