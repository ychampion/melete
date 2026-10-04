/**
 * Spending caps: what the installation, and each person on it, may spend on
 * model calls in a day and in a month, in dollars and in tokens.
 *
 * Every model call any of the service's gateways settles is written to
 * `model_usage` with its tokens and an estimated cost from the price table:
 * agent turns, routines and background jobs, memory reads, voice asides, the
 * auto-review classifier, the companies scan and learning proposals alike.
 * Before a new call is reserved, the totals for its person and for the
 * installation are read back; once any limit is reached the call is refused
 * with a plain sentence that says when it resets. A call already running is
 * never cut off: it finishes and is counted, and the next one is refused.
 *
 * Days and months are UTC calendar days and months. A limit left unset is no
 * limit. At MELETE_SPEND_NOTICE_PERCENT (default 80) of any limit the person
 * gets a quiet notice in the app, once per period.
 *
 * Each call is also recorded as interactive (a person is waiting on it) or
 * background (nobody is), with its tier and the trigger behind it (see
 * `usage-class.ts`). A person's background limits, when the operator sets
 * them, hold back background calls alone: a person's own message is never
 * refused by them.
 */
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Env } from '../env.ts';
import { PriceTable, parseModelPrices } from './prices.ts';
import {
  GatewayError,
  type GatewayPrincipal,
  type GatewaySettlement,
  type GatewaySpending,
  type GatewaySpendingCall,
} from './types.ts';
import {
  serviceClass,
  TURN_PURPOSES,
  tierOf,
  type UsageClass,
  type UsageTier,
} from './usage-class.ts';

export type SpendingWindow = { usd: number | null; tokens: number | null };
export type SpendingLimits = {
  installation: { day: SpendingWindow; month: SpendingWindow };
  person: { day: SpendingWindow; month: SpendingWindow };
  /** Each person's background calls alone; their interactive calls never count here. */
  background?: { day: SpendingWindow; month: SpendingWindow };
  /** Percent of a limit at which the person is told it is close. */
  noticePercent: number;
};

export const NO_LIMIT: SpendingWindow = { usd: null, tokens: null };

export function spendingLimitsFromEnv(env: Env): SpendingLimits {
  const window = (usd: number | undefined, tokens: number | undefined): SpendingWindow => ({
    usd: usd ?? null,
    tokens: tokens ?? null,
  });
  return {
    installation: {
      day: window(env.MELETE_SPEND_DAILY_USD, env.MELETE_SPEND_DAILY_TOKENS),
      month: window(env.MELETE_SPEND_MONTHLY_USD, env.MELETE_SPEND_MONTHLY_TOKENS),
    },
    person: {
      day: window(env.MELETE_SPEND_PERSON_DAILY_USD, env.MELETE_SPEND_PERSON_DAILY_TOKENS),
      month: window(env.MELETE_SPEND_PERSON_MONTHLY_USD, env.MELETE_SPEND_PERSON_MONTHLY_TOKENS),
    },
    background: {
      day: window(
        env.MELETE_SPEND_PERSON_BACKGROUND_DAILY_USD,
        env.MELETE_SPEND_PERSON_BACKGROUND_DAILY_TOKENS,
      ),
      month: window(
        env.MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_USD,
        env.MELETE_SPEND_PERSON_BACKGROUND_MONTHLY_TOKENS,
      ),
    },
    noticePercent: env.MELETE_SPEND_NOTICE_PERCENT,
  };
}

/** Who a call's spending counts against, and why the call was made. */
export type SpendingScope = {
  spaceId: string | null;
  personId: string | null;
  jobId: string | null;
  purpose: string;
  usageClass: UsageClass;
  tier: UsageTier;
  /** The trigger whose event woke the work that makes the call. */
  triggerId: string | null;
};

export type SpendingTotals = { usd: number; tokens: number };
type Period = 'day' | 'month';
type Level = 'warning' | 'reached';

export type SpendingNotice = {
  level: Level;
  period: Period;
  scope: 'person' | 'installation';
  message: string;
  resets_at: string;
};

type Breakdown = { calls: number; usd: number; tokens: number };

