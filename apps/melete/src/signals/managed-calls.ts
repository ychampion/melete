/**
 * What this installation spends at Composio, and the limits its operator set
 * on it. Composio bills each dimension separately: tool calls, trigger events
 * delivered, and connected accounts. Every limit is an operator setting and
 * every one is unset by default: an installation with none set is never held
 * back, and only counts.
 *
 * A call is counted before it is sent: `reserve` takes a lock, reads the
 * period's counts, and either adds the call or refuses it, so calls made at
 * the same moment cannot pass a limit together. A call that was definitely
 * never sent (Composio refused it before running anything) is given back with
 * `release`; one whose fate is unknown (a timeout, a lost answer) stays
 * counted. Trigger events are counted as they arrive, since Composio has
 * already billed them; past their limit the triggers are switched off there.
 *
 * Without a credit, a dimension's limit is hard. With a monthly credit, a
 * call may go past a dimension's limit (its free allowance) only while the
 * period's estimated overage, at the configured rates, stays within the credit.
 *
 * Composio's own usage numbers, when it gives them, are kept beside the local
 * count. A limit is checked against the larger of Melete's count and
 * Composio's plus whatever Melete counted since Composio's was read.
 */
import type { Sql, TransactionSql } from 'postgres';

/** The pool, or one transaction on it. */
type Query = Sql | TransactionSql;

/** The dimensions Melete's own use can incur. Accounts are limited by count, not by period. */
export const METERED = ['tool_calls', 'trigger_events'] as const;
export type Metered = (typeof METERED)[number];

/** At or above this share of a limit, watching slows down. */
export const NEAR_SHARE = 0.8;

export type MeterSettings = {
  /** Each dimension's monthly limit; a dimension left out has none. */
  caps: Partial<Record<Metered, number>>;
  /** The most connected accounts at Composio at once; unset, no limit. */
  accountsCap?: number;
  /** The monthly credit overage may use, in US dollars; unset, limits are hard. */
  creditUsd?: number;
  /** The price of one unit past the free allowance, in US dollars. */
  ratesUsd: Record<Metered, number>;
  /** The day of the month (1-28, UTC) each billing period starts. */
  billingDay: number;
};

export type DimensionStanding = {
  used: number;
  cap: number | null;
  state: 'ok' | 'near' | 'reached';
};

export type ManagedStanding = DimensionStanding & {
  period: string;
  dimensions: Record<Metered, DimensionStanding>;
  /** Estimated cost past the free allowances this period, in US dollars. */
  overageUsd: number;
  creditUsd: number | null;
  accounts: { used: number; cap: number | null };
};

/** What a person reads on a watched account while the limit slows it, in plain words. */
export const MANAGED_NEAR_WORDS =
  'This month’s calls through Composio are close to the limit set for this Melete, so this account is read less often until the month resets.';
export const MANAGED_REACHED_WORDS =
  'This month’s calls through Composio have reached the limit set for this Melete, so this account is paused until the month resets.';

/** The plain sentence the agent relays when a dimension is spent. */
export const CAP_WORDS: Record<Metered | 'connected_accounts', string> = {
  tool_calls:
    'This app is paused on this Melete until the month resets: it has used all the calls through Composio its operator allows this month.',
  trigger_events:
    'Updates from this app are paused on this Melete until the month resets: it has received all the events through Composio its operator allows this month.',
  connected_accounts:
    'No more apps can be connected through Composio on this Melete: it already has as many connected accounts as its operator allows.',
};

/** A dimension's limit is reached: the call is refused before it reaches Composio. */
export class ComposioCapReached extends Error {
  readonly code = 'composio_cap_reached';
  constructor(readonly dimension: Metered | 'connected_accounts') {
    super(CAP_WORDS[dimension]);
    this.name = 'ComposioCapReached';
  }
}

/** One counted call, to give back if it was never sent. */
export type Reservation = { period: string; dimension: Metered; units: number };

