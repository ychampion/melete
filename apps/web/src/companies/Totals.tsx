/**
 * The head of the map: what every company in your life adds up to.
 *
 * Each figure is a control, not a caption. Pressing one filters the ledger
 * under it to the rows that figure was counted from, and pressing it again
 * puts the whole ledger back — which is why the counted figures and the shown
 * rows can never disagree.
 */
import type { Filter } from './format.ts';
import { money, sameFilter } from './format.ts';
import type { CompanyMapTotals } from './types.ts';

export type Total = {
  key: string;
  label: string;
  figure: string;
  /** What pressing this figure shows. A figure nothing can be filtered to is not a button. */
  filter: Filter;
  /** Money owed to the person is the one figure that carries a colour. */
  tone?: 'owed';
};

export function totalsOf(totals: CompanyMapTotals, companies: number, currency: string): Total[] {
  const rows: Total[] = [
    {
      key: 'companies',
      label: companies === 1 ? 'Company found' : 'Companies found',
      figure: String(companies),
      filter: null,
    },
    {
      key: 'spend',
      label: 'You pay a month',
      figure: money(totals.monthly_spend_minor, currency),
      filter: { kind: 'direction', value: 'you_pay' },
    },
    {
      key: 'owed',
      label: 'Owed to you',
      figure: money(totals.owed_to_you_minor, currency),
      filter: { kind: 'direction', value: 'owed_to_you' },
      tone: 'owed',
    },
    {
      key: 'renewals',
      label: 'Renews in 30 days',
      figure: String(totals.renewals_next_30d),
      filter: { kind: 'item', value: 'renewal' },
    },
    {
      key: 'rises',
      label: totals.price_rises === 1 ? 'Price rise' : 'Price rises',
      figure: String(totals.price_rises),
      filter: { kind: 'item', value: 'price_rise' },
    },
    {
      key: 'trials',
      label: totals.trials_ending === 1 ? 'Trial ending' : 'Trials ending',
      figure: String(totals.trials_ending),
      filter: { kind: 'item', value: 'trial_ending' },
    },
    {
      key: 'data',
      label: 'Holding your data',
      figure: String(totals.data_holders),
      filter: { kind: 'item', value: 'data_held' },
    },
  ];
  // A service that does not read promises yet serves neither count, and these
  // two cells are not drawn rather than drawn as nothing.
  if (typeof totals.promises_in_force === 'number')
    rows.push({
      key: 'promises',
      label: 'Promises in force',
      figure: String(totals.promises_in_force),
      filter: { kind: 'promise', lapsed: false },
    });
  if (typeof totals.promises_lapsed === 'number')
    rows.push({
      key: 'lapsed',
      label: 'Promises lapsed',
      figure: String(totals.promises_lapsed),
      filter: { kind: 'promise', lapsed: true },
    });
  return rows;
}

export function TotalsRow({
  totals,
  companies,
  currency,
  filter,
  onFilter,
}: {
  totals: CompanyMapTotals;
  companies: number;
  currency: string;
  filter: Filter;
  onFilter: (next: Filter) => void;
}) {
  const rows = totalsOf(totals, companies, currency);
  return (
    <section className="totals" aria-label="What your companies add up to">
      {rows.map((total) => {
        const on = total.filter !== null && sameFilter(total.filter, filter);
        return (
          <button
            key={total.key}
            type="button"
            className="total"
            data-on={on ? 'true' : undefined}
            data-tone={total.tone}
            aria-pressed={total.filter === null ? undefined : on}
            onClick={() => onFilter(on ? null : total.filter)}
          >
            <span className="total-figure">{total.figure}</span>
            <span className="total-label">{total.label}</span>
          </button>
        );
      })}
    </section>
  );
}
