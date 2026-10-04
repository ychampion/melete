import {
  type Action,
  type ApprovalDecisionRequest,
  approvalDecisionRequest,
  type CapabilityClaims,
  type EffectProposalResponse,
  type ExecutionSettlement,
  executionSettlement,
  type ProposeActionRequest,
  proposeActionRequest,
  type ReactRequest,
  reactRequest,
  type ToolSpec,
} from '@melete/contracts';
import { Hono } from 'hono';
import { ZodError, z } from 'zod';
import { redactSecrets } from '../connectors/faults.ts';
import { ASK_PERSON_TOOL_NAME } from './ask-person.ts';
import { AuthenticationError, matchesServiceKey, verifyCapability } from './capability.ts';
import type { ToolCatalog } from './catalog.ts';
import type { ComposeService } from './compose.ts';
import { BrokerFault, inputProblem } from './errors.ts';
import { RepeatGuard } from './repeats.ts';

export interface BrokerOperations {
  discovery?: ToolCatalog;
  compose?: Pick<ComposeService, 'run'>;
  authorize(claims: CapabilityClaims): Promise<void>;
  requestWait?(claims: CapabilityClaims, input: unknown): Promise<unknown>;
  /** Record a question for the person; the job waits for the answer once the turn ends. */
  askPerson?(claims: CapabilityClaims, input: unknown): Promise<unknown>;
  /** Long work's own tools: its record, helpers, handoffs and finish. */
  runTool?(claims: CapabilityClaims, name: string, input: unknown): Promise<unknown>;
  catalog(claims: CapabilityClaims): Promise<ToolSpec[]>;
  propose(claims: CapabilityClaims, request: ProposeActionRequest): Promise<EffectProposalResponse>;
  get(claims: CapabilityClaims, id: string): Promise<Action>;
  /** A succeeded screenshot's picture, for a runtime whose model reads images, or why it is kept from it. */
  screenshot?(
    claims: CapabilityClaims,
    id: string,
  ): Promise<{ media_type: 'image/png'; data: string } | { withheld: true; reason: string }>;
  /** Carry out an approved action by id; the caller supplies no payload. */
  resume?(claims: CapabilityClaims, id: string): Promise<EffectProposalResponse>;
  /** Send a chase's covered follow-up; the service writes it, the caller supplies nothing. */
  followUp?(claims: CapabilityClaims): Promise<EffectProposalResponse>;
  /** Answer a message with a glyph instead of prose. Changes nothing outside. */
  react(
    claims: CapabilityClaims,
    request: ReactRequest,
  ): Promise<{ message_id: string; emoji: string }>;
  decide(
    id: string,
    request: ApprovalDecisionRequest,
    guard?: undefined,
    decidedBy?: string,
  ): Promise<unknown>;
  startExecution?(claims: CapabilityClaims, id: string): Promise<{ execute: boolean }>;
  settleExecution?(
    claims: CapabilityClaims,
    id: string,
    result: ExecutionSettlement,
  ): Promise<Action>;
  say?(claims: CapabilityClaims, text: string, ref: string): Promise<void>;
}

