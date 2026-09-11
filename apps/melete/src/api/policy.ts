import { connectionLifecycle, policyChange } from '@melete/contracts';
import type { Hono } from 'hono';
import type { PolicyService } from '../jobs/policy.ts';

export function mountPolicy(app: Hono, policy: PolicyService) {
  app.post('/connections/:id/lifecycle', async (c) =>
    c.json(
      await policy.changeConnection(
        c.req.param('id'),
        connectionLifecycle.parse(await c.req.json()),
      ),
    ),
  );
  app.post('/spaces/:id/policy-generation', async (c) => {
    const input = policyChange.parse(await c.req.json());
    return c.json(await policy.changePolicy(c.req.param('id'), input.expected_generation));
  });
}
