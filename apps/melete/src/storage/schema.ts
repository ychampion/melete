/**
 * Who still needs a blob.
 *
 * One row per owner of a blob: an owner is any row elsewhere that names the
 * blob by its key, recorded here by kind and id. A blob with no row is
 * unreferenced, and the collector deletes it once it has been so for the grace
 * period. Every reference belongs to a space, and removing the space removes
 * its references and every blob only it referred to.
 */
import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { job, space } from '../db/schema.ts';

export const blobRef = pgTable(
  'blob_ref',
  {
    key: text('key').notNull(),
    ownerKind: text('owner_kind').notNull(),
    ownerId: text('owner_id').notNull(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.ownerKind, table.ownerId] }),
    index('blob_ref_space_idx').on(table.spaceId),
    check('blob_ref_key_shape', sql`${table.key} ~ '^sha256/[0-9a-f]{64}$'`),
  ],
);

export type BlobRefRow = typeof blobRef.$inferSelect;

/**
 * What each file a person's work saved holds, so how much a person keeps is
 * read from rows rather than from the disk (`per-person.ts`). One row per
 * place: `files:<path>` in the space's Files, or `chat:<job>:<path>` in one
 * chat's own folder, which goes with its chat. A file deleted into the trash
 * keeps its row, marked with that trash, and is not counted until it is
 * restored.
 */
export const storedFile = pgTable(
  'stored_file',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    place: text('place').notNull(),
    /** The chat whose own folder holds it; null for the space's Files. */
    jobId: text('job_id').references(() => job.id, { onDelete: 'cascade' }),
    /** Who it counts against: the person whose work saved it last. */
    principalId: text('principal_id'),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    /** The trash it is in, when it was deleted; null while it is there. */
    trashId: text('trash_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.place] }),
    index('stored_file_principal_idx').on(table.principalId),
    index('stored_file_job_idx').on(table.jobId),
    check('stored_file_bytes', sql`${table.bytes} >= 0`),
  ],
);

export type StoredFileRow = typeof storedFile.$inferSelect;
