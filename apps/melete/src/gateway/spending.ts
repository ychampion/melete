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
  installation: { month: SpendingTotals; day: SpendingTotals };
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

export class SpendingGuard implements GatewaySpending {
  private readonly scopes = new WeakMap<GatewayPrincipal, Promise<SpendingScope>>();
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
    if (jobId) {
      const [row] = await this.sql`select j.space_id,
          coalesce(j.principal_id, s.owner_principal_id) as person_id
        from job j join space s on s.id = j.space_id where j.id = ${jobId}`;
      if (row)
        return {
          spaceId: String(row.space_id),
          personId: row.person_id ? String(row.person_id) : null,
          jobId,
          purpose,
        };
    }
    const spaceId = privacy.kind === 'service' ? privacy.spaceId : null;
    if (spaceId) {
      const [row] = await this.sql`select owner_principal_id from space where id = ${spaceId}`;
      return {
        spaceId,
        personId: row?.owner_principal_id ? String(row.owner_principal_id) : null,
        jobId: jobId ?? null,
        purpose,
      };
    }
    return { spaceId: null, personId: null, jobId: jobId ?? null, purpose };
  }

  /** The person's and the installation's totals for today and this month. */
  async totals(personId: string | null, now = this.now()) {
    const { monthStart, dayStart } = periodBounds(now);
    const [row] = await this.sql`select
        coalesce(sum(cost_usd), 0)::float8 as im_usd,
        coalesce(sum(input_tokens + output_tokens), 0)::float8 as im_tokens,
        coalesce(sum(cost_usd) filter (where created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as id_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as id_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId}), 0)::float8 as pm_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId}), 0)::float8 as pm_tokens,
        coalesce(sum(cost_usd) filter (where principal_id = ${personId} and created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as pd_usd,
        coalesce(sum(input_tokens + output_tokens) filter (where principal_id = ${personId} and created_at >= ${dayStart.toISOString()}::timestamptz), 0)::float8 as pd_tokens
      from model_usage where created_at >= ${monthStart.toISOString()}::timestamptz`;
    const total = (usd: unknown, tokens: unknown): SpendingTotals => ({
      usd: round(Number(usd ?? 0)),
      tokens: Number(tokens ?? 0),
    });
    return {
      installation: {
        month: total(row?.im_usd, row?.im_tokens),
        day: total(row?.id_usd, row?.id_tokens),
      },
      person: personId
        ? { month: total(row?.pm_usd, row?.pm_tokens), day: total(row?.pd_usd, row?.pd_tokens) }
        : null,
    };
  }

  /**
   * The most pressing notice for these totals: a reached limit before a
   * warning, and a month before a day, since it lasts longer.
   */
  noticeFor(
    totals: Awaited<ReturnType<SpendingGuard['totals']>>,
    now = this.now(),
  ): SpendingNotice | null {
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
      else if (fraction * 100 >= this.limits.noticePercent)
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
    const notice = this.noticeFor(await this.totals(personId));
    return notice?.level === 'reached' ? notice.message : null;
  }

  /** The reached-limit sentence for a job's person, or null; read by the runner. */
  async reachedForJob(jobId: string): Promise<string | null> {
    if (!this.limited) return null;
    const [row] = await this.sql`select coalesce(j.principal_id, s.owner_principal_id) as person_id
      from job j join space s on s.id = j.space_id where j.id = ${jobId}`;
    return this.reached(row?.person_id ? String(row.person_id) : null);
  }

  async admit(principal: GatewayPrincipal): Promise<void> {
    if (!this.limited) return;
    const scope = await this.scopeOf(principal);
    const message = await this.reached(scope.personId);
    if (!message) return;
    try {
      this.onRefused?.(scope, principal, message);
    } catch {
      // Ending the attempt early is a courtesy; the refusal stands either way.
    }
    throw new GatewayError(402, 'spending_limit_reached', message);
  }

  async record(principal: GatewayPrincipal, settlement: GatewaySettlement): Promise<void> {
    try {
      const scope = await this.scopeOf(principal);
      const usage = settlement.usage;
      const model = settlement.modelRequested;
      const cost = usage ? this.prices.cost(settlement.provider, model, usage) : 0;
      await this.sql`insert into model_usage (id, created_at, space_id, principal_id, job_id,
          purpose, provider, model, model_actual, route, routed_from, status,
          input_tokens, output_tokens, cached_input_tokens, cost_usd, usage_estimated)
        values (${randomUUID()}, ${this.now().toISOString()}::timestamptz, ${scope.spaceId}, ${scope.personId}, ${scope.jobId},
          ${scope.purpose}, ${settlement.provider}, ${model}, ${settlement.modelActual},
          ${settlement.route ?? null},
          ${settlement.routedFrom ? `${settlement.routedFrom.provider}/${settlement.routedFrom.model}` : null},
          ${settlement.status}, ${usage?.inputTokens ?? 0}, ${usage?.outputTokens ?? 0},
          ${usage?.cachedInputTokens ?? 0}, ${cost},
          ${usage === null || settlement.usageEstimated === true})`;
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
    const notice = this.noticeFor(await this.totals(personId, now), now);
    if (!notice) return;
    const owner = notice.scope === 'person' ? `person:${personId}` : 'installation';
    const period = notice.resets_at;
    const inserted = await this.sql`insert into spending_notice (scope, period, level)
      values (${owner}, ${period}, ${notice.level}) on conflict do nothing returning scope`;
    if (!inserted.length) return;
    process.stderr.write(`spending: ${notice.scope} ${notice.level} (${notice.period})\n`);
    this.onNotice?.(notice, personId);
  }

  /** What Settings shows: this month and today, the limits, the notice and the models. */
  async summary(personId: string | null): Promise<SpendingSummary> {
    const now = this.now();
    const { monthStart, nextMonth, nextDay } = periodBounds(now);
    const totals = await this.totals(personId, now);
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
      installation: totals.installation,
      limits: this.limits,
      notice: this.noticeFor(totals, now),
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
