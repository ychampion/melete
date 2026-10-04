/**
 * What the service keeps to notice change in a connected account.
 *
 * `source_cursor` is where each account's change feed was last read: one row
 * per connection and stream (its mail, its calendar), with when to read next
 * and how the last reads went. A change is read once however often it is
 * announced, because the cursor moves past it.
 *
 * `subject_state` is the latest few fields known about each thing a source
 * reports on, one calendar occurrence per row: its start, end, place and
 * status. That is what lets the service say what changed rather than only
 * that something did. It never holds a message body or an event description.
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
    check('source_cursor_stream_check', sql`${table.stream} in ('mail', 'calendar')`),
    check('source_cursor_interval_check', sql`${table.intervalSeconds} > 0`),
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
