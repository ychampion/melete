import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { owner } from './schema.ts';

/** Only a digest is stored, so a database read cannot recover a session cookie. */
export const session = pgTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('session_expires_idx').on(table.expiresAt)],
);