/** Locks that serialize counting; any two fixed numbers no other code takes. */
const USAGE_LOCK = 0x6d656c_01;
const ACCOUNTS_LOCK = 0x6d656c_02;

const MICROS = 1_000_000;
const micros = (usd: number) => Math.round(usd * MICROS);
const iso = (at: Date) => at.toISOString().slice(0, 10);

/** The billing period holding `at`: it starts on `day` of a month, in UTC. */
export function periodOf(at: number, day: number): { start: string; from: number; to: number } {
  const now = new Date(at);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() < day) month -= 1;
  if (month < 0) {
    month = 11;
    year -= 1;
  }
  const from = Date.UTC(year, month, day);
  const to = Date.UTC(year, month + 1, day);
  return { start: iso(new Date(from)), from, to };
}

/** The settings as the environment names them; every limit unset unless set there. */
export function meterSettings(env: {
  MELETE_COMPOSIO_TOOL_CALLS_MONTHLY_CAP?: number | undefined;
  MELETE_MANAGED_CALLS_MONTHLY_CAP?: number | undefined;
  MELETE_COMPOSIO_TRIGGER_EVENTS_MONTHLY_CAP?: number | undefined;
  MELETE_COMPOSIO_ACCOUNTS_CAP?: number | undefined;
  MELETE_COMPOSIO_MONTHLY_CREDIT_USD?: number | undefined;
  MELETE_COMPOSIO_TOOL_CALL_USD: number;
  MELETE_COMPOSIO_TRIGGER_EVENT_USD: number;
  MELETE_COMPOSIO_BILLING_DAY: number;
}): MeterSettings {
  const toolCalls =
    env.MELETE_COMPOSIO_TOOL_CALLS_MONTHLY_CAP ?? env.MELETE_MANAGED_CALLS_MONTHLY_CAP;
  const caps: MeterSettings['caps'] = {};
  if (toolCalls !== undefined) caps.tool_calls = toolCalls;
  if (env.MELETE_COMPOSIO_TRIGGER_EVENTS_MONTHLY_CAP !== undefined)
    caps.trigger_events = env.MELETE_COMPOSIO_TRIGGER_EVENTS_MONTHLY_CAP;
  return {
    caps,
    ...(env.MELETE_COMPOSIO_ACCOUNTS_CAP !== undefined
      ? { accountsCap: env.MELETE_COMPOSIO_ACCOUNTS_CAP }
      : {}),
    ...(env.MELETE_COMPOSIO_MONTHLY_CREDIT_USD !== undefined
      ? { creditUsd: env.MELETE_COMPOSIO_MONTHLY_CREDIT_USD }
      : {}),
    ratesUsd: {
      tool_calls: env.MELETE_COMPOSIO_TOOL_CALL_USD,
      trigger_events: env.MELETE_COMPOSIO_TRIGGER_EVENT_USD,
    },
    billingDay: env.MELETE_COMPOSIO_BILLING_DAY,
  };
}

/** A standing as the operator reads it, in `GET /health/detail` and the log. */
export function standingView(standing: ManagedStanding) {
  return {
    period: standing.period,
    tool_calls: standing.dimensions.tool_calls,
    trigger_events: standing.dimensions.trigger_events,
    connected_accounts: standing.accounts,
    overage_usd: Math.round(standing.overageUsd * 10_000) / 10_000,
    credit_usd: standing.creditUsd,
  };
}

/** One log line with every dimension against its limit. */
export function standingLine(standing: ManagedStanding): string {
  const of = (used: number, cap: number | null) => `${used}/${cap ?? 'none'}`;
  const { tool_calls: calls, trigger_events: events } = standing.dimensions;
  return (
    `composio: usage period=${standing.period} tool_calls=${of(calls.used, calls.cap)} ${calls.state}` +
    ` trigger_events=${of(events.used, events.cap)} ${events.state}` +
    ` accounts=${of(standing.accounts.used, standing.accounts.cap)}` +
    ` overage_usd=${standing.overageUsd.toFixed(4)} credit_usd=${standing.creditUsd ?? 'none'}\n`
  );
}

