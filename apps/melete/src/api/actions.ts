import { actionListQuery, actionListResponse } from '@melete/contracts';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { actionFromRow } from '../broker/records.ts';

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
