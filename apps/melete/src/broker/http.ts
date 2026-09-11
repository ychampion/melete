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
import { ZodError } from 'zod';
import { AuthenticationError, matchesServiceKey, verifyCapability } from './capability.ts';
import { BrokerFault } from './errors.ts';

export interface BrokerOperations {
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
      (c.req.method === 'POST' && path === '/actions');
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
