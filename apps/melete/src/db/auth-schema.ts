import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { connection, owner, principal, space } from './schema.ts';

/** Only a digest is stored, so a database read cannot recover a session cookie. */
export const session = pgTable(
  'session',
  {
    tokenHash: text('token_hash').primaryKey(),
    principalId: text('principal_id').references(() => principal.id, { onDelete: 'cascade' }),
    spaceId: text('space_id').references(() => space.id, { onDelete: 'cascade' }),
    /** The membership generation a shared space was selected under; a regrant never matches it. */
    membershipGeneration: integer('membership_generation'),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('session_expires_idx').on(table.expiresAt)],
);

/** Single-use digests bind a login to the mailbox connection that delivered it. */
export const magicLink = pgTable(
  'magic_link',
  {
    tokenHash: text('token_hash').primaryKey(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    connectionGeneration: integer('connection_generation').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('magic_link_owner_created_idx').on(table.ownerId, table.createdAt)],
);
