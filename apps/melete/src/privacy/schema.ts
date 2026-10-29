/**
 * What the privacy router keeps.
 *
 * `privacy_settings` is one row per space: the plain choices in `settings`, and
 * the person's own listed values and the local model's key sealed in `sealed`.
 * `privacy_vault` holds one conversation's placeholders, sealed as a whole and
 * bound to the conversation id. `privacy_conversation` remembers that a
 * conversation was found sensitive and what the person answered when asked.
 * `privacy_request` is the audit trail: one row per model request with its
 * route and what was swapped, by category and placeholder name, never a value.
 * `privacy_seen` is what a cloud model was sent from the person and from tools
 * in each turn, as it left: redacted, so it holds placeholders, never the
 * values behind them. Each piece is kept once per conversation; past the
 * conversation's history limit its text is blanked and the row kept, so the
 * piece re-sent later is still known (`seen.ts` has the limits).
 * Every row goes with its space.
 */
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { space } from '../db/schema.ts';

const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const privacySettings = pgTable('privacy_settings', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => space.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').notNull().default({}),
  sealed: text('sealed'),
  version: integer('version').notNull().default(1),
  updatedAt: updated(),
});

export const privacyVault = pgTable('privacy_vault', {
  conversationId: text('conversation_id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  sealed: text('sealed').notNull(),
  entries: integer('entries').notNull().default(0),
  updatedAt: updated(),
});

export const privacyConversation = pgTable('privacy_conversation', {
  conversationId: text('conversation_id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  /**
   * health, therapy or finance, once found in what the person wrote; it does
   * not go back unless they clear it, which stores `none`.
   */
  sensitive: text('sensitive'),
  /**
   * Whether the person set the topic themselves. A topic they set holds
   * whatever the privacy settings say; one found in what they wrote holds
   * only while that topic is kept private. A row from before this was
   * recorded counts as theirs, so it holds as it always did.
   */
  sensitiveByPerson: boolean('sensitive_by_person').notNull().default(true),
  /**
   * When the person last cleared it. What they write after this is still
   * read, so a later phrase about themselves marks it sensitive again.
   */
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  /** allowed: the person agreed to a redacted cloud request. declined: not this turn. */
  consent: text('consent'),
  consentTurnId: text('consent_turn_id'),
  askedAttemptId: text('asked_attempt_id'),
  updatedAt: updated(),
});

export const privacyRequest = pgTable(
  'privacy_request',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    spaceId: text('space_id').references(() => space.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    jobId: text('job_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    turnId: text('turn_id'),
    route: text('route').notNull(),
    protected: integer('protected').notNull().default(0),
    categories: jsonb('categories').notNull().default({}),
    placeholders: jsonb('placeholders').notNull().default([]),
    localDetection: text('local_detection'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('privacy_request_conversation_idx').on(t.conversationId, t.turnId)],
);

export const privacySeen = pgTable(
  'privacy_seen',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').notNull(),
    turnId: text('turn_id').notNull(),
    /** you: the person's own message. tool: what a tool brought back. */
    source: text('source').notNull(),
    tool: text('tool'),
    /** Of the whole piece as sent, so a piece re-sent in a later request is kept once. */
    digest: text('digest').notNull(),
    /** The redacted text, cut at a limit when it was longer. Empty once blanked. */
    text: text('text').notNull(),
    truncated: boolean('truncated').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('privacy_seen_piece_idx').on(t.conversationId, t.digest),
    index('privacy_seen_turn_idx').on(t.conversationId, t.turnId),
  ],
);