/** The calendar month in UTC, `YYYY-MM`. */
export const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

export class ComposioMeter {
  /** When Composio's own numbers were last read, and whether that is under way. */
  private reconciledAt = 0;
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly sql: Sql,
    readonly settings: MeterSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether any limit at all is set. */
  get limited(): boolean {
    return (
      Object.values(this.settings.caps).some((cap) => cap !== undefined) ||
      this.settings.accountsCap !== undefined
    );
  }

  period() {
    return periodOf(this.now(), this.settings.billingDay);
  }

  /**
   * The period's counts, by dimension: the larger of Melete's own and
   * Composio's last report with what Melete counted since added to it.
   */
  private async counts(query: Query, period: string): Promise<Record<Metered, number>> {
    const rows = await query`select dimension,
        greatest(used, coalesce(reported, 0) + greatest(0, used - used_at_report))::bigint as used
      from composio_usage where period = ${period}`;
    const counts = Object.fromEntries(METERED.map((d) => [d, 0])) as Record<Metered, number>;
    for (const row of rows)
      if ((METERED as readonly string[]).includes(String(row.dimension)))
        counts[row.dimension as Metered] = Number(row.used);
    return counts;
  }

  /** Estimated overage in millionths of a dollar, for these counts. */
  private overageMicros(counts: Record<Metered, number>): number {
    let total = 0;
    for (const dimension of METERED) {
      const cap = this.settings.caps[dimension];
      if (cap === undefined) continue;
      total += Math.max(0, counts[dimension] - cap) * micros(this.settings.ratesUsd[dimension]);
    }
    return total;
  }

  /** Whether counts that already include the new units are allowed. */
  private allows(counts: Record<Metered, number>, dimension: Metered): boolean {
    const cap = this.settings.caps[dimension];
    if (cap === undefined) return true;
    if (counts[dimension] <= cap) return true;
    if (this.settings.creditUsd === undefined) return false;
    return this.overageMicros(counts) <= micros(this.settings.creditUsd);
  }

  private async add(query: Query, period: string, dimension: Metered, units: number) {
    await query`insert into composio_usage (period, dimension, used)
      values (${period}, ${dimension}, ${units})
      on conflict (period, dimension) do update
        set used = greatest(0, composio_usage.used + excluded.used), updated_at = now()`;
  }