/** Credentials and identifiers a log line never carries, whatever an error message quoted. */
function redactLogText(text: string): string {
  return redactSecrets(text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]'))
    .replace(/eyJ[\w-]{6,}\.[\w-]{4,}(?:\.[\w-]+)?/g, '[redacted]')
    .replace(/[A-Za-z0-9_+=-]{40,}/g, '[redacted]')
    .replace(/[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[email]');
}

/**
 * One line for an unexpected broker failure: the route, the error's name, code
 * and message, and where it was thrown. Never the request body or headers.
 */
export function brokerFailureLine(method: string, path: string, error: unknown): string {
  const failure = error instanceof Error ? error : new Error(String(error));
  const code = (failure as { code?: unknown }).code;
  const frames = (failure.stack ?? '')
    .split('\n')
    .slice(1, 6)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' < ');
  const text = `broker ${method} ${path} failed: ${failure.name}${
    typeof code === 'string' ? ` ${code}` : ''
  }: ${failure.message.slice(0, 300)}${frames ? ` | ${frames}` : ''}`;
  return `${redactLogText(text.replace(/\s*\n\s*/g, ' '))}\n`;
}

/**
 * What a decision made with the operator's approval key is recorded as. No
 * person answered it, so it names nobody.
 */
export const SERVICE_DECISION = 'service';

export function createBrokerApp(options: {
  broker: BrokerOperations;
  capabilityKey: string;
  approvalKey: string;
}) {
  if (options.approvalKey === options.capabilityKey) {
    throw new Error('approval and attempt signing keys must be distinct');
  }
  const app = new Hono<{ Variables: { claims: CapabilityClaims } }>();
  const repeats = new RepeatGuard();
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
    if (error instanceof ZodError) {
      return c.json({ error: { code: 'payload_invalid', message: inputProblem(error) } }, 400);
    }
    if (error instanceof SyntaxError) {
      return c.json({ error: { code: 'payload_invalid', message: 'Invalid request body' } }, 400);
    }
    // The caller learns only that it failed; the operator learns why.
    process.stderr.write(brokerFailureLine(c.req.method, c.req.path, error));
    return c.json({ error: { code: 'internal_error', message: 'Broker request failed' } }, 500);
  });
  app.use('*', async (c, next) => {
    const path = c.req.path;
    const decision = /^\/actions\/[^/]+\/(approve|deny)$/.test(path) && c.req.method === 'POST';
    const settlement =
      /^\/actions\/[^/]+\/execution\/settle$/.test(path) && c.req.method === 'POST';
    const runtime =
      (c.req.method === 'GET' &&
        (path === '/tools' ||
          /^\/actions\/[^/]+$/.test(path) ||
          (/^\/actions\/[^/]+\/screenshot$/.test(path) && !!options.broker.screenshot))) ||
      (c.req.method === 'POST' &&
        (path === '/actions' ||
          (path === '/attempt/wait' && !!options.broker.requestWait) ||
          path === '/reactions' ||
          path === '/say' ||
          ['/tools/search', '/tools/load', '/tools/call'].includes(path) ||
          (/^\/actions\/[^/]+\/resume$/.test(path) && !!options.broker.resume) ||
          /^\/actions\/[^/]+\/execution\/(start|settle)$/.test(path)));
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
      // A fenced attempt may settle its own already-dispatched command, but
      // the settlement operation still verifies the action and attempt IDs.
      if (!settlement) await options.broker.authorize(claims);
      c.set('claims', claims);
    }
    await next();
  });
  app.post('/attempt/wait', async (c) => {
    if (!options.broker.requestWait) return c.json({ error: { code: 'not_found' } }, 404);
    return c.json(await options.broker.requestWait(c.get('claims'), await c.req.json()));
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
    return c.json(await options.broker.discovery.find(c.get('claims'), body.query));
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
    repeats.note(c.get('claims'), body.name, body.arguments);
    if (body.name === 'chase.follow_up') {
      const claims = c.get('claims');
      const catalog = await options.broker.catalog(claims);
      if (
        !options.broker.followUp ||
        !catalog.some((tool) => tool.name === 'chase.follow_up' && tool.connection_id === null)
      )
        throw new BrokerFault('unknown_tool');
      // Whatever the model passed is dropped: the service writes the follow-up.
      return c.json(await options.broker.followUp(claims));
    }
    if (body.name === ASK_PERSON_TOOL_NAME) {
      if (!options.broker.askPerson) throw new BrokerFault('unknown_tool');
      return c.json(await options.broker.askPerson(c.get('claims'), body.arguments));
    }
    if (body.name.startsWith('run.')) {
      const claims = c.get('claims');
      const catalog = await options.broker.catalog(claims);
      if (
        !options.broker.runTool ||
        !catalog.some((tool) => tool.name === body.name && tool.connection_id === null)
      )
        throw new BrokerFault('unknown_tool');
      return Response.json(await options.broker.runTool(claims, body.name, body.arguments));
    }
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
  app.post('/say', async (c) => {
    const input = z
      .strictObject({ text: z.string().min(1).max(600), ref: z.string().min(1).max(200) })
      .parse(await c.req.json());
    if (!options.broker.say) return c.json({ error: { code: 'not_available' } }, 404);
    await options.broker.say(c.get('claims'), input.text, input.ref);
    return c.json({ status: 'ok' });
  });
  app.post('/actions', async (c) => {
    const request = proposeActionRequest.parse(await c.req.json());
    repeats.note(c.get('claims'), request.kind, {
      connection_id: request.connection_id,
      payload: request.payload,
    });
    return c.json(await options.broker.propose(c.get('claims'), request), 201);
  });
  app.post('/reactions', async (c) =>
    c.json(
      await options.broker.react(c.get('claims'), reactRequest.parse(await c.req.json())),
      201,
    ),
  );
  app.get('/actions/:id', async (c) =>
    c.json({ action: await options.broker.get(c.get('claims'), c.req.param('id')) }),
  );
  app.get('/actions/:id/screenshot', async (c) => {
    if (!options.broker.screenshot) throw new BrokerFault('action_not_found');
    return c.json(await options.broker.screenshot(c.get('claims'), c.req.param('id')));
  });
  app.post('/actions/:id/resume', async (c) => {
    if (!options.broker.resume) throw new BrokerFault('unknown_tool');
    return c.json(await options.broker.resume(c.get('claims'), c.req.param('id')));
  });
  app.post('/actions/:id/execution/start', async (c) => {
    if (!options.broker.startExecution) throw new BrokerFault('unknown_tool');
    return c.json(await options.broker.startExecution(c.get('claims'), c.req.param('id')));
  });
  app.post('/actions/:id/execution/settle', async (c) => {
    if (!options.broker.settleExecution) throw new BrokerFault('unknown_tool');
    return c.json({
      action: await options.broker.settleExecution(
        c.get('claims'),
        c.req.param('id'),
        executionSettlement.parse(await c.req.json()),
      ),
    });
  });
  for (const [verb, decision] of [
    ['approve', 'approved'],
    ['deny', 'denied'],
  ] as const) {
    app.post(`/actions/:id/${verb}`, async (c) => {
      const body = approvalDecisionRequest.parse({ ...(await c.req.json()), decision });
      return c.json(
        await options.broker.decide(c.req.param('id'), body, undefined, SERVICE_DECISION),
      );
    });
  }
  return app;
}
