import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { GatewaySettlement } from '../gateway/types.ts';
import { episode } from './schema.ts';

/** How much of each source the model saw when one was cut to fit the call: counts, never text. */
export type ProposalTruncation = Partial<
  Record<'intervention' | 'objective', { sent: number; total: number }>
>;

/** A crashed or rejected proposal still consumed its one reserved model call. */
export const learningModelCall = pgTable('learning_model_call', {
  id: text('id').primaryKey(),
  episodeId: text('episode_id')
    .notNull()
    .unique()
    .references(() => episode.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  reservedTokens: integer('reserved_tokens').notNull(),
  maxOutputTokens: integer('max_output_tokens').notNull(),
  settlement: jsonb('settlement').$type<GatewaySettlement>(),
  truncation: jsonb('truncation').$type<ProposalTruncation>(),
  errorCode: text('error_code'),
  /** Why the call's answer was refused, as a reason code: never the refused text. */
  errorDetail: text('error_detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
