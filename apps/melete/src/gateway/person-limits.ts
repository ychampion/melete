/**
 * A person's own spending caps. The installation's owner can give anyone a
 * daily, monthly and background cap of their own, in place of the per-person
 * caps every account otherwise has (`MELETE_SPEND_PERSON_*`); clearing one
 * puts the installation's cap back. The caps are dollars only, and stay
 * within the installation's own limits (see `checkPersonCaps`).
 *
 * The spending guard reads them on every admission, so they are cached for a
 * moment; a change made in this process is seen at once, and one made by
 * another instance of the service within a few seconds.
 */
import type { Sql, TransactionSql } from 'postgres';
import type { SpendingLimits, SpendingWindow } from './spending.ts';

/** A person's own dollar caps; null keeps the installation's cap for that period. */
export type PersonCaps = {
  day_usd: number | null;
  month_usd: number | null;
  background_day_usd: number | null;
  background_month_usd: number | null;
};

export const NO_OWN_CAPS: PersonCaps = {
  day_usd: null,
  month_usd: null,
  background_day_usd: null,
  background_month_usd: null,
};

/** How long the caps read from the database are reused. */
const CACHE_MS = 5_000;

const money = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

export class PersonLimitStore {
  private cached: { at: number; rows: Map<string, PersonCaps> } | null = null;
  private loading: Promise<Map<string, PersonCaps>> | null = null;
  /** Counts `forget`s, so a read begun before a change is neither shared nor kept after it. */
  private generation = 0;

  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async rows(): Promise<Map<string, PersonCaps>> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.rows;
    if (this.loading) return this.loading;
    const generation = this.generation;
    const loading = this.sql<
      {
        principal_id: string;
        day_usd: number | null;
        month_usd: number | null;
        background_day_usd: number | null;
        background_month_usd: number | null;
      }[]
    >`select principal_id, day_usd, month_usd, background_day_usd, background_month_usd
      from person_spend_limit`
      .then((found) => {
        const rows = new Map<string, PersonCaps>();
        for (const row of found)
          rows.set(String(row.principal_id), {
            day_usd: money(row.day_usd),
            month_usd: money(row.month_usd),
            background_day_usd: money(row.background_day_usd),
            background_month_usd: money(row.background_month_usd),
          });
        if (generation === this.generation) this.cached = { at: this.now(), rows };
        return rows;
      })
      .finally(() => {
        if (this.loading === loading) this.loading = null;
      });
    this.loading = loading;
    return loading;
  }

  /** Whether anyone has a cap of their own. */
  async any(): Promise<boolean> {
    return (await this.rows()).size > 0;
  }

  /** This person's own caps; every one null when they have none. */
  async of(personId: string | null): Promise<PersonCaps> {
    if (!personId) return NO_OWN_CAPS;
    return (await this.rows()).get(personId) ?? NO_OWN_CAPS;
  }

  /** Everyone's own caps, by person. */
  async all(): Promise<ReadonlyMap<string, PersonCaps>> {
    return this.rows();
  }

  /** Writes a person's caps; all four null removes the row. */
  async set(q: Sql | TransactionSql, personId: string, caps: PersonCaps): Promise<void> {
    if (Object.values(caps).every((value) => value === null))
      await q`delete from person_spend_limit where principal_id = ${personId}`;
    else
      await q`insert into person_spend_limit (principal_id, day_usd, month_usd,
          background_day_usd, background_month_usd, updated_at)
        values (${personId}, ${caps.day_usd}, ${caps.month_usd}, ${caps.background_day_usd},
          ${caps.background_month_usd}, now())
        on conflict (principal_id) do update set day_usd = excluded.day_usd,
          month_usd = excluded.month_usd, background_day_usd = excluded.background_day_usd,
          background_month_usd = excluded.background_month_usd, updated_at = now()`;
    this.forget();
  }

  /** The next read goes to the database. */
  forget(): void {
    this.generation++;
    this.cached = null;
    this.loading = null;
  }
}

const withUsd = (window: SpendingWindow, usd: number | null): SpendingWindow =>
  usd === null ? window : { ...window, usd };

/**
 * The limits that hold for one person: the installation's, with the person's
 * own dollar caps in place of the per-person ones where they have them.
 */
