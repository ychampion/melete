/**
 * What sorting keeps.
 *
 * `triage_item` is one incoming observation (a message, a calendar change) for
 * the one person it is for, with the label it was given and where that label
 * came from: the built-in rules, a model, or an earlier label for the same
 * thing in the same words. An item that could not be sorted keeps why
 * (`unsorted`): kept private, a spending limit, or a failed call.
 *
 * `triage_verdict` is the cache: a label for one subject in one version of its
 * words, per person, for seven days. The same message read again, or a meeting
 * changed back to what it was, is labelled from here without a model call. It
 * is per person and per space on purpose: a label depends on whose it is, and
 * a shared cache would say who receives what.
 *
 * Neither table holds a message body: only the small header and calendar
 * fields the observation itself carries. Both are tied to the observation they
 * came from and are deleted with it, so nothing outlives what it was read from.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { connection, event, principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const triageItem = pgTable(
  'triage_item',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'cascade' }),
    /**
     * The observation's event sequence number: its `event:<seq>` handle. When
     * the observation goes (it expires, or watching the account is turned
     * off), the item goes with it.
     */
    eventSeq: bigint('event_seq', { mode: 'number' })
      .notNull()
      .references(() => event.seq, { onDelete: 'cascade' }),
    /** The observation's kind: `mail.received`, `calendar.event.changed` and so on. */
    kind: text('kind').notNull(),
    /** What it is about: a message, or a calendar occurrence (the same key `subject_state` uses). */
    subjectKey: text('subject_key').notNull(),
    /** A hash of the fields the label was read from. */
    contentHash: text('content_hash').notNull(),
    /** The small fields shown to the person and to the model; outside content. */
    fields: jsonb('fields').$type<Record<string, unknown>>().notNull(),
    verdict: text('verdict'),
    urgency: text('urgency').notNull().default('normal'),
    /** Melete's sentence about what needs the person. */
    sentence: text('sentence'),
    reason: text('reason'),
    /** `rules`, `model` or `cache`. */
    decidedBy: text('decided_by'),
    model: text('model'),
    /** Why it was left unsorted: `kept_private`, `limit_reached`, `failed`, `off`. */
    unsorted: text('unsorted'),
    /** Tries that failed (no usable answer, or kept private); each doubles the wait before the next. */
    tries: integer('tries').notNull().default(0),
    state: text('state').notNull().default('open'),
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    triagedAt: timestamp('triaged_at', { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    uniqueIndex('triage_item_event_idx').on(table.principalId, table.eventSeq),
    index('triage_item_principal_idx').on(table.principalId, table.state, table.createdAt),
    index('triage_item_pending_idx')
      .on(table.principalId, table.spaceId)
      .where(sql`${table.verdict} is null`),
    index('triage_item_space_idx').on(table.spaceId),
    // Deleting an observation finds what was read from it.
    index('triage_item_seq_idx').on(table.eventSeq),
    check(
      'triage_item_verdict_check',
      sql`${table.verdict} is null or ${table.verdict} in ('needs_you', 'fyi', 'ignore')`,
    ),
    // Sorting never makes anything urgent: only a deadline the person set does.
    check('triage_item_urgency_check', sql`${table.urgency} in ('normal', 'soon')`),
    check('triage_item_state_check', sql`${table.state} in ('open', 'acked', 'dismissed')`),
  ],
);

export const triageVerdict = pgTable(
  'triage_verdict',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /**
     * The newest observation the label was read from or reused for. The label,
     * with its reason and sentence, goes when that observation does.
     */
    eventSeq: bigint('event_seq', { mode: 'number' })
      .notNull()
      .references(() => event.seq, { onDelete: 'cascade' }),
    /** The account the labelled item was read from; its labels go when it is revoked. */
    connectionId: text('connection_id').references(() => connection.id, { onDelete: 'cascade' }),
    subjectKey: text('subject_key').notNull(),
    contentHash: text('content_hash').notNull(),
    verdict: text('verdict').notNull(),
    urgency: text('urgency').notNull(),
    sentence: text('sentence').notNull(),
    reason: text('reason').notNull(),
    model: text('model').notNull(),
    createdAt: created(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.principalId, table.spaceId, table.subjectKey, table.contentHash],
    }),
    index('triage_verdict_expires_idx').on(table.expiresAt),
    index('triage_verdict_space_idx').on(table.spaceId),
    index('triage_verdict_connection_idx').on(table.connectionId),
    index('triage_verdict_seq_idx').on(table.eventSeq),
    check('triage_verdict_verdict_check', sql`${table.verdict} in ('needs_you', 'fyi', 'ignore')`),
    check('triage_verdict_urgency_check', sql`${table.urgency} in ('normal', 'soon')`),
  ],
);
