/**
 * The company map's tables. Four of them: who the companies are, what the
 * ledger says, the text every quote is checked against, and the record of one
 * scan.
 *
 * `company_message` exists because the evidence rule needs the exact text the
 * extraction read, months later, when somebody clicks a figure. Keeping the
 * text is what makes `GET /ledger/:id` able to show the sentence rather than a
 * claim about a sentence.
 *
 * Every row carries both the space and the principal. The space says which
 * installation it belongs to; the principal says whose it is, so a second person
 * in a shared space cannot read the first person's map.
 */

import type { LedgerEvidence } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const company = pgTable(
  'company',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    monthlySpendMinor: integer('monthly_spend_minor'),
    currency: text('currency'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    messageCount: integer('message_count').notNull().default(0),
    createdAt: created(),
  },
  (table) => [
    // One company per domain per person: a second scan updates the row it found before.
    uniqueIndex('company_owner_domain_idx').on(table.spaceId, table.principalId, table.domain),
    check(
      'company_spend_nonnegative',
      sql`${table.monthlySpendMinor} is null or ${table.monthlySpendMinor} >= 0`,
    ),
  ],
);

/**
 * The stored text of one message, keyed by the id the evidence cites. It is the
 * only thing a span is ever checked against, so it is written before any item
 * that quotes it and never rewritten.
 */
export const companyMessage = pgTable(
  'company_message',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    subject: text('subject').notNull(),
    fromAddress: text('from_address').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    body: text('body').notNull(),
    /** When an extraction call answered for this message. A later scan does not ask again. */
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    uniqueIndex('company_message_owner_idx').on(table.spaceId, table.principalId, table.messageId),
  ],
);

export const ledgerItem = pgTable(
  'ledger_item',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => company.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    direction: text('direction').notNull(),
    amountMinor: integer('amount_minor'),
    currency: text('currency'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    dueDateOnly: boolean('due_date_only').notNull().default(false),
    status: text('status').notNull().default('found'),
    confidence: text('confidence').notNull(),
    evidence: jsonb('evidence').$type<LedgerEvidence[]>().notNull(),
    suggestedPlaybook: text('suggested_playbook'),
    jobId: text('job_id'),
    summary: text('summary').notNull(),
    /** The scan that found it, so a re-scan can replace its own findings. */
    scanId: text('scan_id').notNull(),
    /** What `dedupeKey` computed, so a re-scan recognises a claim it already has. */
    dedupeKey: text('dedupe_key').notNull(),
    createdAt: created(),
  },
  (table) => [
    index('ledger_item_owner_idx').on(table.spaceId, table.principalId, table.status),
    uniqueIndex('ledger_item_dedupe_idx').on(table.spaceId, table.principalId, table.dedupeKey),
    // A finishing chase finds the item it was handling by this.
    index('ledger_item_job_idx').on(table.jobId).where(sql`${table.jobId} is not null`),
    check(
      'ledger_item_amount_nonnegative',
      sql`${table.amountMinor} is null or ${table.amountMinor} >= 0`,
    ),
  ],
);

/**
 * One run. It carries its own counts so the progress a person watches is read
 * from a row rather than inferred, and so a finished scan can still say how
 * many claims it refused.
 */
export const companyScan = pgTable(
  'company_scan',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('running'),
    messagesSeen: integer('messages_seen').notNull().default(0),
    itemsFound: integer('items_found').notNull().default(0),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    error: text('error'),
    /** Model calls this scan made, counted against its person's daily allowance. */
    modelCalls: integer('model_calls').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: created(),
  },
  (table) => [
    index('company_scan_owner_idx').on(table.spaceId, table.principalId, table.status),
    index('company_scan_principal_started_idx').on(table.principalId, table.startedAt),
  ],
);