export function limitsWithCaps(limits: SpendingLimits, caps: PersonCaps): SpendingLimits {
  const background = limits.background ?? {
    day: { usd: null, tokens: null },
    month: { usd: null, tokens: null },
  };
  return {
    ...limits,
    person: {
      day: withUsd(limits.person.day, caps.day_usd),
      month: withUsd(limits.person.month, caps.month_usd),
    },
    background: {
      day: withUsd(background.day, caps.background_day_usd),
      month: withUsd(background.month, caps.background_month_usd),
    },
  };
}

/** The most any one cap may be, in dollars. */
export const MAX_CAP_USD = 1_000_000;

/**
 * Why these caps cannot be set, in a sentence, or null when they can. Each is
 * a positive amount in whole cents, at most the installation's own cap for the
 * same period (a day's at most the installation's day, or its month when it
 * has no daily cap). A person's day may not pass their month, and their
 * background work may not pass what they may spend altogether, counting the
 * installation's per-person caps for any period left to them.
 */
export function checkPersonCaps(limits: SpendingLimits, caps: PersonCaps): string | null {
  const named: Record<keyof PersonCaps, string> = {
    day_usd: 'The daily cap',
    month_usd: 'The monthly cap',
    background_day_usd: 'The daily background cap',
    background_month_usd: 'The monthly background cap',
  };
  for (const key of Object.keys(named) as (keyof PersonCaps)[]) {
    const value = caps[key];
    if (value === null) continue;
    if (!Number.isFinite(value) || value <= 0) return `${named[key]} has to be more than $0.`;
    if (Math.abs(Math.round(value * 100) - value * 100) > 1e-6)
      return `${named[key]} has to be in whole cents, such as 12.50.`;
    if (value > MAX_CAP_USD)
      return `${named[key]} can be at most $${MAX_CAP_USD.toLocaleString('en-US')}.`;
  }
  const dollars = (value: number) => `$${value.toFixed(2)}`;
  const installationMonth = limits.installation.month.usd;
  const installationDay = limits.installation.day.usd ?? installationMonth;
  const effective = limitsWithCaps(limits, caps);
  const day = effective.person.day.usd;
  const month = effective.person.month.usd;
  const checks: [number | null, number | null, string][] = [
    [caps.month_usd, installationMonth, "the installation's monthly cap"],
    [
      caps.day_usd,
      installationDay,
      `the installation's ${limits.installation.day.usd !== null ? 'daily' : 'monthly'} cap`,
    ],
    [caps.background_month_usd, installationMonth, "the installation's monthly cap"],
    [
      caps.background_day_usd,
      installationDay,
      `the installation's ${limits.installation.day.usd !== null ? 'daily' : 'monthly'} cap`,
    ],
  ];
  for (const [value, bound, what] of checks)
    if (value !== null && bound !== null && value > bound)
      return `${dollars(value)} is more than ${what} of ${dollars(bound)}. Choose ${dollars(bound)} or less.`;
  const ownDay = caps.day_usd !== null || caps.month_usd !== null;
  if (ownDay && day !== null && month !== null && day > month)
    return `The daily cap of ${dollars(day)} is more than the monthly cap of ${dollars(month)}.`;
  const backgroundDay = effective.background?.day.usd ?? null;
  const backgroundMonth = effective.background?.month.usd ?? null;
  if (caps.background_day_usd !== null && day !== null && caps.background_day_usd > day)
    return `The daily background cap of ${dollars(caps.background_day_usd)} is more than the daily cap of ${dollars(day)}.`;
  if (caps.background_month_usd !== null && month !== null && caps.background_month_usd > month)
    return `The monthly background cap of ${dollars(caps.background_month_usd)} is more than the monthly cap of ${dollars(month)}.`;
  const ownBackground = caps.background_day_usd !== null || caps.background_month_usd !== null;
  if (
    ownBackground &&
    backgroundDay !== null &&
    backgroundMonth !== null &&
    backgroundDay > backgroundMonth
  )
    return `The daily background cap of ${dollars(backgroundDay)} is more than the monthly background cap of ${dollars(backgroundMonth)}.`;
  return null;
}
