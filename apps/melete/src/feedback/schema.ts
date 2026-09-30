/**
 * Problem reports sent from inside the app. A report belongs to the
 * installation that took it and names the person who sent it; it outlives that
 * person's account, so whoever runs the installation can still fix what they
 * reported.
 */
import type { FeedbackContext, FeedbackStatus } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { owner, principal } from '../db/schema.ts';

export const feedback = pgTable(
  'feedback',
  {
    /** `FB-` and a few characters that are easy to read aloud. */
    id: text('id').primaryKey(),
    installationId: text('installation_id')
      .notNull()
      .references(() => owner.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').references(() => principal.id, { onDelete: 'set null' }),
    message: text('message').notNull(),
    route: text('route'),
    appVersion: text('app_version').notNull(),
    context: jsonb('context').$type<FeedbackContext>().notNull(),
    status: text('status').$type<FeedbackStatus>().notNull().default('open'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('feedback_installation_created_idx').on(t.installationId, t.createdAt),
    index('feedback_principal_created_idx').on(t.principalId, t.createdAt),
    check('feedback_status_check', sql`${t.status} in ('open', 'fixing', 'fixed', 'wontfix')`),
  ],
);
