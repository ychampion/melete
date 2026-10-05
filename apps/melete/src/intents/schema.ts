/**
 * What the person wants done, kept past the conversation it was said in.
 *
 * `intent` is the person's view of a piece of work: their words, Melete's
 * reading of them, the details with where each came from, the deadline, and
 * where it stands. The run that does the work is named by `run_id`; neither
 * depends on the chat transcript, so deleting the chat leaves both.
 *
 * `intent_effect` lists what the intent's work changed outside Melete, in the
 * order it happened, so that cancelling can take it back newest first.
 */
import { sql } from 'drizzle-orm';
import {
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
import { action, job, principal, space } from '../db/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const intent = pgTable(
  'intent',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    /** The one person it is for: whoever said it, or took it up. */
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** `chat`, `commitment` or `chase`. */
    source: text('source').notNull(),
    /**
     * What it was made from, so the same thing is never kept twice: a message
     * and its reading (`message:<seq>:<hash>`), `ledger:<id>` or `awaited:<id>`.
     */
    sourceKey: text('source_key').notNull(),
    /** The conversation it was said in. Deleting the chat leaves the intent. */
    conversationId: text('conversation_id').references(() => job.id, { onDelete: 'set null' }),
    /** The work that carries it out. */
    runId: text('run_id').references(() => job.id, { onDelete: 'set null' }),
    /** The person's own words, verbatim, read by the service from their message. */
    words: text('words').notNull().default(''),
    /** Melete's one-line reading. */
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    /** Typed details from the closed vocabulary. */
    constraints: jsonb('constraints').$type<Record<string, unknown>>().notNull().default({}),
    /** Where each detail came from, by path: `person` or `inferred`. Written by the service only. */
    origins: jsonb('origins').$type<Record<string, string>>().notNull().default({}),
    /** How "done" is told: `{ done_when }`. */
    success: jsonb('success').$type<Record<string, unknown>>().notNull().default({}),
    /** `active`, `waiting`, `at_risk`, `done`, `failed`, `cancelled` or `expired`. */
    state: text('state').notNull().default('active'),
    /** Who or what it waits on, while it waits. */
    waitingOn: jsonb('waiting_on').$type<Record<string, unknown> | null>(),
    /** When it has to be done by: a moment, or the end of the working day for a day alone. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    /** The deadline was given as a day alone (`YYYY-MM-DD`). */
    deadlineDay: text('deadline_day'),
    /** Where the deadline came from. Only `person` lets it reach them at any hour. */
    deadlineOrigin: text('deadline_origin'),
    /** What its clocks and situations are about: `intent:<id>`, or what it was taken up from. */
    subjectKey: text('subject_key').notNull(),
    /** Each change the person makes is a new version. */
    version: integer('version').notNull().default(1),
    closedReason: text('closed_reason'),
    createdAt: created(),
    updatedAt: updated(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('intent_source_idx').on(t.spaceId, t.principalId, t.sourceKey),
    index('intent_principal_idx').on(t.principalId, t.state, t.createdAt),
    index('intent_run_idx').on(t.runId),
    index('intent_conversation_idx').on(t.conversationId),
    index('intent_subject_idx').on(t.subjectKey),
    check(
      'intent_state',
      sql`${t.state} in ('active', 'waiting', 'at_risk', 'done', 'failed', 'cancelled', 'expired')`,
    ),
    check(
      'intent_kind',
      sql`${t.kind} in ('meeting', 'booking', 'purchase', 'reply', 'deliver', 'remind_check', 'watch', 'other')`,
    ),
    check('intent_source', sql`${t.source} in ('chat', 'commitment', 'chase')`),
    check(
      'intent_deadline_origin',
      sql`${t.deadlineOrigin} is null or ${t.deadlineOrigin} in ('person', 'inferred')`,
    ),
    check('intent_title_not_empty', sql`length(${t.title}) > 0`),
    check('intent_version', sql`${t.version} >= 1`),
  ],
);

export const intentEffect = pgTable(
  'intent_effect',
  {
    intentId: text('intent_id')
      .notNull()
      .references(() => intent.id, { onDelete: 'cascade' }),
    actionId: text('action_id')
      .notNull()
      .references(() => action.id, { onDelete: 'cascade' }),
    /** `primary` (what was asked), `hold` (kept while deciding), `compensation` (an undo of its own). */
    role: text('role').notNull().default('primary'),
    /** How it is taken back, as its kind declares, when it can be. */
    reversal: jsonb('reversal').$type<Record<string, unknown> | null>(),
    /** `done`, `reversed`, `kept` (left as it is on cancel) or `failed` (taking it back failed). */
    state: text('state').notNull().default('done'),
    note: text('note'),
    /** When the change happened: the order cancelling reverses. */
    doneAt: timestamp('done_at', { withTimezone: true }).notNull(),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.intentId, t.actionId] }),
    index('intent_effect_action_idx').on(t.actionId),
    check('intent_effect_role', sql`${t.role} in ('primary', 'hold', 'compensation')`),
    check('intent_effect_state', sql`${t.state} in ('done', 'reversed', 'kept', 'failed')`),
  ],
);