export type SpendingSummary = {
  month_start: string;
  month_resets_at: string;
  day_resets_at: string;
  person: { month: SpendingTotals; day: SpendingTotals } | null;
  /** The person's background calls alone. */
  background: { month: SpendingTotals; day: SpendingTotals } | null;
  /** Only for the installation's owner. */
  installation: { month: SpendingTotals; day: SpendingTotals } | null;
  limits: SpendingLimits;
  notice: SpendingNotice | null;
  models: ({ provider: string; model: string } & Breakdown)[];
  by_purpose: ({ purpose: string; class: UsageClass } & Breakdown)[];
  by_tier: ({ tier: UsageTier } & Breakdown)[];
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function periodBounds(now: Date) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDay = new Date(dayStart.getTime() + 86_400_000);
  return { monthStart, nextMonth, dayStart, nextDay };
}

const dayName = (date: Date) => `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;

/** The sentence a person reads when a limit is reached. */
export function limitMessage(period: Period, resetsAt: Date): string {
  return period === 'month'
    ? `This month's limit is reached; it resets on ${dayName(resetsAt)}.`
    : `Today's limit is reached; it resets on ${dayName(resetsAt)} at 00:00 UTC.`;
}

/** The sentence a person reads when their background work reaches its limit. */
export function backgroundLimitMessage(period: Period, resetsAt: Date): string {
  return period === 'month'
    ? `Background work has reached this month's limit; it starts again on ${dayName(resetsAt)}. Your own messages still go through.`
    : `Background work has reached today's limit; it starts again on ${dayName(resetsAt)} at 00:00 UTC. Your own messages still go through.`;
}

