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
    // A connector that owns something running, such as a server's container, stops with the
    // revocation rather than at its next idle check, and releases what it kept.
    const connector = registry?.get(id);
    if (changed.status === 'revoked' && registry && connector?.retire) {
      await registry.remove(id, connector).catch(() => {});
      await connector
        .retire()
        .catch(() => process.stderr.write('a revoked connection could not release its server\n'));
    }
    return c.json(changed);
  });
  app.post('/spaces/:id/policy-generation', async (c) => {
    const input = policyChange.parse(await c.req.json());
    return c.json(await policy.changePolicy(c.req.param('id'), input.expected_generation));
  });
}
