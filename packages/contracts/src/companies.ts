/**
 * The map of every company in a person's life: what each one costs, what each
 * one owes, what renews next, and the exact sentence every figure came from.
 *
 * The evidence rule is the point of this file. A ledger item is a claim about
 * money or a deadline read out of email text, which is untrusted input; the call
 * that reads it has no tools and returns this schema and nothing else. Nothing
 * that call says is believed on its own. Every item carries the span it read,
 * and `evidenceHolds` re-derives that span from the stored message before the
 * item may be shown. An item whose quote is not exactly the text at its own span
 * is dropped rather than shown with a caveat: a figure a person cannot open back
 * to the sentence it came from is worse than no figure at all.
 *
 * Span correctness is deliberately not a parse rule. The schema accepts any pair
 * of offsets and `evidenceHolds` is the single place that judges them, so one
 * bad item is dropped on its own instead of failing the whole extraction.
 */
import { z } from 'zod';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import { confidence } from './knowledge.ts';

/**
 * Money is whole minor units — cents, pence, paise — so that adding a column of
 * figures is exact integer arithmetic and never a float. `direction` carries
 * which way the money moves, so an amount itself is never negative.
 */
export const minorAmount = z.number().int().nonnegative();

/** ISO-4217, for example `GBP`. An amount without one does not name a quantity. */
export const currencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be an ISO-4217 currency code, for example GBP');

// --------------------------------------------------------------------------
// company
// --------------------------------------------------------------------------

export const company = z.strictObject({
  id: prefixedId(ID_PREFIXES.company),
  space_id: prefixedId(ID_PREFIXES.space),
  /** What the person would call them, not the legal entity on the invoice. */
  name: z.string().min(1).max(200),
  /** Lowercase, as it appeared in the messages: `acme.com`. */
  domain: z.string().min(1).max(253),
  monthly_spend_minor: minorAmount.nullable().default(null),
  currency: currencyCode.nullable().default(null),
  first_seen_at: timestamp,
  last_seen_at: timestamp,
  message_count: z.number().int().nonnegative(),
});
export type Company = z.infer<typeof company>;

// --------------------------------------------------------------------------
// ledger item
// --------------------------------------------------------------------------

export const LEDGER_ITEM_KINDS = [
  'refund_owed',
  'wrong_charge',
  'subscription',
  'price_rise',
  'renewal',
  'trial_ending',
  'invoice_unpaid',
  'compensation',
  'warranty',
  'deposit',
  'data_held',
  'promise',
] as const;
export const ledgerItemKind = z.enum(LEDGER_ITEM_KINDS);
export type LedgerItemKind = z.infer<typeof ledgerItemKind>;

/** Which way the money moves. `info` is for items that are not about money at all. */
export const LEDGER_DIRECTIONS = ['owed_to_you', 'you_pay', 'you_owe', 'info'] as const;
export const ledgerDirection = z.enum(LEDGER_DIRECTIONS);
export type LedgerDirection = z.infer<typeof ledgerDirection>;

/** `found` until a person picks it up; `settled` and `dropped` are both endings. */
export const LEDGER_ITEM_STATUSES = ['found', 'handling', 'waiting', 'settled', 'dropped'] as const;
export const ledgerItemStatus = z.enum(LEDGER_ITEM_STATUSES);
export type LedgerItemStatus = z.infer<typeof ledgerItemStatus>;

/**
 * A playbook name, in the same kebab-case as a skill name. The list of playbooks
 * belongs to the code that runs them, so this is a shape rather than an enum and
 * adding a playbook does not change the shared contract.
 */
export const playbookId = z
  .string()
  .max(60)
  .regex(/^[a-z][a-z0-9-]*$/, 'lowercase kebab-case');
export type PlaybookId = z.infer<typeof playbookId>;

/** The playbooks the first release ships with. */
export const LAUNCH_PLAYBOOKS = [
  'refund-owed',
  'wrong-charge',
  'cancel-subscription',
  'price-rise',
  'get-quotes',
  'unpaid-invoice',
] as const;
export type LaunchPlaybook = (typeof LAUNCH_PLAYBOOKS)[number];

