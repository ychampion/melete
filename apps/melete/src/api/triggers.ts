import { trigger as triggerContract, triggerSpec } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import { eventDelivery, type TriggerService } from '../jobs/triggers.ts';
import { spaceAuthority } from '../principals/authority.ts';
import { ServiceError } from './errors.ts';

export function mountTriggers(app: Hono, triggers: TriggerService, db: Database | null): void {
  app.post('/jobs/:id/triggers', async (c) => {
    const input = triggerSpec.parse(await c.req.json());
    const row = await triggers.create(c.req.param('id'), input);
    return c.json(
      {
        trigger: triggerContract.parse({
          id: row.id,
          job_id: row.jobId,
          kind: row.kind,
          spec: row.spec,
          cursor: row.cursor,
          enabled: row.enabled,
          created_at: row.createdAt.toISOString(),
        }),
      },
      201,
    );
  });
  /**
   * An event from a connection, as the connection's own poller would record
   * it. Only the owner of the connection's space may deliver one, so nobody,
   * the setup owner included, can put events into another account's feed.
   */
  app.post('/internal/events/deliver', async (c) => {
    const input = eventDelivery.parse(await c.req.json());
    if (!db) throw new ServiceError('database_unavailable', 'Configure Postgres.', 503);
    const [row] = await db
      .select({ spaceId: connection.spaceId })
      .from(connection)
      .where(eq(connection.id, input.connection_id));
    const access = row
      ? await spaceAuthority(db, row.spaceId, c.get('owner').id).catch((error: unknown) => {
          if (error instanceof ServiceError) return null;
          throw error;
        })
      : null;
    if (access?.role !== 'owner')
      throw new ServiceError('scope_denied', 'Connection is not accessible.', 403);
    return c.json(await triggers.deliver(input), 202);
  });
}
