/**
 * What the service keeps to notice change in a connected account.
 *
 * `source_cursor` is where each account's change feed was last read: one row
 * per connection and stream (its mail, its calendar, its Drive), with when to
 * read next and how the last reads went. A change is read once however often it is
 * announced, because the cursor moves past it.
 *
 * `subject_state` is the latest few fields known about each thing a source
 * reports on, one calendar occurrence per row: its start, end, place and
 * status. That is what lets the service say what changed rather than only
 * that something did. A Drive file a deadline follows keeps when it last
 * changed and whether its own person changed it, without its name. It never
 * holds a message body, an event description or a file's contents.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { connection, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const sourceCursor = pgTable(
  'source_cursor',
  {
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    stream: text('stream').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** Opaque to everything but the source that wrote it. Null until the first read. */
    cursor: jsonb('cursor'),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }).notNull().defaultNow(),
    intervalSeconds: integer('interval_s').notNull().default(300),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    failures: integer('failures').notNull().default(0),
    /** Why the last read failed, in words a person can read; null after a read that worked. */
    lastError: text('last_error'),
    /** Provider push subscriptions, once a source has them. */
    pushState: jsonb('push_state'),
    createdAt: created(),
  },
  (table) => [
    primaryKey({ columns: [table.connectionId, table.stream] }),
    index('source_cursor_due_idx').on(table.nextPollAt),
    index('source_cursor_space_idx').on(table.spaceId),
    check('source_cursor_stream_check', sql`${table.stream} in ('mail', 'calendar', 'documents')`),
    check('source_cursor_interval_check', sql`${table.intervalSeconds} > 0`),
  ],
);

/**
 * What was delivered once, kept after the observation itself is gone: the
 * delivery key alone (a hash of a provider's id and state, never a word of
 * what it said) and when it was seen. A mailbox that hands an old message back
 * after its observation expired is recognised, and nothing is delivered twice.
 */
export const observationTombstone = pgTable(
  'observation_tombstone',
  {
    dedupKey: text('dedup_key').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('observation_tombstone_seen_idx').on(table.seenAt),
    index('observation_tombstone_connection_idx').on(table.connectionId),
  ],
);

export const subjectState = pgTable(
  'subject_state',
  {
    /** Names the connection and the thing: `calendar:<connection>:<uid>:<occurrence>`. */
    subjectKey: text('subject_key').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** Small typed fields only. */
    fields: jsonb('fields').notNull(),
    /** A hash of `fields`: the same version is the same state. */
    version: text('version').notNull(),
    origin: text('origin').notNull(),
    lastChangedAt: timestamp('last_changed_at', { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (table) => [
    index('subject_state_connection_idx').on(table.connectionId, table.type),
    index('subject_state_space_idx').on(table.spaceId),
  ],
);

/**
 * Calls made through a managed sign-in provider (Composio), counted per
 * person and calendar month: a watched account's reads and the agent's own
 * calls alike. The installation's monthly limit is read against the sum of a
 * month's rows. Only counts are kept, never what a call asked or answered.
 */
export const managedCall = pgTable(
  'managed_call',
  {
    /** The person whose space the connection is in. */
    principalId: text('principal_id').notNull(),
    /** The calendar month in UTC, `YYYY-MM`. */
    month: text('month').notNull(),
    calls: integer('calls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.month] }),
    index('managed_call_month_idx').on(table.month),
    check('managed_call_month_check', sql`${table.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check('managed_call_calls_check', sql`${table.calls} >= 0`),
  ],
);
