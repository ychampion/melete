/**
 * Model usage for Settings, and the operator's health detail.
 *
 * `GET /usage` answers any signed-in account with its own spending and the
 * installation's, the limits, the notice it should see, the month by purpose
 * and by tier, its last 30 days, and the month by space for the spaces it
 * owns; the owner also sees background cost per person per day and the month
 * by member. `PUT /usage/limits/members/:id` and `/usage/limits/spaces/:id`
 * let the owner set or remove one member's monthly limit or one space's
 * budget. `GET /health/detail` takes the operator's bearer token and answers
 * each health check with what it found; 503 while any fails.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  healthDetailResponse,
  spendLimitRequest,
  spendLimitResponse,
  usageResponse,
} from '@melete/contracts';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import { type SpendLimitKind, usageByMember, usageBySpace } from '../gateway/spend-limits.ts';
import { NO_LIMIT, type SpendingGuard } from '../gateway/spending.ts';
import { backgroundCostPerPersonDay, usageSeries, utcDay } from '../gateway/usage-day.ts';
import type { HealthDetail } from '../health/monitor.ts';

export function mountUsage(
  app: Hono,
  deps: {
    spending: SpendingGuard;
    /** Whether this account runs the installation, and so sees its totals. */
    isOwner: (actor: string | undefined) => Promise<boolean>;
    /** Read for the daily series and, for the owner, background cost per person-day. */
    sql?: Sql;
    now?: () => Date;
    /**
     * This account's primary and secondary models now, so each model it used is
     * labelled with the part it plays. Left out, no model is labelled.
     */
    roles?: (actor: string | undefined) => Promise<ModelRoles>;
  },
): void {
  app.get('/usage', async (c) => {
    const actor = c.get('owner')?.id as string | undefined;
    const owner = await deps.isOwner(actor);
    const summary = await deps.spending.summary(actor ?? null, owner);
    const { noticePercent: _notice, ...limits } = summary.limits;
    const roles = (await deps.roles?.(actor)) ?? { primary: null, secondary: null };
    const now = deps.now?.() ?? new Date();
    const today = utcDay(now);
    const weekAgo = utcDay(new Date(now.getTime() - 7 * 86_400_000));
    const days = deps.sql ? await usageSeries(deps.sql, actor ?? null, now) : undefined;
    const perPersonDay =
      deps.sql && owner ? await backgroundCostPerPersonDay(deps.sql, weekAgo, today) : null;
    const set = deps.sql && actor ? await deps.spending.spendLimits.all() : null;
    const bySpace =
      deps.sql && actor && set ? await usageBySpace(deps.sql, actor, owner, set, now) : undefined;
    const byMember = deps.sql && owner && set ? await usageByMember(deps.sql, set, now) : null;
    return c.json(
      usageResponse.parse({
        ...summary,
        limits: {
          person: limits.person,
          background: limits.background ?? { day: NO_LIMIT, month: NO_LIMIT },
          installation: owner ? limits.installation : null,
        },
        models: summary.models.map((row) => ({ ...row, role: roleOf(row, roles) })),
        ...(days ? { days } : {}),
        background_per_person_day: perPersonDay
          ? {
              person_days: perPersonDay.person_days,
              median_usd: perPersonDay.median_usd,
              p95_usd: perPersonDay.p95_usd,
              mean_usd: perPersonDay.mean_usd,
            }
          : null,
        ...(bySpace ? { by_space: bySpace } : {}),
        by_member: byMember,
      }),
    );
  });

  const sql = deps.sql;
  if (!sql) return;
  const setLimit = async (c: Context, kind: SpendLimitKind, id: string) => {
    const actor = c.get('owner')?.id as string | undefined;
    if (!(await deps.isOwner(actor)))
      return c.json(
        {
          error: {
            code: 'scope_denied',
            message: 'Only the person who runs this Melete sets spending limits.',
          },
        },
        403,
      );
    const parsed = spendLimitRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error: {
            code: 'invalid_request',
            message: 'Give a monthly amount in dollars from 0 to 1,000,000, or null to remove it.',
          },
        },
        400,
      );
    const [found] =
      kind === 'member'
        ? await sql`select id from principal where id = ${id} and kind in ('person', 'guest')`
        : await sql`select id from space where id = ${id} and removed_at is null`;
    if (!found)
      return c.json(
        {
          error: {
            code: 'not_found',
            message: kind === 'member' ? 'No such member.' : 'No such space.',
          },
        },
        404,
      );
    await deps.spending.spendLimits.set(kind, id, parsed.data.monthly_usd, actor ?? null);
    return c.json(spendLimitResponse.parse({ kind, id, monthly_usd: parsed.data.monthly_usd }));
  };
  app.put('/usage/limits/members/:id', (c) => setLimit(c, 'member', c.req.param('id')));
  app.put('/usage/limits/spaces/:id', (c) => setLimit(c, 'space', c.req.param('id')));
}

type ModelChoice = { provider: string; model: string };
export type ModelRoles = { primary: ModelChoice | null; secondary: ModelChoice | null };

const same = (a: ModelChoice, b: ModelChoice | null) =>
  b !== null && a.provider === b.provider && a.model === b.model;

/** The part a model plays for this account now; the primary when it is both. */
export function roleOf(row: ModelChoice, roles: ModelRoles): 'primary' | 'secondary' | null {
  if (same(row, roles.primary)) return 'primary';
  if (same(row, roles.secondary)) return 'secondary';
  return null;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Whether a request carries the operator's token, compared in constant time. */
export function operatorAuthorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer (\S+)$/.exec(header ?? '');
  if (!match?.[1]) return false;
  return timingSafeEqual(digest(match[1]), digest(token));
}

export function mountHealthDetail(
  app: Hono,
  deps: { token: string | undefined; detail: () => Promise<HealthDetail> },
): void {
  app.get('/health/detail', async (c) => {
    if (!deps.token)
      return c.json(
        {
          error: {
            code: 'not_found',
            message: 'Set MELETE_OPERATOR_TOKEN to read the health detail.',
          },
        },
        404,
      );
    if (!operatorAuthorized(c.req.header('authorization'), deps.token))
      return c.json(
        { error: { code: 'unauthorized', message: 'The operator token is required.' } },
        401,
      );
    const detail = healthDetailResponse.parse(await deps.detail());
    c.header('cache-control', 'no-store');
    return c.json(detail, detail.status === 'ok' ? 200 : 503);
  });
}
