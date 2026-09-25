import {
  actionListQuery,
  actionListResponse,
  actionResponse,
  resolveActionRequest,
} from '@melete/contracts';
import { sql as query } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { actionFromRow } from '../broker/records.ts';
import type { BrokerService } from '../broker/service.ts';
import type { Database } from '../db/client.ts';
import { visibleJob } from '../principals/authority.ts';
import { ServiceError } from './errors.ts';

/**
 * The same ledger read on the owner API, for a conversation's unconfirmed
 * effects, and the owner's answer to one. Both reach only actions on jobs the
 * caller owns, in spaces they can see; a space member never reads or settles
 * another person's ledger through them.
 */
export function mountActions(app: Hono, db: Database, broker?: BrokerService) {
  if (broker)
    app.post('/actions/:actionId/resolve', async (c) => {
      const id = c.req.param('actionId');
      const parsed = resolveActionRequest.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new ServiceError('invalid_request', 'Say whether it happened.', 400);
      // Only the caller's own action: anyone else's reads as not being here at all.
      const own = visibleJob(query`a.job_id`);
      const [found] = await db.execute<{ id: string }>(query`select a.id from action a
        where a.id = ${id} ${own ? query`and ${own}` : query``}`);
      if (!found) throw new ServiceError('not_found', 'Not found.', 404);
      const settled = await broker.resolveByOwner(id, parsed.data);
      if (!settled)
        throw new ServiceError(
          'not_awaiting_reconciliation',
          'This is not waiting for your answer.',
          409,
        );
      return c.json(actionResponse.parse({ action: settled }));
    });
  app.get('/actions', async (c) => {
    const parsed = actionListQuery.safeParse(c.req.query());
    if (!parsed.success) throw new ServiceError('invalid_query', 'Invalid action query', 400);
    const filter = parsed.data;
    const own = visibleJob(query`a.job_id`);
    // Job cancellation is intent, not delivery evidence. Never filter on job.state.
    const rows = await db.execute<Record<string, unknown>>(query`select a.* from action a
      where (${filter.job_id ?? null}::text is null or a.job_id = ${filter.job_id ?? null})
        and (${filter.status ?? null}::text is null or a.status = ${filter.status ?? null})
        and (${filter.effect_class ?? null}::text is null or a.effect_class = ${filter.effect_class ?? null})
        ${own ? query`and ${own}` : query``}
      order by (a.status in ('unknown', 'unresolved')) desc, a.created_at desc, a.id
      limit ${filter.limit}`);
    return c.json(actionListResponse.parse({ actions: [...rows].map(actionFromRow) }));
  });
}

/** The service supplies owner authentication and a selected space; runtime capabilities cannot read here. */
export function createActionReadApi(options: {
  sql: Sql;
  authorizeSpace(request: Request): Promise<string | null>;
}) {
  const app = new Hono();
  app.get('/actions', async (c) => {
    const spaceId = await options.authorizeSpace(c.req.raw);
    if (!spaceId)
      return c.json(
        { error: { code: 'unauthorized', message: 'Owner authorization required' } },
        401,
      );
    const parsed = actionListQuery.safeParse(c.req.query());
    if (!parsed.success)
      return c.json({ error: { code: 'invalid_query', message: 'Invalid action query' } }, 400);
    const query = parsed.data;
    // Job cancellation is intent, not delivery evidence. Never filter on job.state.
    const rows = await options.sql`select a.* from action a join job j on j.id = a.job_id
      where j.space_id = ${spaceId}
        and (${query.job_id ?? null}::text is null or a.job_id = ${query.job_id ?? null})
        and (${query.status ?? null}::text is null or a.status = ${query.status ?? null})
        and (${query.effect_class ?? null}::text is null or a.effect_class = ${query.effect_class ?? null})
      order by (a.status in ('unknown', 'unresolved')) desc, a.created_at desc, a.id
      limit ${query.limit}`;
    return c.json(actionListResponse.parse({ actions: rows.map(actionFromRow) }));
  });
  return app;
}
