/**
 * The companies contract, typed here by hand.
 *
 * Every other shape this application draws comes from the generated client
 * (`packages/client/src/schema.d.ts`), because the experience contract
 * describes it. The companies paths are agreed but not yet in openapi.json, so
 * these follow the agreement — snake_case fields, `co_`/`li_` ids, optionals
 * present and null — until the schema carries them.
 *
 * INTEGRATOR: when `/spaces/{spaceId}/companies` reaches openapi.json, delete
 * this file and derive the same names in `experience/types.ts` the way the rest
 * of the screens do. `companies/api.ts` is the only other file to change.
 */

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
export type LedgerItemKind = (typeof LEDGER_ITEM_KINDS)[number];

export type LedgerDirection = 'owed_to_you' | 'you_pay' | 'you_owe' | 'info';
export type LedgerItemStatus = 'found' | 'handling' | 'waiting' | 'settled' | 'dropped';
export type Confidence = 'high' | 'medium' | 'low';

export type Company = {
  id: string;
  space_id: string;
  name: string;
  domain: string;
  monthly_spend_minor: number | null;
  currency: string | null;
  first_seen_at: string;
  last_seen_at: string;
  message_count: number;
};

/** One sentence from one stored message, and the span it sits at. */
export type LedgerEvidence = {
  message_id: string;
  quote: string;
  start: number;
  end: number;
};

export type LedgerItem = {
  id: string;
  space_id: string;
  principal_id: string;
  company_id: string;
  kind: LedgerItemKind;
  direction: LedgerDirection;
  amount_minor: number | null;
  currency: string | null;
  due_at: string | null;
  status: LedgerItemStatus;
  confidence: Confidence;
  evidence: LedgerEvidence[];
  suggested_playbook: string | null;
  job_id: string | null;
  summary: string;
};

/**
 * The figures at the top of the map. The promise counts are optional: a service
 * that does not read promises yet serves the six, and those two cells are not
 * drawn rather than drawn as zero.
 */
export type CompanyMapTotals = {
  owed_to_you_minor: number;
  monthly_spend_minor: number;
  renewals_next_30d: number;
  price_rises: number;
  trials_ending: number;
  data_holders: number;
  promises_in_force?: number;
  promises_lapsed?: number;
};

export type CompanyMap = {
  companies: Company[];
  items: LedgerItem[];
  totals: CompanyMapTotals;
  currency: string;
};

/** The stored message a figure was read out of. The spans index into `text`. */
export type LedgerMessage = {
  id: string;
  subject: string;
  from: string;
  received_at: string;
  text: string;
};

export type LedgerDetail = {
  item: LedgerItem;
  company: Company;
  message: LedgerMessage;
};

export type ScanStarted = { scan_id: string; status: 'running' };

export type ScanProgress = {
  status: 'running' | 'done' | 'failed';
  messages_seen: number;
  items_found: number;
  error?: string | null;
};
