/**
 * Melete's MCP endpoint and the OAuth routes that let an assistant reach it.
 *
 * Public, on the owner API: the two discovery documents, registration, the
 * token and revocation endpoints, and `/mcp` itself, which answers only a
 * bearer token. The consent page is public too, because it decides for itself
 * whether a person is signed in; it grants nothing to a request without a
 * session. A signed-in person can list and disconnect the assistants they let
 * in with `/mcp/clients`.
 *
 * The MCP endpoint is stateless streamable HTTP: every request is one JSON-RPC
 * message answered with one JSON body, so there is no session to hijack and
 * nothing is streamed.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { Sql } from 'postgres';
import { activeSession, SESSION_COOKIE } from '../api/auth.ts';
import { ServiceError } from '../api/errors.ts';
import type { BrokerService } from '../broker/service.ts';
import { spaceSendConnection } from '../companies/service.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Database } from '../db/client.ts';
import type { Env } from '../env.ts';
import { ExperienceEffects } from '../experience/effects.ts';
import { principalContext } from '../principals/authority.ts';
import { resolveSessionSpace } from '../principals/session-space.ts';
import { actorEnvironment, type McpActor } from './actor.ts';
import {
  authorizationServerMetadata,
  MCP_SCOPE,
  type McpClientRecord,
  mcpServerAddresses,
  OAuthError,
  OAuthStore,
  type OAuthStoreOptions,
  protectedResourceMetadata,
} from './oauth.ts';
import { callTool, TOOL_DEFINITIONS, UnknownTool } from './tools.ts';

/** The versions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SERVER_INFO = { name: 'melete', title: 'Melete', version: '0.1.0' };
const INSTRUCTIONS =
  "Melete is the person's own assistant for money owed to them and the messages that chase it. " +
  'Use waiting_on to see what companies owe them, handle to have Melete chase one, and status to ' +
  'follow it. safe_send never sends by itself: the person approves the exact text in Melete first. ' +
  'remember and recall read and write only the details the person states.';

export type McpServerDeps = {
  db: Database;
  sql: Sql;
  env: Env;
  broker?: BrokerService;
  registry?: ConnectorRegistry;
  oauth?: OAuthStoreOptions;
};

/** A small fixed-window limit per client address, for the endpoints anyone can call. */
function limiter(limit: number, windowMs: number) {
  const seen = new Map<string, { count: number; until: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const entry = seen.get(key);
    if (!entry || entry.until <= now) {
      if (seen.size > 10_000) seen.clear();
      seen.set(key, { count: 1, until: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

const clientAddress = (c: Context) => {
  const source = c.env as { clientAddress?: string; remoteAddress?: string } | undefined;
  return source?.clientAddress ?? source?.remoteAddress ?? 'unknown';
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character,
  );

/** The one page this service renders: plain, framed by nobody, submitting only to itself and the client. */
function page(c: Context, title: string, body: string, formTarget?: string, status = 200) {
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header(
    'Content-Security-Policy',
    `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${formTarget ? ` ${formTarget}` : ''}`,
  );
  return c.body(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1b18;background:#faf8f5}h1{font-size:1.4rem}ul{padding-left:1.2rem}button{font:inherit;padding:.6rem 1.2rem;margin-right:.6rem;border-radius:.5rem;border:1px solid #1d1b18;background:#fff;cursor:pointer}button.allow{background:#1d1b18;color:#fff}.muted{color:#6b665e;font-size:.9rem}@media(prefers-color-scheme:dark){body{background:#171614;color:#ece8e1}button{background:#232120;color:#ece8e1;border-color:#ece8e1}button.allow{background:#ece8e1;color:#171614}.muted{color:#a39d93}}</style></head><body>${body}</body></html>`,
    status as 200,
  );
}

/** The parameters of one authorization request, as a client sent them. */
type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
  resource: string;
};

type AuthorizeRead =
  | { kind: 'refused'; message: string }
  | { kind: 'back'; url: string }
  | { kind: 'ok'; request: AuthorizeRequest; client: McpClientRecord };

export function mountMcpServer(app: Hono, deps: McpServerDeps) {
  const addresses = mcpServerAddresses(deps.env.MELETE_PUBLIC_URL);
  // Without a public address no assistant could reach the endpoint or return from consent.
  if (!addresses) return;
  const store = new OAuthStore(deps.sql, addresses, deps.oauth);
  const effects =
    deps.broker && deps.registry
      ? new ExperienceEffects(deps.sql, deps.broker, deps.registry)
      : undefined;
  const sendConnection = spaceSendConnection({ sql: deps.sql });
  const consentKey = randomBytes(32);
  const registrations = limiter(20, 60 * 60_000);
  const tokenRequests = limiter(120, 60_000);

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json(authorizationServerMetadata(addresses)),
  );
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/api/mcp',
  ])
    app.get(path, (c) => c.json(protectedResourceMetadata(addresses)));

  const oauthError = (c: Context, error: OAuthError) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: error.code, error_description: error.description }, error.status as 400);
  };

  app.post('/oauth/register', async (c) => {
    if (!registrations(clientAddress(c)))
      return oauthError(c, new OAuthError('temporarily_unavailable', 'Try again later.', 429));
    try {
      return c.json(await store.register(await c.req.json().catch(() => null)), 201);
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  /** Checks the client and its redirect first: only then may an error go back to the client. */
  const readAuthorize = async (
    values: Record<string, string | undefined>,
  ): Promise<AuthorizeRead> => {
    const clientId = values.client_id ?? '';
    const client = clientId ? await store.client(clientId) : undefined;
    const redirectUri = values.redirect_uri ?? '';
    if (!client?.redirectUris.includes(redirectUri))
      return {
        kind: 'refused',
        message:
          'This assistant is not registered with this Melete, or its return address does not match.',
      };
    const back = (error: string, description: string): AuthorizeRead => {
      const url = new URL(redirectUri);
      url.searchParams.set('error', error);
      url.searchParams.set('error_description', description);
      if (values.state) url.searchParams.set('state', values.state);
      url.searchParams.set('iss', addresses.issuer);
      return { kind: 'back', url: url.toString() };
    };
    if (values.response_type !== 'code')
      return back('unsupported_response_type', 'Only the code response is offered.');
    if (
      values.code_challenge_method !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/.test(values.code_challenge ?? '')
    )
      return back('invalid_request', 'A PKCE S256 code challenge is required.');
    const scope = (values.scope ?? MCP_SCOPE).split(' ').filter(Boolean);
    if (scope.some((item) => item !== MCP_SCOPE))
      return back('invalid_scope', `The only scope is ${MCP_SCOPE}.`);
    const resource = values.resource ?? addresses.resource;
    if (resource.replace(/\/$/, '') !== addresses.resource)
      return back('invalid_target', 'This server grants access to its own MCP endpoint only.');
    const request: AuthorizeRequest = {
      clientId,
      redirectUri,
      state: values.state,
      codeChallenge: values.code_challenge ?? '',
      scope: MCP_SCOPE,
      resource: addresses.resource,
    };
    return { kind: 'ok', request, client };
  };

  /** Binds a consent form to the session and the exact request it shows. */
  const consentTag = (sessionToken: string, request: AuthorizeRequest) =>
    createHmac('sha256', consentKey)
      .update(
        JSON.stringify([
          sessionToken,
          request.clientId,
          request.redirectUri,
          request.state ?? '',
          request.codeChallenge,
          request.scope,
          request.resource,
        ]),
      )
      .digest('base64url');

  const signedIn = async (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    const active = token ? await activeSession(deps.db, token) : undefined;
    return active && token ? { token, active } : undefined;
  };

  const consentPage = (
    c: Context,
    request: AuthorizeRequest,
    client: McpClientRecord,
    email: string,
    tag: string,
  ) => {
    const returnHost = new URL(request.redirectUri).host;
    const hidden = Object.entries({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state ?? '',
      code_challenge: request.codeChallenge,
      code_challenge_method: 'S256',
      response_type: 'code',
      scope: request.scope,
      resource: request.resource,
      consent: tag,
    })
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join('');
    return page(
      c,
      'Connect an assistant to Melete',
      `<h1>Let ${escapeHtml(client.name)} use Melete?</h1>
<p>Signed in as <strong>${escapeHtml(email)}</strong>. If you agree, ${escapeHtml(client.name)} can, as you:</p>
<ul><li>see what companies owe you, and ask Melete to chase one;</li>
<li>ask Melete to send an email, which waits for you to approve the exact text here in Melete;</li>
<li>save and look up details you tell it;</li>
<li>see where those jobs stand.</li></ul>
<p class="muted">It cannot send anything without your approval, and you can disconnect it at any time. You will return to ${escapeHtml(returnHost)}.</p>
<form method="post" action="${escapeHtml(addresses.authorize)}">${hidden}
<button class="allow" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></form>`,
      new URL(request.redirectUri).origin,
    );
  };

  app.get('/oauth/authorize', async (c) => {
    const read = await readAuthorize(c.req.query());
    if (read.kind === 'refused')
      return page(
        c,
        'Cannot connect',
        `<h1>Cannot connect</h1><p>${escapeHtml(read.message)}</p>`,
        undefined,
        400,
      );
    if (read.kind === 'back') return c.redirect(read.url, 302);
    const session = await signedIn(c);
    if (!session)
      return page(
        c,
        'Sign in to Melete',
        `<h1>Sign in to Melete first</h1><p>${escapeHtml(read.client.name)} wants to use Melete as you. <a href="${escapeHtml(addresses.origin)}/" target="_blank" rel="noopener">Sign in to Melete</a> in this browser, then <a href="">continue here</a>.</p>`,
      );
    return consentPage(
      c,
      read.request,
      read.client,
      session.active.owner.email,
      consentTag(session.token, read.request),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string | undefined>;
    const read = await readAuthorize(form);
    if (read.kind === 'refused')
      return page(
        c,
        'Cannot connect',
        `<h1>Cannot connect</h1><p>${escapeHtml(read.message)}</p>`,
        undefined,
        400,
      );
    if (read.kind === 'back') return c.redirect(read.url, 302);
    const session = await signedIn(c);
    const expected = session ? consentTag(session.token, read.request) : '';
    const given = form.consent ?? '';
    // Only the page shown to this session, for this very request, can say yes.
    if (
      !session ||
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    )
      return page(
        c,
        'Cannot connect',
        '<h1>This page has expired</h1><p>Start connecting again from your assistant.</p>',
        undefined,
        403,
      );
    const back = new URL(read.request.redirectUri);
    if (read.request.state) back.searchParams.set('state', read.request.state);
    back.searchParams.set('iss', addresses.issuer);
    if (form.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied');
      return c.redirect(back.toString(), 302);
    }
    const principalId = session.active.owner.id;
    const space = await resolveSessionSpace(
      deps.db,
      deps.env.MELETE_SPACES_DIR,
      principalId,
      session.active.spaceId
        ? { spaceId: session.active.spaceId, generation: session.active.membershipGeneration }
        : null,
    );
    const code = await store.issueCode({
      clientId: read.request.clientId,
      principalId,
      spaceId: space.spaceId,
      membershipGeneration: space.generation,
      resource: read.request.resource,
      scope: read.request.scope,
      redirectUri: read.request.redirectUri,
      codeChallenge: read.request.codeChallenge,
    });
    back.searchParams.set('code', code);
    return c.redirect(back.toString(), 302);
  });

  const form = async (c: Context) => {
    const type = c.req.header('Content-Type')?.split(';')[0]?.trim();
    if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data')
      return (await c.req.parseBody()) as Record<string, string | undefined>;
    if (type === 'application/json')
      return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, string | undefined>;
    return {} as Record<string, string | undefined>;
  };

  app.post('/oauth/token', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    if (!tokenRequests(clientAddress(c)))
      return oauthError(c, new OAuthError('temporarily_unavailable', 'Try again later.', 429));
    const body = await form(c);
    try {
      const clientId = body.client_id ?? '';
      if (!clientId || !(await store.clientName(clientId)))
        throw new OAuthError('invalid_client', 'The client is not registered.', 401);
      if (body.grant_type === 'authorization_code')
        return c.json(
          await store.exchangeCode({
            code: body.code ?? '',
            clientId,
            redirectUri: body.redirect_uri ?? '',
            verifier: body.code_verifier ?? '',
            ...(body.resource ? { resource: body.resource.replace(/\/$/, '') } : {}),
          }),
        );
      if (body.grant_type === 'refresh_token')
        return c.json(
          await store.refresh({
            refreshToken: body.refresh_token ?? '',
            clientId,
            ...(body.resource ? { resource: body.resource.replace(/\/$/, '') } : {}),
          }),
        );
      throw new OAuthError('unsupported_grant_type', 'Use the code or refresh grant.');
    } catch (error) {
      if (error instanceof OAuthError) return oauthError(c, error);
      throw error;
    }
  });

  app.post('/oauth/revoke', async (c) => {
    const body = await form(c);
    if (body.token) await store.revoke(body.token);
    // RFC 7009: an unknown token is answered like a revoked one.
    return c.body(null, 200);
  });

  // The person's own list of assistants, behind their session like the rest of the API.
  app.get('/mcp/clients', async (c) =>
    c.json({ clients: await store.connected(c.get('owner').id) }),
  );
  app.delete('/mcp/clients/:clientId', async (c) => {
    if (!(await store.disconnect(c.get('owner').id, c.req.param('clientId'))))
      throw new ServiceError('not_found', 'Not found.', 404);
    return c.body(null, 204);
  });

  const unauthorized = (c: Context, invalid: boolean) => {
    c.header(
      'WWW-Authenticate',
      `Bearer resource_metadata="${addresses.resourceMetadata}", scope="${MCP_SCOPE}"${invalid ? ', error="invalid_token"' : ''}`,
    );
    return c.json(
      {
        error: {
          code: 'unauthorized',
          message: 'Connect this assistant to Melete to use its tools.',
        },
      },
      401,
    );
  };

  const rpcError = (id: unknown, code: number, message: string) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  });

  for (const method of ['GET', 'DELETE'] as const)
    app.on(method, '/mcp', (c) => {
      c.header('Allow', 'POST');
      return c.json(
        rpcError(
          null,
          -32000,
          'This server answers POST only; it holds no session to stream or end.',
        ),
        405,
      );
    });

  app.post('/mcp', async (c) => {
    // Read before anything is answered: a reply that leaves the body unread
    // leaves its bytes on a kept-alive connection through the web proxy, and
    // the client's next request there (its discovery, after a 401) fails.
    const raw = await c.req.text();
    const header = c.req.header('Authorization') ?? '';
    const token = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header)?.[1];
    const grant = token ? await store.authenticate(token) : undefined;
    if (!grant) return unauthorized(c, Boolean(token));
    const version = c.req.header('MCP-Protocol-Version');
    if (version && !MCP_PROTOCOL_VERSIONS.includes(version))
      return c.json(rpcError(null, -32600, 'Unsupported MCP protocol version.'), 400);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const message = parsed as
      | { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> }
      | undefined;
    if (
      !message ||
      typeof message !== 'object' ||
      Array.isArray(message) ||
      message.jsonrpc !== '2.0'
    )
      return c.json(rpcError(null, -32600, 'Send one JSON-RPC 2.0 message.'), 400);
    // A notification or a response from the client needs nothing back.
    if (message.id === undefined || typeof message.method !== 'string') return c.body(null, 202);
    const { id } = message;
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && MCP_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : MCP_PROTOCOL_VERSIONS[0];
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        });
      }
      case 'ping':
        return c.json({ jsonrpc: '2.0', id, result: {} });
      case 'tools/list':
        return c.json({ jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } });
      case 'tools/call': {
        const name = message.params?.name;
        if (typeof name !== 'string') return c.json(rpcError(id, -32602, 'Name a tool.'));
        const actor: McpActor = {
          principalId: grant.principalId,
          spaceId: grant.spaceId,
          membershipGeneration: grant.membershipGeneration,
          clientName: (await store.clientName(grant.clientId)) ?? 'An assistant',
        };
        try {
          const result = await principalContext.run(actor.principalId, () =>
            callTool(
              {
                actor,
                route: async (routeMethod, path, body) => {
                  const response = await app.request(
                    path,
                    {
                      method: routeMethod,
                      ...(body === undefined
                        ? {}
                        : {
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(body),
                          }),
                    },
                    actorEnvironment(actor),
                  );
                  const text = await response.text();
                  let parsed: unknown = null;
                  try {
                    parsed = text ? JSON.parse(text) : null;
                  } catch {
                    parsed = null;
                  }
                  return { status: response.status, body: parsed };
                },
                sendConnection: (spaceId) =>
                  sendConnection({ spaceId, principalId: actor.principalId }),
                ...(effects
                  ? {
                      proposeSend: async (input) => {
                        const proposed = await effects.proposeSend(input);
                        return 'reason' in proposed
                          ? { reason: proposed.reason }
                          : { id: proposed.id, job_id: proposed.job_id, status: proposed.status };
                      },
                    }
                  : {}),
              },
              name,
              message.params?.arguments,
            ),
          );
          return c.json({ jsonrpc: '2.0', id, result });
        } catch (error) {
          if (error instanceof UnknownTool)
            return c.json(rpcError(id, -32602, `Unknown tool: ${error.tool}`));
          throw error;
        }
      }
      default:
        return c.json(rpcError(id, -32601, 'Method not found.'));
    }
  });
}
