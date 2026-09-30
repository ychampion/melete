/**
 * Notetakers sent into meetings.
 *
 * One row per approved `meeting.join` action, keyed by that action, so one
 * approval can never become two notetakers. The row is the completion
 * worker's to-do list: it names the conversation to report back to, the
 * notetaker to ask about, and when to ask next. A webhook from the provider
 * only moves `next_check_at` to now; it never carries the notes themselves.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { action, connection, job, space } from '../db/schema.ts';

export const MEETING_BOT_STATUSES = ['scheduled', 'completed', 'failed'] as const;

export const meetingBot = pgTable(
  'meeting_bot',
  {
    actionId: text('action_id')
      .primaryKey()
      .references(() => action.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** The job that proposed the join; its conversation is where the notes go. */
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    /** The provider's id for the notetaker. */
    botId: text('bot_id').notNull(),
    meetingUrl: text('meeting_url').notNull(),
    botName: text('bot_name').notNull(),
    joinAt: timestamp('join_at', { withTimezone: true }),
    status: text('status').notNull().default('scheduled'),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    checks: integer('checks').notNull().default(0),
    /** The transcript file, once written. */
    artifactId: text('artifact_id'),
    /** Plain words for the person when the notes could not be brought back. */
    failure: text('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('meeting_bot_bot_idx').on(t.connectionId, t.botId),
    index('meeting_bot_due_idx').on(t.status, t.nextCheckAt),
    check('meeting_bot_status_check', sql`${t.status} in ('scheduled', 'completed', 'failed')`),
  ],
);
