/**
 * The figures at the top of the map.
 *
 * They are computed from admitted items only, by adding integers. No model is
 * consulted and no figure is carried over from the extraction, so the number a
 * person reads is the sum of the sentences they can open — which is the whole
 * claim the map makes.
 *
 * The promise counts used to live beside the contract's totals because the
 * contract did not carry them. It does now, so there is one shape again and
 * nothing has to be stripped at the boundary.
 */

import type { CompanyMapTotals, LedgerItem } from '@melete/contracts';
import { calendarDay } from '../dates.ts';

/** Items in another currency are left out of the money totals, never converted. */
export const DEFAULT_CURRENCY = 'GBP';

/**
 * An item still in play. A promise being handled is still a promise in force —
 * more so, if anything — so `handling` and `waiting` count alongside `found`.
 */
const OPEN_STATUSES = new Set(['found', 'handling', 'waiting']);

export type CompanyTotals = CompanyMapTotals;

export const RENEWAL_WINDOW_DAYS = 30;

/**
 * A due date the email gave without a time is admitted as midnight UTC. It
 * names a whole day, and the day it names is the person's own: a promise "by
 * 25 September" is kept while it is still the 25th where they live.
 */
const DATE_ONLY = /T00:00:00(?:\.000)?Z$/;

function zoneOrUtc(timeZone: string | undefined): string {
  try {
    if (timeZone) new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Add up one space's ledger. `now` decides which renewals are near and which
 * promises have run out, and it is passed in rather than read from the clock so
 * the same ledger totals the same way twice.
 */
export function computeTotals(
  items: readonly LedgerItem[],
  options: { now: Date; currency?: string; timeZone?: string },
): CompanyTotals {
  const currency = options.currency ?? DEFAULT_CURRENCY;
  const horizon = options.now.getTime() + RENEWAL_WINDOW_DAYS * 86_400_000;
  const timeZone = zoneOrUtc(options.timeZone);
  const today = calendarDay(options.now, timeZone);
  const lastDay = calendarDay(new Date(horizon), timeZone);
  const totals: CompanyTotals = {
    owed_to_you_minor: 0,
    monthly_spend_minor: 0,
    renewals_next_30d: 0,
    price_rises: 0,
    trials_ending: 0,
    data_holders: 0,
    promises_in_force: 0,
    promises_lapsed: 0,
  };
  const dataHolders = new Set<string>();
  for (const item of items) {
    if (!OPEN_STATUSES.has(item.status)) continue;
    const money = item.currency === currency ? (item.amount_minor ?? 0) : 0;
    if (item.direction === 'owed_to_you') totals.owed_to_you_minor += money;
    // Monthly spend is what the standing charges come to, so only subscriptions
    // count. An annual licence and a one-off balance are money the studio pays,
    // but adding either to a figure labelled "a month" would overstate it.
    if (item.direction === 'you_pay' && item.kind === 'subscription')
      totals.monthly_spend_minor += money;
    const due = item.due_at ? Date.parse(item.due_at) : Number.NaN;
    const day = item.due_at && DATE_ONLY.test(item.due_at) ? item.due_at.slice(0, 10) : null;
    const soon = day
      ? day >= today && day <= lastDay
      : Number.isFinite(due) && due >= options.now.getTime() && due <= horizon;
    const lapsed = day ? day < today : Number.isFinite(due) && due < options.now.getTime();
    if (soon && (item.kind === 'renewal' || item.kind === 'subscription'))
      totals.renewals_next_30d++;
    if (item.kind === 'price_rise') totals.price_rises++;
    if (item.kind === 'trial_ending') totals.trials_ending++;
    if (item.kind === 'data_held') dataHolders.add(item.company_id);
    if (item.kind === 'promise') {
      if (lapsed) totals.promises_lapsed++;
      else totals.promises_in_force++;
    }
  }
  totals.data_holders = dataHolders.size;
  return totals;
}
