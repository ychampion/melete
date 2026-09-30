/**
 * Phone calls and the conversation a line's inbound calls land in.
 *
 * A call row exists before the call does: an outbound call is written as
 * `dialing` under the action that approved it, so one action can place one
 * call however often it is dispatched, and the day's count is read from these
 * rows under a lock. The call context (why the call exists, what may be
 * shared, what must not be agreed to) is written once, from the approved
 * payload, and nothing a turn carries ever changes it.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { action, connection, job, space } from '../db/schema.ts';

/** What an approved call may do, from the approved payload alone. */
export type CallContext = {
  purpose?: string;
  may_share?: string;
  must_not_agree_to?: string;
  callee_name?: string;
};

export type StoredLine = { speaker: 'melete' | 'caller'; text: string; at_seconds: number | null };

export const phoneCall = pgTable(
  'phone_call',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    attemptId: text('attempt_id'),
    actionId: text('action_id').references(() => action.id, { onDelete: 'cascade' }),
    direction: text('direction').$type<'outbound' | 'inbound'>().notNull(),
    /** A phone call, or a WhatsApp conversation (a chat or a call) on the line's WhatsApp number. */
    channel: text('channel').$type<'phone' | 'whatsapp'>().notNull().default('phone'),
    party: text('party').$type<'person' | 'other' | 'unknown'>().notNull(),
    remoteNumber: text('remote_number').notNull(),
    context: jsonb('context').$type<CallContext>().notNull().default({}),
    conversationId: text('conversation_id'),
    status: text('status').$type<'dialing' | 'in_progress' | 'ended' | 'failed'>().notNull(),
    turns: integer('turns').notNull().default(0),
    holding: boolean('holding').notNull().default(false),
    questionId: text('question_id'),
    outcome: text('outcome'),
    followUps: jsonb('follow_ups').$type<string[]>().notNull().default([]),
    transcript: jsonb('transcript').$type<StoredLine[]>().notNull().default([]),
    durationSeconds: integer('duration_seconds'),
    failure: text('failure'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('phone_call_action_idx').on(t.actionId).where(sql`${t.actionId} is not null`),
    uniqueIndex('phone_call_conversation_idx')
      .on(t.connectionId, t.conversationId)
      .where(sql`${t.conversationId} is not null`),
    index('phone_call_count_idx').on(t.connectionId, t.direction, t.createdAt),
    check('phone_call_direction_check', sql`${t.direction} in ('outbound', 'inbound')`),
    check('phone_call_channel_check', sql`${t.channel} in ('phone', 'whatsapp')`),
    check('phone_call_party_check', sql`${t.party} in ('person', 'other', 'unknown')`),
    check(
      'phone_call_status_check',
      sql`${t.status} in ('dialing', 'in_progress', 'ended', 'failed')`,
    ),
  ],
);

/** The conversation a line's inbound calls are told in, made the first time one arrives. */
export const phoneLine = pgTable('phone_line', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => connection.id, { onDelete: 'cascade' }),
  jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
