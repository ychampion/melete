/**
 * Model usage for Settings, and the operator's health detail.
 *
 * `GET /usage` answers any signed-in account with its own spending and the
 * installation's, the limits, and the notice it should see. `GET
 * /health/detail` takes the operator's bearer token and answers each health
 * check with what it found; 503 while any fails.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { healthDetailResponse, usageResponse } from '@melete/contracts';
import type { Hono } from 'hono';
import type { SpendingGuard } from '../gateway/spending.ts';
import type { HealthDetail } from '../health/monitor.ts';

export function mountUsage(app: Hono, deps: { spending: SpendingGuard }): void {
  app.get('/usage', async (c) => {
    const summary = await deps.spending.summary(c.get('owner')?.id ?? null);
    const { noticePercent: _notice, ...limits } = summary.limits;
    return c.json(usageResponse.parse({ ...summary, limits }));
  });
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
