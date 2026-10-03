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

export type SpendingWindow = { usd: number | null; tokens: number | null };
export type SpendingLimits = {
  installation: { day: SpendingWindow; month: SpendingWindow };
  person: { day: SpendingWindow; month: SpendingWindow };
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
    noticePercent: env.MELETE_SPEND_NOTICE_PERCENT,
  };
}

/** Who a call's spending counts against. */
export type SpendingScope = {
  spaceId: string | null;
  personId: string | null;
  jobId: string | null;
  purpose: string;
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

export type SpendingSummary = {
  month_start: string;
  month_resets_at: string;
  day_resets_at: string;
  person: { month: SpendingTotals; day: SpendingTotals } | null;
  /** Only for the installation's owner. */
  installation: { month: SpendingTotals; day: SpendingTotals } | null;
  limits: SpendingLimits;
  notice: SpendingNotice | null;
  models: { provider: string; model: string; calls: number; usd: number; tokens: number }[];
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

function warningMessage(period: Period, percent: number): string {
  return `You have used ${percent}% of ${period === 'month' ? "this month's" : "today's"} model allowance.`;
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

type Totals = {
  installation: { month: SpendingTotals; day: SpendingTotals };
  person: { month: SpendingTotals; day: SpendingTotals } | null;
};

/** A call admitted and still running: what it may cost, held against the limits. */
type Hold = { personId: string | null; usd: number; tokens: number; at: number };

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
    if (jobId) {
      const [row] = await PERSON_FOR_JOB(this.sql, jobId);
      if (row)
        return {
          spaceId: String(row.space_id),
          personId: actor ?? (row.person_id ? String(row.person_id) : null),
          jobId,
          purpose,
        };
    }
    const spaceId = privacy.kind === 'service' ? privacy.spaceId : null;
    if (spaceId) {
      const [row] = actor
        ? [{ owner_principal_id: actor }]
        : await this.sql`select owner_principal_id from space where id = ${spaceId}`;
      return {
        spaceId,
        personId: row?.owner_principal_id ? String(row.owner_principal_id) : null,
        jobId: jobId ?? null,
        purpose,
      };
    }
    return { spaceId: null, personId: actor, jobId: jobId ?? null, purpose };
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
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId} and created_at >= ${day}::timestamptz), 0)::float8 as pd_tokens
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
    };
    if (this.cached.size > 1000) this.cached.clear();
    this.cached.set(key, { at: now.getTime(), totals });
    return totals;
  }

  /** The totals with the calls still running in this process added. */
  private withHolds(totals: Totals, personId: string | null, now: number): Totals {
    let all = { usd: 0, tokens: 0 };
    let mine = { usd: 0, tokens: 0 };
    for (const [principal, list] of this.holds) {
      const live = list.filter((hold) => now - hold.at < HOLD_TTL_MS);
      if (!live.length) this.holds.delete(principal);
      else if (live.length !== list.length) this.holds.set(principal, live);
      for (const hold of live) {
        all = { usd: all.usd + hold.usd, tokens: all.tokens + hold.tokens };
        if (personId && hold.personId === personId)
          mine = { usd: mine.usd + hold.usd, tokens: mine.tokens + hold.tokens };
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

  /** The sentence for a reached limit that applies to this person, or null. */
  async reached(personId: string | null): Promise<string | null> {
    if (!this.limited) return null;
    const now = this.now();
    const totals = this.withHolds(await this.totals(personId, now), personId, now.getTime());
    const notice = this.noticeFor(totals, now);
    return notice?.level === 'reached' ? notice.message : null;
  }

  /** The reached-limit sentence for the person a job's work is for, or null; read by the runner. */
  async reachedForJob(jobId: string): Promise<string | null> {
    if (!this.limited) return null;
    const [row] = await PERSON_FOR_JOB(this.sql, jobId);
    return this.reached(row?.person_id ? String(row.person_id) : null);
  }

  /** What a call may cost: nothing on the person's own model unless the operator priced it. */
  private costOf(
    call: { provider: string; model: string; local?: boolean },
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  ): number {
    if (call.local) {
      const priced = this.prices.operatorPrice(call.provider, call.model);
      return priced ? this.prices.cost(call.provider, call.model, usage) : 0;
    }
    return this.prices.cost(call.provider, call.model, usage);
  }

  async admit(principal: GatewayPrincipal, call?: GatewaySpendingCall): Promise<void> {
    if (!this.limited) return;
    const scope = await this.scopeOf(principal);
    const message = await this.reached(scope.personId);
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
        usd: this.costOf(call, {
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
      const cost =
        (usage ? this.costOf({ ...served, local: settlement.servedLocally === true }, usage) : 0) +
        (settlement.feeUsd ?? 0);
      await this.sql`insert into model_usage (id, created_at, space_id, principal_id, job_id,
          purpose, provider, model, model_actual, route, routed_from, status,
          input_tokens, output_tokens, cached_input_tokens, cost_usd, usage_estimated)
        values (${randomUUID()}, ${this.now().toISOString()}::timestamptz, ${scope.spaceId}, ${scope.personId}, ${scope.jobId},
          ${scope.purpose}, ${served.provider}, ${served.model}, ${settlement.modelActual},
          ${settlement.route ?? null},
          ${settlement.routedFrom ? `${settlement.routedFrom.provider}/${settlement.routedFrom.model}` : null},
          ${settlement.status}, ${usage?.inputTokens ?? 0}, ${usage?.outputTokens ?? 0},
          ${usage?.cachedInputTokens ?? 0}, ${cost},
          ${settlement.usage === null || settlement.usageEstimated === true})`;
      if (this.limited) await this.noticeOnce(scope.personId);
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
   * What Settings shows: this month and today, the limits, the notice and the
   * models. The installation's figures are for its owner alone.
   */
  async summary(personId: string | null, installation = true): Promise<SpendingSummary> {
    const now = this.now();
    const { monthStart, nextMonth, nextDay } = periodBounds(now);
    const totals = await this.totals(personId, now, true);
    const models = await this.sql`select provider, model, count(*)::int as calls,
        coalesce(sum(cost_usd), 0)::float8 as usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as tokens
      from model_usage where created_at >= ${monthStart.toISOString()}::timestamptz
        and (${personId}::text is null or principal_id = ${personId})
      group by provider, model order by usd desc, tokens desc limit 20`;
    return {
      month_start: monthStart.toISOString(),
      month_resets_at: nextMonth.toISOString(),
      day_resets_at: nextDay.toISOString(),
      person: totals.person,
      installation: installation ? totals.installation : null,
      limits: this.limits,
      notice: this.noticeFor(totals, now, installation),
      models: models.map((row) => ({
        provider: String(row.provider),
        model: String(row.model),
        calls: Number(row.calls),
        usd: round(Number(row.usd)),
        tokens: Number(row.tokens),
      })),
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
