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
import { check, index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { space } from '../db/schema.ts';

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
