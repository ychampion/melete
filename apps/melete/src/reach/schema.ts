/**
 * Reaching a person on their own phone.
 *
 * `reach_number` is the one number a person proved is theirs, with a code
 * texted to it. A new number waits beside it until its own code is entered;
 * only the verified one is ever texted or called about a deadline.
 *
 * `reach_consent` records each agreement as it was given: when, to which
 * number, what it covered (texts, calls, nights) and the exact words shown.
 * A row is never changed except to say when and how it was withdrawn, so the
 * record of what the person agreed to stays as it was.
 *
 * `reach_contact` is every push, text and call Melete made, or chose not to
 * make, to reach the person, with the reason, the provider's id, what the
 * provider reported back, and what it cost.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { principal } from '../db/schema.ts';
import { situation } from '../situations/schema.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const reachNumber = pgTable(
  'reach_number',
  {
    principalId: text('principal_id')
      .primaryKey()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** The number the person proved is theirs. */
    number: text('number'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** A number waiting for its code. */
    pendingNumber: text('pending_number'),
    /** SHA-256 of the code with the person's id; the code itself is never kept. */
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    /** Wrong codes entered against the pending number. */
    codeTries: integer('code_tries').notNull().default(0),
    /** The person replied STOP (or the provider says they did). Cleared only by START. */
    optedOutAt: timestamp('opted_out_at', { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    // One person per number: a reply from it has one owner.
    uniqueIndex('reach_number_number_idx').on(t.number).where(sql`${t.number} is not null`),
    check('reach_number_verified', sql`(${t.number} is null) = (${t.verifiedAt} is null)`),
  ],
);

export const reachConsent = pgTable(
  'reach_consent',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** The verified number it was given for. It covers no other. */
    number: text('number').notNull(),
    texts: boolean('texts').notNull(),
    calls: boolean('calls').notNull(),
    nights: boolean('nights').notNull(),
    /** The words the person agreed to, exactly as shown. */
    wording: text('wording').notNull(),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    /** `settings`, `stop` (a reply), `keypress` (on a call), `number` (a new number), `forgotten`. */
    withdrawnHow: text('withdrawn_how'),
  },
  (t) => [
    uniqueIndex('reach_consent_live_idx').on(t.principalId).where(sql`${t.withdrawnAt} is null`),
    check('reach_consent_withdrawn', sql`(${t.withdrawnAt} is null) = (${t.withdrawnHow} is null)`),
  ],
);

export const reachContact = pgTable(
  'reach_contact',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    /** The deadline it was about, for a rung of the ladder. */
    situationId: text('situation_id').references(() => situation.id, { onDelete: 'cascade' }),
    /** `ladder` or `code`. */
    purpose: text('purpose').notNull(),
    /** `push`, `text` or `call`. */
    channel: text('channel').notNull(),
    /** When this rung comes due. */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** `waiting`, `sending`, `sent`, `delivered`, `failed`, `skipped`, `cancelled` or `unknown`. */
    state: text('state').notNull(),
    /** Why it was made, or why not, in plain words. */
    reason: text('reason').notNull(),
    /** The number it went to: always the verified one, or the pending one for a code. */
    number: text('number'),
    /** The provider's id for the message or call. */
    providerRef: text('provider_ref'),
    /** What the provider last reported: `queued`, `delivered`, `completed`, `no-answer`... */
    providerStatus: text('provider_status'),
    /** What it cost, counted toward the person's spend. */
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('reach_contact_rung_idx')
      .on(t.situationId, t.channel)
      .where(sql`${t.situationId} is not null`),
    index('reach_contact_principal_idx').on(t.principalId, t.createdAt),
    index('reach_contact_due_idx').on(t.dueAt).where(sql`${t.state} = 'waiting'`),
    index('reach_contact_ref_idx').on(t.providerRef),
    check('reach_contact_channel', sql`${t.channel} in ('push', 'text', 'call')`),
    check('reach_contact_purpose', sql`${t.purpose} in ('ladder', 'code')`),
    check(
      'reach_contact_state',
      sql`${t.state} in ('waiting', 'sending', 'sent', 'delivered', 'failed', 'skipped', 'cancelled', 'unknown')`,
    ),
    check(
      'reach_contact_ladder_situation',
      sql`${t.purpose} <> 'ladder' or ${t.situationId} is not null`,
    ),
  ],
);
