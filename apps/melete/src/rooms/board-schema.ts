/**
 * A room's board: dated items its people and its agent keep together. Who may
 * read an item is decided by its `visibility` and the reader's place in the
 * room, in the query that reads it (rooms/board.ts).
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { principal, space } from '../db/schema.ts';
import { roomThread } from './schema.ts';

export const roomBoardItem = pgTable(
  'room_board_item',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** `event`, `task`, `question` or `note`. */
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    assigneePrincipalId: text('assignee_principal_id').references(() => principal.id, {
      onDelete: 'set null',
    }),
    /** `everyone`, `owners`, or `assignee` (the assignee and the owners). */
    visibility: text('visibility').notNull().default('everyone'),
    /** `open`, `claimed`, `done` or `answered`. */
    state: text('state').notNull().default('open'),
    claimedBy: text('claimed_by').references(() => principal.id, { onDelete: 'set null' }),
    /** The answers a question suggests. */
    choices: jsonb('choices').$type<string[]>(),
    answer: text('answer'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    /** The thread a question was asked in, where its answer is posted. */
    sourceThreadId: text('source_thread_id').references(() => roomThread.id, {
      onDelete: 'set null',
    }),
    /** The room message an answer was posted as. */
    answerMessageId: text('answer_message_id'),
    /** The agent's action that made it, so a retried action makes it once. */
    actionId: text('action_id').unique(),
    createdBy: text('created_by')
      .notNull()
      .references(() => principal.id),
    /** The sequence number of the newest event about this item, so a board stream resends it. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('room_board_item_space_idx').on(t.spaceId, t.seq),
    index('room_board_item_assignee_idx').on(t.assigneePrincipalId, t.state),
    check('room_board_item_kind', sql`${t.kind} in ('event', 'task', 'question', 'note')`),
    check('room_board_item_visibility', sql`${t.visibility} in ('everyone', 'owners', 'assignee')`),
    check('room_board_item_state', sql`${t.state} in ('open', 'claimed', 'done', 'answered')`),
    check('room_board_item_title', sql`length(${t.title}) between 1 and 120`),
    check('room_board_item_detail', sql`${t.detail} is null or length(${t.detail}) <= 2000`),
    check('room_board_item_answer', sql`${t.answer} is null or length(${t.answer}) <= 2000`),
  ],
);
