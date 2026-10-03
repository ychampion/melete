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
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';
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

/** What an inbox scan reads out of mail. */
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
/**
 * What a connection adds to the ledger: a `matter` is something open between
 * the person and someone else, with a state and a next step; a `commitment` is
 * something owed one way or the other by a date. A scan never produces either.
 */
export const PUBLISHED_ITEM_KINDS = ['matter', 'commitment'] as const;
export const ledgerItemKind = z.enum([...LEDGER_ITEM_KINDS, ...PUBLISHED_ITEM_KINDS]);
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

// --------------------------------------------------------------------------
// items a connection publishes
// --------------------------------------------------------------------------

/** A connection's own name for an item or a source: a ticket number, a thread id. */
export const ledgerSourceRef = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@#/-]*$/, 'letters, digits and . _ : @ # / -');

/** Someone on a matter, as the connection names them. */
export const ledgerParty = z.strictObject({
  name: z.string().min(1).max(200),
  /** Their part in it, in the connection's words: "client", "reviewer". */
  role: z.string().min(1).max(60).nullable().default(null),
});
export type LedgerParty = z.infer<typeof ledgerParty>;

/**
 * A next step an item offers. `tool` is the installation's alias for one of
 * the connection's own tools, and only an alias the installation declared as a
 * ledger action survives admission; `input` is what that tool is asked with.
 */
export const ledgerItemAction = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters, digits, - and _'),
  label: z.string().min(1).max(80),
  tool: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(80),
  input: jsonObject.default({}),
});
export type LedgerItemAction = z.infer<typeof ledgerItemAction>;

/**
 * Where an item came from when a connection published it rather than a scan
 * finding it. Present only on published items; the rest of the item is read
 * the same way as one a scan found.
 */
export const ledgerItemSource = z.strictObject({
  connection_id: prefixedId(ID_PREFIXES.connection),
  /** The connection's label when it last published the item. */
  label: z.string().min(1).max(200),
  ref: ledgerSourceRef,
  /** Where the matter stands, in the connection's own word: "open", "with the client". */
  state: z.string().min(1).max(60),
  next_step: z.string().min(1).max(300).nullable(),
  parties: z.array(ledgerParty).max(20),
  actions: z.array(ledgerItemAction).max(8),
  /** When the connection last published it. */
  published_at: timestamp,
});
export type LedgerItemSource = z.infer<typeof ledgerItemSource>;

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
  /** Present when a connection published the item; absent when a scan found it. */
  source: ledgerItemSource.optional(),
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

// --------------------------------------------------------------------------
// what a connection's ledger feed returns
// --------------------------------------------------------------------------

/**
 * The text an item's evidence is checked against: a message, a ticket comment,
 * a note. It travels with the items that quote it, and the service keeps it,
 * so a person can open a published item back to its sentence the same way as
 * one a scan found.
 */
export const ledgerFeedSource = z.strictObject({
  ref: ledgerSourceRef,
  title: z.string().max(300).default(''),
  /** Who wrote it, as the connection shows it. */
  from: z.string().max(320).default(''),
  at: timestamp.optional(),
  text: z.string().min(1).max(20_000),
});
export type LedgerFeedSource = z.infer<typeof ledgerFeedSource>;

/** One quote, naming the source it sits in by that source's `ref`. */
export const ledgerFeedEvidence = z.strictObject({
  source: ledgerSourceRef,
  quote: z.string().min(1).max(2000),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

/**
 * One tracked item as a connection publishes it. `ref` is the connection's
 * own id for it, so publishing the same `ref` again updates the item rather
 * than adding a second one. `closed` is how a connection says the matter is
 * over; an item left out of a later feed is not taken to be closed.
 */
export const ledgerFeedItem = z
  .strictObject({
    ref: ledgerSourceRef,
    kind: z.enum(PUBLISHED_ITEM_KINDS),
    direction: z.enum(['owed_to_you', 'you_owe', 'info']),
    summary: z.string().min(1).max(500),
    /** Who the item is with. Its domain groups it with what else the person has from them. */
    counterparty: z.strictObject({
      name: z.string().min(1).max(200),
      domain: z
        .string()
        .min(1)
        .max(253)
        .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/),
    }),
    parties: z.array(ledgerParty).max(20).default([]),
    state: z.string().min(1).max(60),
    next_step: z.string().min(1).max(300).nullable().default(null),
    due_at: timestamp.nullable().default(null),
    due_date_only: z.boolean().optional(),
    amount_minor: minorAmount.nullable().default(null),
    currency: currencyCode.nullable().default(null),
    closed: z.boolean().default(false),
    evidence: z.array(ledgerFeedEvidence).min(1).max(8),
    actions: z.array(ledgerItemAction).max(8).default([]),
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'commitment' && item.direction === 'info')
      ctx.addIssue({
        code: 'custom',
        path: ['direction'],
        message: 'A commitment is owed one way or the other',
      });
    if ((item.amount_minor === null) !== (item.currency === null))
      ctx.addIssue({
        code: 'custom',
        path: ['currency'],
        message: 'An amount and its currency come together',
      });
    if (new Set(item.actions.map((action) => action.id)).size !== item.actions.length)
      ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Each action id is used once' });
  });
export type LedgerFeedItem = z.infer<typeof ledgerFeedItem>;

/**
 * A feed page. Items are checked one at a time, so the outer shape leaves them
 * unparsed: one malformed item is dropped and counted, and the rest stand.
 */
export const ledgerFeed = z.object({
  sources: z.array(ledgerFeedSource).max(200).default([]),
  items: z.array(z.unknown()).max(200),
});
export type LedgerFeed = z.infer<typeof ledgerFeed>;

/** What one read of a connection's feed did. */
export const ledgerSyncResult = z.strictObject({
  connection_id: prefixedId(ID_PREFIXES.connection),
  /** Items the feed returned. */
  items_seen: z.number().int().nonnegative(),
  /** Items added or changed by this read. */
  items_written: z.number().int().nonnegative(),
  /** Items, and actions on items, left out, by reason. */
  dropped: z.record(z.string(), z.number().int().nonnegative()),
});
export type LedgerSyncResult = z.infer<typeof ledgerSyncResult>;

/** Which of an item's actions to take. Left out, its first. */
export const ledgerHandleRequest = z.strictObject({
  action: ledgerItemAction.shape.id.optional(),
});
export type LedgerHandleRequest = z.infer<typeof ledgerHandleRequest>;