function warningMessage(period: Period, percent: number): string {
  return `You have used ${percent}% of ${period === 'month' ? "this month's" : "today's"} model allowance.`;
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

type Totals = {
  installation: { month: SpendingTotals; day: SpendingTotals };
  person: { month: SpendingTotals; day: SpendingTotals } | null;
  /** The person's background calls alone. */
  background: { month: SpendingTotals; day: SpendingTotals } | null;
};

/** A call admitted and still running: what it may cost, held against the limits. */
type Hold = {
  personId: string | null;
  usageClass: UsageClass;
  usd: number;
  tokens: number;
  at: number;
};

function callCost(
  prices: PriceTable,
  call: { provider: string; model: string; local?: boolean },
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
): number {
  if (call.local) {
    const priced = prices.operatorPrice(call.provider, call.model);
    return priced ? prices.cost(call.provider, call.model, usage) : 0;
  }
  return prices.cost(call.provider, call.model, usage);
}

/**
 * What a settled call cost: nothing on the person's own model unless the
 * operator priced it, plus any flat fee. The spending caps and a job's dollar
 * limit both charge this.
 */
export function settledCost(prices: PriceTable, settlement: GatewaySettlement): number {
  const usage = settlement.usage ?? settlement.spendEstimate ?? null;
  // The model that answered: the person's local model when the privacy
  // router sent the call there.
  const served = settlement.servedBy ?? {
    provider: settlement.provider,
    model: settlement.modelRequested,
  };
  return (
    (usage ? callCost(prices, { ...served, local: settlement.servedLocally === true }, usage) : 0) +
    (settlement.feeUsd ?? 0)
  );
}

/** How long totals read from the database are reused before they are read again. */
const TOTALS_TTL_MS = 2_000;
/** A hold whose call never reported back is let go after this long. */
const HOLD_TTL_MS = 10 * 60_000;

/**
 * The person who caused a job's calls: whoever spoke last in its conversation;
 * for a job nobody has written in (a routine, a background job), whoever
 * created it; else the space's owner.
 */
const PERSON_FOR_JOB = (sql: Sql, jobId: string) => sql`select j.space_id, coalesce(
    (select e.payload->>'principal_id' from event e
      where e.job_id = j.id and e.type = 'notice' and e.payload->>'kind' = 'user_message'
        and e.payload->>'principal_id' is not null
      order by e.seq desc limit 1),
    j.principal_id, s.owner_principal_id) as person_id
  from job j join space s on s.id = j.space_id where j.id = ${jobId}`;

export class SpendingGuard implements GatewaySpending {
  private readonly scopes = new WeakMap<GatewayPrincipal, Promise<SpendingScope>>();
  private readonly holds = new Map<GatewayPrincipal, Hold[]>();
  private readonly cached = new Map<string, { at: number; totals: Totals }>();
  /** Told when a job's call is refused, so its attempt can end at once. */
  onRefused?: (scope: SpendingScope, principal: GatewayPrincipal, message: string) => void;
  /** Told the first time in a period that a limit passes the notice level. */
  onNotice?: (notice: SpendingNotice, personId: string | null) => void;

  constructor(
    private readonly sql: Sql,
    readonly limits: SpendingLimits,
    readonly prices: PriceTable = new PriceTable(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Whether any limit is set at all; without one, admission reads nothing. */
  get limited(): boolean {
    const windows = [
      this.limits.installation.day,
      this.limits.installation.month,
      this.limits.person.day,
      this.limits.person.month,
    ];
    return windows.some((window) => window.usd !== null || window.tokens !== null);
  }

  /** Whether the operator set a background limit for each person. */
  get backgroundLimited(): boolean {
    const background = this.limits.background;
    if (!background) return false;
    return [background.day, background.month].some(
      (window) => window.usd !== null || window.tokens !== null,
    );
  }

  /** Whose spending a principal's calls count against, read once per principal. */
  scopeOf(principal: GatewayPrincipal): Promise<SpendingScope> {
    let scope = this.scopes.get(principal);
    if (!scope) {
      scope = this.resolve(principal);
      this.scopes.set(principal, scope);
      // A failed read is not kept: the next call asks again.
      scope.catch(() => this.scopes.delete(principal));
    }
    return scope;
  }

  private async resolve(principal: GatewayPrincipal): Promise<SpendingScope> {
    const privacy = principal.privacy;
    const jobId = privacy.kind === 'job' ? principal.jobId : privacy.sourceJobId;
    const purpose = privacy.kind === 'job' ? 'agent' : privacy.purpose;
    const actor = principal.actor ?? null;
    const cause = await this.causeOf(principal, jobId ?? null, purpose);
    const scope = {
      ...cause,
      tier: tierOf(privacy.kind, purpose, cause.usageClass),
      jobId: jobId ?? null,
      purpose,
    };
    if (jobId) {
      const [row] = await PERSON_FOR_JOB(this.sql, jobId);
      if (row)
        return {
          ...scope,
          spaceId: String(row.space_id),
          personId: actor ?? (row.person_id ? String(row.person_id) : null),
        };
    }
    const spaceId = privacy.kind === 'service' ? privacy.spaceId : null;
    if (spaceId) {
      const [row] = actor
        ? [{ owner_principal_id: actor }]
        : await this.sql`select owner_principal_id from space where id = ${spaceId}`;
      return {
        ...scope,
        spaceId,
        personId: row?.owner_principal_id ? String(row.owner_principal_id) : null,
      };
    }
    return { ...scope, spaceId: null, personId: actor };
  }

  /**
   * Whether a person is waiting on a call, and what woke the work that makes
   * it. An agent turn's is recorded on its attempt when the attempt starts; a
   * search or a review takes the class of the turn that made it (its own
   * attempt where the principal names one, else the job's latest).
   */
  private async causeOf(
    principal: GatewayPrincipal,
    jobId: string | null,
    purpose: string,
  ): Promise<{ usageClass: UsageClass; triggerId: string | null }> {
    const turn = principal.privacy.kind === 'job' || TURN_PURPOSES.has(purpose);
    if (!turn) return { usageClass: serviceClass(purpose), triggerId: null };
    const [own] = await this
      .sql`select class, trigger_id from attempt where id = ${principal.attemptId}`;
    const [row] =
      own || !jobId
        ? [own]
        : await this.sql`select class, trigger_id from attempt where job_id = ${jobId}
            order by epoch desc limit 1`;
    return {
      usageClass: row?.class === 'background' ? 'background' : 'interactive',
      triggerId: row?.trigger_id ? String(row.trigger_id) : null,
    };
  }

  /**
   * The person's and the installation's totals for today and this month. A
   * read is reused for a moment, so a busy conversation does not scan the
   * month on every call; recording a call reads afresh.
   */
  async totals(personId: string | null, now = this.now(), fresh = false): Promise<Totals> {
    const key = personId ?? '';
    const hit = this.cached.get(key);
    if (!fresh && hit && now.getTime() - hit.at < TOTALS_TTL_MS) return hit.totals;
    const { monthStart, dayStart } = periodBounds(now);
    const day = dayStart.toISOString();
    const [row] = await this.sql`select
        coalesce(sum(cost_usd), 0)::float8 as im_usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as im_tokens,
        coalesce(sum(cost_usd) filter (where created_at >= ${day}::timestamptz), 0)::float8 as id_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where created_at >= ${day}::timestamptz), 0)::float8 as id_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId}), 0)::float8 as pm_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId}), 0)::float8 as pm_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId} and created_at >= ${day}::timestamptz), 0)::float8 as pd_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId} and created_at >= ${day}::timestamptz), 0)::float8 as pd_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId} and class = 'background'), 0)::float8 as bm_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId} and class = 'background'), 0)::float8 as bm_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId} and class = 'background' and created_at >= ${day}::timestamptz), 0)::float8 as bd_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId} and class = 'background' and created_at >= ${day}::timestamptz), 0)::float8 as bd_tokens
      from model_usage where created_at >= ${monthStart.toISOString()}::timestamptz`;
    const total = (usd: unknown, tokens: unknown): SpendingTotals => ({
      usd: round(Number(usd ?? 0)),
      tokens: Number(tokens ?? 0),
    });
    const totals: Totals = {
      installation: {
        month: total(row?.im_usd, row?.im_tokens),
        day: total(row?.id_usd, row?.id_tokens),
      },
      person: personId
        ? { month: total(row?.pm_usd, row?.pm_tokens), day: total(row?.pd_usd, row?.pd_tokens) }
        : null,
      background: personId
        ? { month: total(row?.bm_usd, row?.bm_tokens), day: total(row?.bd_usd, row?.bd_tokens) }
        : null,
    };
    if (this.cached.size > 1000) this.cached.clear();
    this.cached.set(key, { at: now.getTime(), totals });
    return totals;
  }

  /** The totals with the calls still running in this process added. */
  private withHolds(totals: Totals, personId: string | null, now: number): Totals {
    let all = { usd: 0, tokens: 0 };
    let mine = { usd: 0, tokens: 0 };
    let mineBackground = { usd: 0, tokens: 0 };
    for (const [principal, list] of this.holds) {
      const live = list.filter((hold) => now - hold.at < HOLD_TTL_MS);
      if (!live.length) this.holds.delete(principal);
      else if (live.length !== list.length) this.holds.set(principal, live);
      for (const hold of live) {
        all = { usd: all.usd + hold.usd, tokens: all.tokens + hold.tokens };
        if (personId && hold.personId === personId) {
          mine = { usd: mine.usd + hold.usd, tokens: mine.tokens + hold.tokens };
          if (hold.usageClass === 'background')
            mineBackground = {
              usd: mineBackground.usd + hold.usd,
              tokens: mineBackground.tokens + hold.tokens,
            };
        }
      }
    }
    const add = (a: SpendingTotals, b: { usd: number; tokens: number }) => ({
      usd: round(a.usd + b.usd),
      tokens: a.tokens + b.tokens,
    });
    return {
      installation: {
        month: add(totals.installation.month, all),
        day: add(totals.installation.day, all),
      },
      person: totals.person
        ? { month: add(totals.person.month, mine), day: add(totals.person.day, mine) }
        : null,
      background: totals.background
        ? {
            month: add(totals.background.month, mineBackground),
            day: add(totals.background.day, mineBackground),
          }
        : null,
    };
  }

  /**
   * The most pressing notice for these totals: a reached limit before a
   * warning, and a month before a day, since it lasts longer. `installation` false leaves
   * warnings about the installation's limits out, for a person who may not see them.
   */
  noticeFor(totals: Totals, now = this.now(), installation = true): SpendingNotice | null {
    const { nextMonth, nextDay } = periodBounds(now);
    let best: SpendingNotice | null = null;
    const rank = (notice: SpendingNotice) =>
      (notice.level === 'reached' ? 2 : 0) + (notice.period === 'month' ? 1 : 0);
    const consider = (
      scope: 'person' | 'installation',
      period: Period,
      used: SpendingTotals,
      limit: SpendingWindow,
    ) => {
      const fractions = [
        limit.usd !== null ? used.usd / limit.usd : 0,
        limit.tokens !== null ? used.tokens / limit.tokens : 0,
      ];
      const fraction = Math.max(...fractions);
      const resets = period === 'month' ? nextMonth : nextDay;
      let notice: SpendingNotice | null = null;
      if (fraction >= 1)
        notice = {
          level: 'reached',
          period,
          scope,
          message: limitMessage(period, resets),
          resets_at: resets.toISOString(),
        };
      else if (fraction * 100 >= this.limits.noticePercent && (installation || scope === 'person'))
        notice = {
          level: 'warning',
          period,
          scope,
          message: warningMessage(period, Math.floor(fraction * 100)),
          resets_at: resets.toISOString(),
        };
      if (notice && (!best || rank(notice) > rank(best))) best = notice;
    };
    consider('installation', 'month', totals.installation.month, this.limits.installation.month);
    consider('installation', 'day', totals.installation.day, this.limits.installation.day);
    if (totals.person) {
      consider('person', 'month', totals.person.month, this.limits.person.month);
      consider('person', 'day', totals.person.day, this.limits.person.day);
    }
    return best;
  }

  /** The sentence for a reached background limit, the month's before the day's, or null. */
  private backgroundReached(totals: Totals, now: Date): string | null {
    const limits = this.limits.background;
    if (!limits || !totals.background) return null;
    const { nextMonth, nextDay } = periodBounds(now);
    const over = (used: SpendingTotals, limit: SpendingWindow) =>
      (limit.usd !== null && used.usd >= limit.usd) ||
      (limit.tokens !== null && used.tokens >= limit.tokens);
    if (over(totals.background.month, limits.month))
      return backgroundLimitMessage('month', nextMonth);
    if (over(totals.background.day, limits.day)) return backgroundLimitMessage('day', nextDay);
    return null;
  }

  /**
   * The sentence for a reached limit that applies to this person, or null. A
   * background call is also held to the person's background limits; an
   * interactive one never is.
   */
  async reached(
    personId: string | null,
    usageClass: UsageClass = 'interactive',
  ): Promise<string | null> {
    const background = usageClass === 'background' && this.backgroundLimited;
    if (!this.limited && !background) return null;
    const now = this.now();
    const totals = this.withHolds(await this.totals(personId, now), personId, now.getTime());
    const notice = this.noticeFor(totals, now);
    if (notice?.level === 'reached') return notice.message;
    return background ? this.backgroundReached(totals, now) : null;
  }

  /**
   * The reached-limit sentence for the person a job's work is for, or null;
   * read by the runner before an attempt of that class starts.
   */
  async reachedForJob(
    jobId: string,
    usageClass: UsageClass = 'interactive',
  ): Promise<string | null> {
    if (!this.limited && !(usageClass === 'background' && this.backgroundLimited)) return null;
    const [row] = await PERSON_FOR_JOB(this.sql, jobId);
    return this.reached(row?.person_id ? String(row.person_id) : null, usageClass);
  }

  async admit(principal: GatewayPrincipal, call?: GatewaySpendingCall): Promise<void> {
    if (!this.limited && !this.backgroundLimited) return;
    const scope = await this.scopeOf(principal);
    const message = await this.reached(scope.personId, scope.usageClass);
    if (message) {
      try {
        this.onRefused?.(scope, principal, message);
      } catch {
        // Ending the attempt early is a courtesy; the refusal stands either way.
      }
      throw new GatewayError(402, 'spending_limit_reached', message);
    }
    // While it runs, the call's most it can cost is held against the limits,
    // so calls running side by side cannot all slip in under one.
    if (call) {
      const hold: Hold = {
        personId: scope.personId,
        usageClass: scope.usageClass,
        usd: callCost(this.prices, call, {
          inputTokens: call.inputTokens,
          outputTokens: call.maxOutputTokens,
          cachedInputTokens: 0,
        }),
        tokens: call.inputTokens + call.maxOutputTokens,
        at: this.now().getTime(),
      };
      this.holds.set(principal, [...(this.holds.get(principal) ?? []), hold]);
    }
  }

  async record(principal: GatewayPrincipal, settlement: GatewaySettlement): Promise<void> {
    const list = this.holds.get(principal);
    if (list?.length) {
      list.shift();
      if (!list.length) this.holds.delete(principal);
    }
    try {
      const scope = await this.scopeOf(principal);
      const usage = settlement.usage ?? settlement.spendEstimate ?? null;
      // The model that answered: the person's local model when the privacy
      // router sent the call there.
      const served = settlement.servedBy ?? {
        provider: settlement.provider,
        model: settlement.modelRequested,
      };
      const cost = settledCost(this.prices, settlement);
      await this.sql`insert into model_usage (id, created_at, space_id, principal_id, job_id,
          purpose, provider, model, model_actual, route, routed_from, status,
          input_tokens, output_tokens, cached_input_tokens, cost_usd, usage_estimated,
          class, tier, trigger_id, charged_input_tokens, cache_write_tokens)
        values (${randomUUID()}, ${this.now().toISOString()}::timestamptz, ${scope.spaceId}, ${scope.personId}, ${scope.jobId},
          ${scope.purpose}, ${served.provider}, ${served.model}, ${settlement.modelActual},
          ${settlement.route ?? null},
          ${settlement.routedFrom ? `${settlement.routedFrom.provider}/${settlement.routedFrom.model}` : null},
          ${settlement.status}, ${usage?.inputTokens ?? 0}, ${usage?.outputTokens ?? 0},
          ${usage?.cachedInputTokens ?? 0}, ${cost},
          ${settlement.usage === null || settlement.usageEstimated === true},
          ${scope.usageClass}, ${scope.tier}, ${scope.triggerId},
          ${usage ? (usage.chargedInputTokens ?? usage.inputTokens) : 0},
          ${usage?.cacheWriteInputTokens ?? 0})`;
      if (this.limited) await this.noticeOnce(scope.personId);
      // The next admission reads the totals with this call in them.
      else if (this.backgroundLimited) await this.totals(scope.personId, this.now(), true);
    } catch (error) {
      process.stderr.write(
        `spending: a model call was not recorded (${error instanceof Error ? error.message : 'error'})\n`,
      );
    }
  }

  /** Tell the person once per period that a limit is close or reached. */
  private async noticeOnce(personId: string | null): Promise<void> {
    const now = this.now();
    const notice = this.noticeFor(await this.totals(personId, now, true), now);
    if (!notice) return;
    const owner = notice.scope === 'person' ? `person:${personId}` : 'installation';
    const period = notice.resets_at;
    const inserted = await this.sql`insert into spending_notice (scope, period, level)
      values (${owner}, ${period}, ${notice.level}) on conflict do nothing returning scope`;
    if (!inserted.length) return;
    process.stderr.write(`spending: ${notice.scope} ${notice.level} (${notice.period})\n`);
    this.onNotice?.(notice, personId);
  }

  /**
   * What Settings shows: this month and today, background work on its own,
   * the limits, the notice, and the month by model, by purpose and by tier.
   * The installation's figures are for its owner alone.
   */
  async summary(personId: string | null, installation = true): Promise<SpendingSummary> {
    const now = this.now();
    const { monthStart, nextMonth, nextDay } = periodBounds(now);
    const month = monthStart.toISOString();
    const totals = await this.totals(personId, now, true);
    const models = await this.sql`select provider, model, count(*)::int as calls,
        coalesce(sum(cost_usd), 0)::float8 as usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens
      from model_usage where created_at >= ${month}::timestamptz
        and (${personId}::text is null or principal_id = ${personId})
      group by provider, model order by usd desc, tokens desc limit 20`;
    const purposes = await this.sql`select purpose, class, count(*)::int as calls,
        coalesce(sum(cost_usd), 0)::float8 as usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens
      from model_usage where created_at >= ${month}::timestamptz
        and (${personId}::text is null or principal_id = ${personId})
      group by purpose, class order by usd desc, tokens desc, purpose, class`;
    const tiers = await this.sql`select tier, count(*)::int as calls,
        coalesce(sum(cost_usd), 0)::float8 as usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens
      from model_usage where created_at >= ${month}::timestamptz
        and (${personId}::text is null or principal_id = ${personId})
      group by tier order by usd desc, tokens desc, tier`;
    const breakdown = (row: Record<string, unknown>): Breakdown => ({
      calls: Number(row.calls),
      usd: round(Number(row.usd)),
      tokens: Number(row.tokens),
    });
    return {
      month_start: month,
      month_resets_at: nextMonth.toISOString(),
      day_resets_at: nextDay.toISOString(),
      person: totals.person,
      background: totals.background,
      installation: installation ? totals.installation : null,
      limits: this.limits,
      notice: this.noticeFor(totals, now, installation),
      models: models.map((row) => ({
        provider: String(row.provider),
        model: String(row.model),
        ...breakdown(row),
      })),
      by_purpose: purposes.map((row) => ({
        purpose: String(row.purpose),
        class: row.class === 'background' ? 'background' : 'interactive',
        ...breakdown(row),
      })),
      by_tier: tiers.map((row) => ({ tier: String(row.tier) as UsageTier, ...breakdown(row) })),
    };
  }
}

/** The installation's spending guard, from its environment. */
export function spendingFromEnv(sql: Sql, env: Env): SpendingGuard {
  return new SpendingGuard(
    sql,
    spendingLimitsFromEnv(env),
    new PriceTable(parseModelPrices(env.MELETE_MODEL_PRICES)),
  );
}
