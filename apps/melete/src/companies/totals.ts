/**
 * The six figures at the top of the map, and the two counts promises add.
 *
 * They are computed from admitted items only, by adding integers. No model is
 * consulted and no figure is carried over from the extraction, so the number a
 * person reads is the sum of the sentences they can open — which is the whole
 * claim the map makes.
 */

import type { CompanyMapTotals, LedgerItem } from '@melete/contracts';

/** Items in another currency are left out of the money totals, never converted. */
export const DEFAULT_CURRENCY = 'GBP';

const OPEN_STATUSES = new Set(['found', 'handling', 'waiting']);

/**
 * Promises in force and promises that lapsed. The shared contract's totals do
 * not carry these, so they live beside them rather than inside them: adding a
 * field to the contract would change a shape three lanes build against.
 */
export type PromiseTotals = {
  promises_in_force: number;
  promises_lapsed: number;
};

export type CompanyTotals = CompanyMapTotals & PromiseTotals;

export const RENEWAL_WINDOW_DAYS = 30;

/**
 * Add up one space's ledger. `now` decides which renewals are near and which
 * promises have run out, and it is passed in rather than read from the clock so
 * the same ledger totals the same way twice.
 */
export function computeTotals(
  items: readonly LedgerItem[],
  options: { now: Date; currency?: string },
): CompanyTotals {
  const currency = options.currency ?? DEFAULT_CURRENCY;
  const horizon = options.now.getTime() + RENEWAL_WINDOW_DAYS * 86_400_000;
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
    const soon = Number.isFinite(due) && due >= options.now.getTime() && due <= horizon;
    if (soon && (item.kind === 'renewal' || item.kind === 'subscription'))
      totals.renewals_next_30d++;
    if (item.kind === 'price_rise') totals.price_rises++;
    if (item.kind === 'trial_ending') totals.trials_ending++;
    if (item.kind === 'data_held') dataHolders.add(item.company_id);
    if (item.kind === 'promise') {
      if (Number.isFinite(due) && due < options.now.getTime()) totals.promises_lapsed++;
      else totals.promises_in_force++;
    }
  }
  totals.data_holders = dataHolders.size;
  return totals;
}

/** The contract's own six, for the shape `CompanyMap.totals` names. */
export function contractTotals(totals: CompanyTotals): CompanyMapTotals {
  const { promises_in_force: _inForce, promises_lapsed: _lapsed, ...rest } = totals;
  return rest;
}
