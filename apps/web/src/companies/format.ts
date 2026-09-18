/**
 * Money, dates and plain words for the ledger. Everything here is a pure
 * function of the contract's own fields, so what a person reads on a row can
 * always be traced back to what the service served.
 */
import type { CompanyMap, LedgerDirection, LedgerItem, LedgerItemKind } from './types.ts';

const DAY = 86_400_000;

/**
 * Whole minor units to what a person would write. A figure that lands on a
 * whole unit loses its ".00", because £2,476 is the number and £2,476.00 is
 * the invoice.
 */
export function money(minor: number, currency: string): string {
  const whole = minor % 100 === 0;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(whole ? 0 : 2)} ${currency}`;
  }
}

/** The day itself: "12 Sep". */
export const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** The day and the time, for a message header. */
export const messageDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

/** How far away a date is, in the words a person would use. */
export function whenDue(iso: string, now = Date.now()): string {
  const days = Math.round((Date.parse(iso) - now) / DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days > 0) return `in ${days} days`;
  return `${-days} days ago`;
}

export const isOverdue = (item: LedgerItem, now = Date.now()): boolean =>
  item.due_at !== null &&
  Date.parse(item.due_at) < now &&
  item.status !== 'settled' &&
  item.status !== 'dropped';

/** What a row is, in the person's words. Never the contract's enum. */
export const KIND_WORDS: Record<LedgerItemKind, string> = {
  refund_owed: 'Refund owed',
  wrong_charge: 'Wrong charge',
  subscription: 'Subscription',
  price_rise: 'Price rise',
  renewal: 'Renewal',
  trial_ending: 'Trial ending',
  invoice_unpaid: 'Invoice unpaid',
  compensation: 'Compensation',
  warranty: 'Warranty',
  deposit: 'Deposit',
  data_held: 'Holding your data',
  promise: 'What they promised',
};

export const STATUS_WORDS: Record<LedgerItem['status'], string> = {
  found: 'Found',
  handling: 'Handling it',
  waiting: 'Waiting on them',
  settled: 'Settled',
  dropped: 'Not this',
};

/** Which way the money moves, said out loud rather than with a sign. */
export function amountWords(item: LedgerItem): { figure: string; direction: string } | null {
  if (item.amount_minor === null || item.currency === null) return null;
  const figure = money(item.amount_minor, item.currency);
  const direction: Record<LedgerDirection, string> = {
    owed_to_you: 'owed to you',
    you_pay: 'you pay',
    you_owe: 'you owe',
    info: '',
  };
  return { figure, direction: direction[item.direction] };
}

/* ---------- filtering ---------- */

/** Which total is pressed. `null` is the whole ledger. */
export type Filter =
  | null
  | { kind: 'direction'; value: LedgerDirection }
  | { kind: 'item'; value: LedgerItemKind }
  /** Renewals inside a window, which is what the "renews in 30 days" figure counts. */
  | { kind: 'renewing'; days: number }
  | { kind: 'promise'; lapsed: boolean }
  | { kind: 'company'; value: string };

/**
 * Still in play. Every figure at the top of the map counts these and no others,
 * so every filter derived from a figure has to agree — otherwise a person
 * presses "3 price rises" and is shown four rows.
 */
export const isLive = (item: LedgerItem): boolean =>
  item.status !== 'settled' && item.status !== 'dropped';

export function matches(item: LedgerItem, filter: Filter, now = Date.now()): boolean {
  if (filter === null) return true;
  // A company is a place, not a figure: asking for one shows everything it has,
  // settled rows included.
  if (filter.kind === 'company') return item.company_id === filter.value;
  if (!isLive(item)) return false;
  switch (filter.kind) {
    case 'direction':
      return item.direction === filter.value;
    case 'item':
      return item.kind === filter.value;
    case 'renewing':
      return (
        item.kind === 'renewal' &&
        item.due_at !== null &&
        Date.parse(item.due_at) <= now + filter.days * 86_400_000
      );
    case 'promise':
      if (item.kind !== 'promise') return false;
      return filter.lapsed
        ? item.due_at !== null && Date.parse(item.due_at) < now
        : item.due_at === null || Date.parse(item.due_at) >= now;
  }
}

export const sameFilter = (a: Filter, b: Filter): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The ledger in reading order: what needs doing first. Overdue money before
 * anything dated, dated before undated, and a settled or dropped row last.
 */
export function inOrder(items: LedgerItem[], now = Date.now()): LedgerItem[] {
  const rank = (item: LedgerItem): number => {
    if (item.status === 'settled' || item.status === 'dropped') return 4;
    if (isOverdue(item, now)) return 0;
    if (item.due_at !== null) return 1;
    if (item.direction === 'owed_to_you') return 2;
    return 3;
  };
  return [...items].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a.due_at && b.due_at) return Date.parse(a.due_at) - Date.parse(b.due_at);
    if (a.due_at) return -1;
    if (b.due_at) return 1;
    return (b.amount_minor ?? 0) - (a.amount_minor ?? 0);
  });
}

/** The rows under each company, companies with the most at stake first. */
export function byCompany(
  map: Pick<CompanyMap, 'companies'>,
  items: LedgerItem[],
  now = Date.now(),
): { company: CompanyMap['companies'][number]; items: LedgerItem[] }[] {
  const groups = map.companies
    .map((company) => ({
      company,
      items: inOrder(
        items.filter((item) => item.company_id === company.id),
        now,
      ),
    }))
    .filter((group) => group.items.length > 0);
  const weight = (rows: LedgerItem[]) =>
    rows.reduce(
      (sum, item) => sum + (item.direction === 'owed_to_you' ? (item.amount_minor ?? 0) : 0),
      0,
    );
  return groups.sort((a, b) => {
    const byOwed = weight(b.items) - weight(a.items);
    return byOwed !== 0 ? byOwed : a.company.name.localeCompare(b.company.name);
  });
}
