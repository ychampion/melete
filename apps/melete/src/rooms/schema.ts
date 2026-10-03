/**
 * A room is a shared space where several people talk to one agent in threads.
 * The space, its members and its generations live in the main schema; these
 * tables hold what is said in the room.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { job, principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const roomThread = pgTable(
  'room_thread',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => principal.id),
    createdAt: created(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('room_thread_space_idx').on(t.spaceId, t.lastActivityAt)],
);

/**
 * The room's transcript: every person's message, with its author. The agent's
 * answers are not copied here; they are read from the request jobs.
 */
export const roomMessage = pgTable(
  'room_message',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    threadId: text('thread_id')
      .notNull()
      .references(() => roomThread.id, { onDelete: 'cascade' }),
    authorPrincipalId: text('author_principal_id')
      .notNull()
      .references(() => principal.id),
    kind: text('kind').notNull().default('person'),
    /** Posted for a person by their own agent, after they approved the exact text. */
    viaAgent: boolean('via_agent').notNull().default(false),
    text: text('text').notNull(),
    /** Who the message named, in the order it named them. */
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    /**
     * `none`: conversation between people. `pending`: it asks the agent and waits
     * its turn in the thread. `started`: it reached a request job.
     */
    requestState: text('request_state').notNull().default('none'),
    requestJobId: text('request_job_id').references(() => job.id, { onDelete: 'set null' }),
    submissionId: text('submission_id').notNull().unique(),
    /**
     * The sequence number of the newest event about this message, so a thread's
     * live stream sends it again, in commit order, whenever it changes.
     */
    streamSeq: bigint('stream_seq', { mode: 'number' }).notNull().default(0),
    createdAt: created(),
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (t) => [
    index('room_message_thread_idx').on(t.threadId, t.createdAt),
    index('room_message_stream_idx').on(t.threadId, t.streamSeq),
    index('room_message_pending_idx')
      .on(t.spaceId, t.requestState)
      .where(sql`${t.requestState} = 'pending'`),
    check('room_message_kind', sql`${t.kind} in ('person', 'handoff_result', 'system')`),
    check('room_message_request_state', sql`${t.requestState} in ('none', 'pending', 'started')`),
  ],
);

/** Who is looking at a room now. Display only: it never decides what anyone may read. */
export const roomPresence = pgTable(
  'room_presence',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.principalId] })],
);