/**
 * One sentence from one stored message, and the span it sits at. `start` is
 * inclusive, `end` exclusive, both counted in the UTF-16 code units that
 * `String.prototype.slice` counts, so checking the span again is the same
 * arithmetic that produced it.
 */
export const ledgerEvidence = z.strictObject({
  /** The message as the store knows it, for example an RFC 5322 Message-ID. */
  message_id: z.string().min(1).max(998),
  quote: z.string().min(1).max(2000),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type LedgerEvidence = z.infer<typeof ledgerEvidence>;

export const ledgerItem = z.strictObject({
  id: prefixedId(ID_PREFIXES.ledger_item),
  space_id: prefixedId(ID_PREFIXES.space),
  principal_id: prefixedId(ID_PREFIXES.owner),
  company_id: prefixedId(ID_PREFIXES.company),
  kind: ledgerItemKind,
  direction: ledgerDirection,
  amount_minor: minorAmount.nullable().default(null),
  currency: currencyCode.nullable().default(null),
  due_at: timestamp.nullable().default(null),
  /**
   * The email gave a day and no time, so `due_at` is that day's midnight UTC and
   * the day is read in the person's own time zone. Absent means false.
   */
  due_date_only: z.boolean().optional(),
  status: ledgerItemStatus,
  confidence,
  /** At least one. An item with nothing to check is an item nobody can open. */
  evidence: z.array(ledgerEvidence).min(1).max(8),
  suggested_playbook: playbookId.nullable().default(null),
  /** The job handling it, once a person has said to go ahead. */
  job_id: prefixedId(ID_PREFIXES.job).nullable().default(null),
  /** One line in the person's own words: "Refund for the cancelled order". */
  summary: z.string().min(1).max(500),
});
export type LedgerItem = z.infer<typeof ledgerItem>;

// --------------------------------------------------------------------------
// the map
// --------------------------------------------------------------------------

/**
 * The figures at the top of the map. Each one is a sum or a count over admitted
 * items, so every one of them is the total of things a person can open and read.
 *
 * The promise counts are here rather than beside them because a promise is a
 * first-class ledger item: a company's own commitment with a date on it. In
 * force means the date has not passed; lapsed means it has, and a lapsed
 * promise is the most useful thing on the map, because it is the one a person
 * can hold a company to in the company's own words.
 */
export const companyMapTotals = z.strictObject({
  owed_to_you_minor: minorAmount,
  monthly_spend_minor: minorAmount,
  renewals_next_30d: z.number().int().nonnegative(),
  price_rises: z.number().int().nonnegative(),
  trials_ending: z.number().int().nonnegative(),
  data_holders: z.number().int().nonnegative(),
  promises_in_force: z.number().int().nonnegative(),
  promises_lapsed: z.number().int().nonnegative(),
});
export type CompanyMapTotals = z.infer<typeof companyMapTotals>;

export const companyMap = z.strictObject({
  companies: z.array(company),
  items: z.array(ledgerItem),
  totals: companyMapTotals,
  /** The currency the totals are in. Items in another currency are left out of them. */
  currency: currencyCode,
});
export type CompanyMap = z.infer<typeof companyMap>;

// --------------------------------------------------------------------------
// the admission gate
// --------------------------------------------------------------------------

/**
 * Does this evidence say what it claims to say? True only when the quote is a
 * non-empty run of characters sitting at exactly `[start, end)` in the message it
 * cites.
 *
 * Both halves of that matter. A slice comparison on its own would accept a span
 * of the wrong length; a substring search on its own would accept a real
 * sentence carrying a span that opens some other sentence, and the person who
 * clicked the figure would be shown the wrong words. Because `start` may not be
 * negative and the slice must equal the quote, anything this function admits is
 * necessarily a substring of the message — the substring property is a
 * consequence of the span check, not a second, looser test beside it.
 */
export function evidenceHolds(
  messageText: string,
  evidence: Pick<LedgerEvidence, 'quote' | 'start' | 'end'>,
): boolean {
  const { quote, start, end } = evidence;
  if (quote.length === 0) return false;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  if (start < 0 || end > messageText.length) return false;
  if (end - start !== quote.length) return false;
  return messageText.slice(start, end) === quote;
}