  /**
   * Count `units` of a dimension before they are sent, or refuse them with
   * `ComposioCapReached` when that would pass the limit. Atomic across every
   * caller of every process sharing the database.
   */
  async reserve(dimension: Metered, units = 1): Promise<Reservation> {
    const { start } = this.period();
    if (this.settings.caps[dimension] === undefined) {
      await this.add(this.sql, start, dimension, units);
      return { period: start, dimension, units };
    }
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${USAGE_LOCK})`;
      const counts = await this.counts(tx, start);
      counts[dimension] += units;
      if (!this.allows(counts, dimension)) throw new ComposioCapReached(dimension);
      await this.add(tx, start, dimension, units);
    });
    return { period: start, dimension, units };
  }

  /** Give back a reservation whose call was definitely never sent. */
  async release(reservation: Reservation): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${USAGE_LOCK})`;
      await tx`update composio_usage set used = greatest(0, used - ${reservation.units}),
          updated_at = now()
        where period = ${reservation.period} and dimension = ${reservation.dimension}`;
    });
  }

  /**
   * Count what Composio already did (a trigger event that arrived). Never
   * refused; the answer says whether the dimension is now spent, so whatever
   * makes more of it can be switched off.
   */
  async record(dimension: Metered, units = 1): Promise<{ spent: boolean }> {
    const { start } = this.period();
    let spent = false;
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${USAGE_LOCK})`;
      await this.add(tx, start, dimension, units);
      const counts = await this.counts(tx, start);
      counts[dimension] += 1;
      spent = !this.allows(counts, dimension);
    });
    return { spent };
  }

  /** Whether one more unit of a dimension would be refused now. */
  async spent(dimension: Metered): Promise<boolean> {
    if (this.settings.caps[dimension] === undefined) return false;
    const counts = await this.counts(this.sql, this.period().start);
    counts[dimension] += 1;
    return !this.allows(counts, dimension);
  }

  /** Accounts at Composio now: those a live connection acts for, and those still to remove. */
  private async accountsInUse(query: Sql): Promise<number> {
    const [row] = await query`select count(distinct id)::int as used from (
        select configuration->>'connected_account_id' as id from connection
          where status <> 'revoked' and configuration->>'via' = 'composio'
            and configuration->>'connected_account_id' is not null
        union select connected_account_id from managed_account_removal) accounts`;
    return Number(row?.used ?? 0);
  }

  /**
   * Run `make`, which creates a connected account at Composio, only while the
   * account limit leaves room for one more. Held under a lock until `make`
   * has recorded the account it made, so two sign-ins cannot both take the
   * last place.
   */
  async withAccountSlot<T>(make: () => Promise<T>): Promise<T> {
    const cap = this.settings.accountsCap;
    if (cap === undefined) return make();
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ACCOUNTS_LOCK})`;
      if ((await this.accountsInUse(this.sql)) >= cap)
        throw new ComposioCapReached('connected_accounts');
      return make();
    }) as Promise<T>;
  }

  /**
   * Keep Composio's own count for the period beside Melete's, read at most
   * every `everyMs`. Its tool calls are `tool_calls`; an entity named for
   * triggers is `trigger_events`. A failure leaves the last numbers in place.
   */
  async reconcile(
    usage: (from: number, to: number) => Promise<Record<string, number>>,
    everyMs = 10 * 60_000,
  ): Promise<void> {
    if (this.now() - this.reconciledAt < everyMs) return;
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      const { start, from } = this.period();
      const totals = await usage(from, this.now());
      const reported: Partial<Record<Metered, number>> = {};
      for (const [entity, quantity] of Object.entries(totals)) {
        const dimension: Metered | null =
          entity === 'tool_calls' ? 'tool_calls' : /trigger/.test(entity) ? 'trigger_events' : null;
        if (dimension) reported[dimension] = (reported[dimension] ?? 0) + quantity;
      }
      for (const dimension of METERED)
        await this.sql`insert into composio_usage (period, dimension, used, reported)
          values (${start}, ${dimension}, 0, ${reported[dimension] ?? 0})
          on conflict (period, dimension) do update
            set reported = excluded.reported, used_at_report = composio_usage.used,
              updated_at = now()`;
      this.reconciledAt = this.now();
    })().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** Where this period stands against every limit; `ok` everywhere without any. */
  async standing(): Promise<ManagedStanding> {
    const { start } = this.period();
    const counts = await this.counts(this.sql, start);
    const dimensions = {} as Record<Metered, DimensionStanding>;
    for (const dimension of METERED) {
      const cap = this.settings.caps[dimension] ?? null;
      const next = { ...counts, [dimension]: counts[dimension] + 1 };
      const state =
        cap === null
          ? 'ok'
          : !this.allows(next, dimension)
            ? 'reached'
            : counts[dimension] >= cap * NEAR_SHARE
              ? 'near'
              : 'ok';
      dimensions[dimension] = { used: counts[dimension], cap, state };
    }
    return {
      ...dimensions.tool_calls,
      period: start,
      dimensions,
      overageUsd: this.overageMicros(counts) / MICROS,
      creditUsd: this.settings.creditUsd ?? null,
      accounts: {
        used: await this.accountsInUse(this.sql),
        cap: this.settings.accountsCap ?? null,
      },
    };
  }
}
