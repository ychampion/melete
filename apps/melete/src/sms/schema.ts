/**
 * Texts through a Twilio number, both ways.
 *
 * An incoming text is kept once per Twilio message: `message_sid` is unique for
 * the connection, so a webhook Twilio delivers twice is one row and at most one
 * turn. A text from one of the person's own numbers carries the conversation
 * and the turn it became; any other text is `kept`, for the person to read, and
 * never reaches a conversation.
 *
 * A reply is one row per text it was split into, written before it is sent and
 * unique by turn and part, so a turn is answered by text at most once whoever
 * finds it finished first.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { connection, job, space } from '../db/schema.ts';

export const smsText = pgTable(
  'sms_text',
  {
    id: text('id').primaryKey(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** `in` from a phone to the Twilio number, `out` from it. */
    direction: text('direction').notNull(),
    /** The other phone: who sent an incoming text, who a reply went to. */
    counterpart: text('counterpart').notNull(),
    body: text('body').notNull(),
    /** An incoming text from one of the person's own numbers. */
    fromYou: boolean('from_you').notNull().default(false),
    /** Twilio's id for the message, once Twilio has given one. */
    messageSid: text('message_sid'),
    /** The conversation an incoming text went to, or a reply came from. */
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    turnId: text('turn_id'),
    /** Which text of a split reply, from 0. */
    part: integer('part').notNull().default(0),
    /**
     * In: `conversation`, `kept`, or `refused` when the conversation could not
     * take it. Out: `sending`, then `sent` or `failed`.
     */
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sms_text_message_idx')
      .on(t.connectionId, t.messageSid)
      .where(sql`${t.direction} = 'in' and ${t.messageSid} is not null`),
    uniqueIndex('sms_text_reply_idx')
      .on(t.turnId, t.part)
      .where(sql`${t.direction} = 'out' and ${t.turnId} is not null`),
    index('sms_text_connection_idx').on(t.connectionId, t.createdAt),
    check('sms_text_direction', sql`${t.direction} in ('in', 'out')`),
    check(
      'sms_text_state',
      sql`${t.state} in ('conversation', 'kept', 'refused', 'sending', 'sent', 'failed')`,
    ),
  ],
);
