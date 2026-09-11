import { trigger as triggerContract, triggerSpec } from '@melete/contracts';
import type { Hono } from 'hono';
import { eventDelivery, type TriggerService } from '../jobs/triggers.ts';

export function mountTriggers(app: Hono, triggers: TriggerService): void {
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
  app.post('/internal/events/deliver', async (c) => {
    const input = eventDelivery.parse(await c.req.json());
    return c.json(await triggers.deliver(input), 202);
  });
}
