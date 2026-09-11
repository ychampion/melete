import {
  type Action,
  type ApprovalDecisionRequest,
  approvalDecisionRequest,
  type CapabilityClaims,
  type EffectProposalResponse,
  type ProposeActionRequest,
  proposeActionRequest,
  type ToolSpec,
} from '@melete/contracts';
import { Hono } from 'hono';
import { ZodError, z } from 'zod';
import { AuthenticationError, matchesServiceKey, verifyCapability } from './capability.ts';
import type { ToolCatalog } from './catalog.ts';
import type { ComposeService } from './compose.ts';
import { BrokerFault } from './errors.ts';

export interface BrokerOperations {
  discovery?: ToolCatalog;
  compose?: Pick<ComposeService, 'run'>;
  authorize(claims: CapabilityClaims): Promise<void>;
  catalog(claims: CapabilityClaims): Promise<ToolSpec[]>;
  propose(claims: CapabilityClaims, request: ProposeActionRequest): Promise<EffectProposalResponse>;
  get(claims: CapabilityClaims, id: string): Promise<Action>;
  decide(id: string, request: ApprovalDecisionRequest): Promise<unknown>;
}

export function createBrokerApp(options: {
  broker: BrokerOperations;
  capabilityKey: string;
  approvalKey: string;
}) {
  if (options.approvalKey === options.capabilityKey) {
    throw new Error('approval and attempt signing keys must be distinct');
  }
  const app = new Hono<{ Variables: { claims: CapabilityClaims } }>();
  app.onError((error, c) => {
    if (error instanceof AuthenticationError) {
      return c.json({ error: { code: 'unauthorized', message: error.message } }, 401);
    }
    if (error instanceof BrokerFault) {
      const status =
        error.code === 'action_not_found'
          ? 404
          : ['stale_epoch', 'scope_denied', 'revision_mismatch'].includes(error.code)
            ? 403
            : 409;
      return c.json({ error: { code: error.code, message: error.message } }, status);
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return c.json({ error: { code: 'payload_invalid', message: 'Invalid request body' } }, 400);
    }
    return c.json({ error: { code: 'internal_error', message: 'Broker request failed' } }, 500);
  });
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const decision = /^\/actions\/[^/]+\/(approve|deny)$/.test(path) && c.req.method === 'POST';
    const runtime =
      (c.req.method === 'GET' && (path === '/tools' || /^\/actions\/[^/]+$/.test(path))) ||
      (c.req.method === 'POST' &&
        ['/actions', '/tools/search', '/tools/load', '/tools/call'].includes(path));
    if (!decision && !runtime) return c.json({ error: { code: 'not_found' } }, 404);
    if (Number(c.req.header('content-length') ?? '0') > 1_048_576) {
      return c.json({ error: { code: 'payload_invalid' } }, 413);
    }
    if (decision) {
      if (!matchesServiceKey(c.req.header('authorization'), options.approvalKey)) {
        throw new AuthenticationError('API approval credential required');
      }
    } else {
      const header = c.req.header('authorization');
      if (!header?.startsWith('Bearer '))
        throw new AuthenticationError('attempt capability required');
      const claims = verifyCapability(header.slice(7), options.capabilityKey);
      await options.broker.authorize(claims);
      c.set('claims', claims);
    }
    await next();
  });
  app.get('/tools', async (c) => {
    const tools = await options.broker.catalog(c.get('claims'));
    tools.sort((a, b) =>
      a.name < b.name
        ? -1
        : a.name > b.name
          ? 1
          : (a.connection_id ?? '').localeCompare(b.connection_id ?? '', 'en'),
    );
    return c.json({ tools });
  });
  app.post('/tools/search', async (c) => {
    const body = z
      .object({ query: z.string() })
      .strict()
      .parse(await c.req.json());
    if (!options.broker.discovery) throw new BrokerFault('unknown_tool');
    return c.json({ tools: await options.broker.discovery.search(c.get('claims'), body.query) });
  });
  app.post('/tools/load', async (c) => {
    const body = z
      .object({ name: z.string() })
      .strict()
      .parse(await c.req.json());
    if (!options.broker.discovery) throw new BrokerFault('unknown_tool');
    return c.json(await options.broker.discovery.load(c.get('claims'), body.name));
  });
  app.post('/tools/call', async (c) => {
    const body = z
      .object({ name: z.string(), arguments: z.record(z.string(), z.json()) })
      .strict()
      .parse(await c.req.json());
    if (!options.broker.discovery) throw new BrokerFault('unknown_tool');
    if (body.name === 'compose') {
      const claims = c.get('claims');
      const catalog = await options.broker.catalog(claims);
      if (
        !options.broker.compose ||
        !catalog.some((tool) => tool.name === 'compose' && tool.connection_id === null)
      ) {
        throw new BrokerFault('unknown_tool');
      }
      // Avoid Hono recursively expanding the arbitrary JSON result type.
      return Response.json(await options.broker.compose.run(claims, body.arguments));
    }
    return c.json(
      await options.broker.discovery.callSkill(c.get('claims'), body.name, body.arguments),
    );
  });
  app.post('/actions', async (c) =>
    c.json(
      await options.broker.propose(c.get('claims'), proposeActionRequest.parse(await c.req.json())),
      201,
    ),
  );
  app.get('/actions/:id', async (c) =>
    c.json({ action: await options.broker.get(c.get('claims'), c.req.param('id')) }),
  );
  for (const [verb, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    app.post(`/actions/:id/${verb}`, async (c) => {
      const body = approvalDecisionRequest.parse({ ...(await c.req.json()), decision });
      return c.json(await options.broker.decide(c.req.param('id'), body));
    });
  }
  return app;
}

/** Bind explicitly to loopback locally, or the internal interface in the container. */
export function serveBroker(
  app: ReturnType<typeof createBrokerApp>,
  hostname = '127.0.0.1',
  port = 3112,
) {
  return Bun.serve({ hostname, port, maxRequestBodySize: 1_048_576, fetch: app.fetch });
}
