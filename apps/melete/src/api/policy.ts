import { connectionLifecycle, policyChange } from '@melete/contracts';
import type { Hono } from 'hono';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { PolicyService } from '../jobs/policy.ts';

export function mountPolicy(app: Hono, policy: PolicyService, registry?: ConnectorRegistry) {
  app.post('/connections/:id/lifecycle', async (c) => {
    const id = c.req.param('id');
    const changed = await policy.changeConnection(
      id,
      connectionLifecycle.parse(await c.req.json()),
    );
    // A connector that runs something of its own, such as a server's container, leaves the
    // registry with the revocation, which stops it; what was kept for the connection is
    // released even when no connector was serving it.
    if (changed.status === 'revoked' && registry)
      await registry
        .release(id, (connector) => Boolean(connector.retire))
        .catch(() =>
          process.stderr.write('a revoked connection could not release its connector\n'),
        );
    return c.json(changed);
  });
  app.post('/spaces/:id/policy-generation', async (c) => {
    const input = policyChange.parse(await c.req.json());
    return c.json(await policy.changePolicy(c.req.param('id'), input.expected_generation));
  });
}
