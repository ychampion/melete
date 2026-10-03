/**
 * Files a person sent, or is about to send, in chat.
 *
 * A row is made when the file is uploaded, with no chat yet. Sending the
 * message that carries it gives it the chat (`job_id`) and the turn; until
 * then only the person who uploaded it can see or send it, and one left unsent
 * for a day is deleted. The bytes are in the blob store, named by `blob_key`
 * and, for a picture, `preview_key` (the small copy the model is shown); each
 * is referred to in `blob_ref` by this row. `text` is what could be read from
 * the file, kept so every later turn and read gives the same words.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { job, space } from '../db/schema.ts';

export const attachment = pgTable(
  'attachment',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id),
    /** Who uploaded it. Only they can send it or see it before it is sent. */
    principalId: text('principal_id'),
    /** The chat it was sent in; null until then. The chat's deletion takes the row. */
    jobId: text('job_id').references(() => job.id, { onDelete: 'cascade' }),
    turnId: text('turn_id'),
    /** Its place among the files of its message. */
    position: integer('position').notNull().default(0),
    name: text('name').notNull(),
    mediaType: text('media_type').notNull(),
    kind: text('kind').notNull(),
    size: integer('size').notNull(),
    blobKey: text('blob_key').notNull(),
    previewKey: text('preview_key'),
    text: text('text'),
    pages: integer('pages'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    index('attachment_job_idx').on(table.jobId),
    index('attachment_space_idx').on(table.spaceId),
    check('attachment_kind', sql`${table.kind} in ('image', 'pdf', 'docx', 'xlsx', 'csv', 'text')`),
  ],
);

export type AttachmentRow = typeof attachment.$inferSelect;
