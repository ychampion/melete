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
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { type LimitStore, PostgresLimitStore, WindowLimiter } from '../ops/limiter.ts';
import { principalContext } from '../principals/authority.ts';
import { resolveSessionSpace, selectedSpace } from '../principals/session-space.ts';
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
  /** Where the limits are counted. Left out, in Postgres, so every instance shares them. */
  limits?: LimitStore;
};

/**
 * The key consent forms are signed with. Every instance that holds the master
 * key derives the same one, so a form shown by one instance is accepted by
 * another, and by the same service after a restart. Without a master key it
 * lives as long as the process.
 */
export function consentKey(masterKey: string | undefined): Buffer {
  return masterKey
    ? Buffer.from(hkdfSync('sha256', masterKey, 'melete', 'mcp consent v1', 32))
    : randomBytes(32);
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
/** What `signedIn` answers for a guest account, which never connects an assistant. */
const GUEST = Symbol('guest');
function guestRefused(c: Context) {
  return page(
    c,
    'Cannot connect',
    '<h1>Cannot connect</h1><p>A guest account uses only the rooms it was invited to, and cannot connect an assistant.</p>',
    undefined,
    403,
  );
}

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

/** Tool calls one connection may make in a minute. */
export const TOOL_CALLS_PER_MINUTE = 60;

/** Who the consent page says is asking: a checked host, or a name nobody has checked. */
function whoIsAsking(client: McpClientRecord) {
  return client.verifiedHost
    ? `<p>Melete checked that this assistant is published at <strong>${escapeHtml(client.verifiedHost)}</strong>.</p>`
    : `<p><strong>Unverified:</strong> &ldquo;${escapeHtml(client.name)}&rdquo; is the name this assistant gave itself. Melete has not checked who runs it.</p>`;
}

/** What the server's own paths answer while it is off, instead of a generic not-found. */
export const MCP_SERVER_OFF =
  "Melete's MCP server is not enabled on this service. Set MELETE_PUBLIC_URL to the address assistants reach this service at, then restart it.";
const MCP_SERVER_PATHS = [
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/*',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
  '/mcp',
  '/mcp/clients',
  '/mcp/clients/*',
];

export function mountMcpServer(app: Hono, deps: McpServerDeps) {
  const addresses = mcpServerAddresses(deps.env.MELETE_PUBLIC_URL);
  // Without a public address no assistant could reach the endpoint or return
  // from consent, so the server stays off and its paths say so. The person's
  // own list of assistants still answers, empty: none can be connected.
  if (!addresses) {
    app.get('/mcp/clients', (c) => c.json({ clients: [] }));
    for (const path of MCP_SERVER_PATHS)
      app.all(path, (c) =>
        c.json({ error: { code: 'not_enabled', message: MCP_SERVER_OFF } }, 404),
      );
    return;
  }
  const store = new OAuthStore(deps.sql, addresses, deps.oauth);
  const effects =
    deps.broker && deps.registry
      ? new ExperienceEffects(deps.sql, deps.broker, deps.registry)
      : undefined;
  const sendConnection = spaceSendConnection({ sql: deps.sql });
  const formKey = consentKey(deps.env.MELETE_MASTER_KEY);
  // Small fixed windows per client address, for the endpoints anyone can call.
  const limits = deps.limits ?? new PostgresLimitStore(deps.sql);
  const registrations = new WindowLimiter(limits, 'mcp.register', 20, 60 * 60_000);
  const tokenRequests = new WindowLimiter(limits, 'mcp.token', 120, 60_000);
  // Each authorization request may read a metadata document from the internet.
  const authorizeRequests = new WindowLimiter(limits, 'mcp.authorize', 30, 60_000);
  // Per connection: every tool call runs as the person, and some start work.
  const toolCalls = new WindowLimiter(limits, 'mcp.tool_call', TOOL_CALLS_PER_MINUTE, 60_000);

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
    if (!(await registrations.allow(clientAddress(c))))
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
    // An error goes back to the client only where a redirect cannot be used to
    // send someone elsewhere; anywhere else it is shown here instead.
    const back = async (error: string, description: string): Promise<AuthorizeRead> => {
      if (!(await store.trustedReturn(client, redirectUri)))
        return {
          kind: 'refused',
          message: `This assistant's request was not accepted: ${description}`,
        };
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

  /** Binds a consent form to the session, the space it names, and the exact request it shows. */
  const consentTag = (sessionToken: string, spaceId: string, request: AuthorizeRequest) =>
    createHmac('sha256', formKey)
      .update(
        JSON.stringify([
          sessionToken,
          spaceId,
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
    if (!active || !token) return undefined;
    // An assistant acts as a person in a space of theirs. A guest has neither:
    // they use only the rooms they were invited to.
    if (active.owner.kind !== 'person') return GUEST;
    // The space the grant will act in: the one this session has selected.
    const space = await resolveSessionSpace(
      deps.db,
      deps.env.MELETE_SPACES_DIR,
      active.owner.id,
      active.spaceId ? { spaceId: active.spaceId, generation: active.membershipGeneration } : null,
    );
    const [named] = await deps.sql`select name from space where id = ${space.spaceId}`;
    return { token, active, space, spaceName: String(named?.name ?? 'Personal') };
  };

  const consentPage = (
    c: Context,
    request: AuthorizeRequest,
    client: McpClientRecord,
    session: Exclude<Awaited<ReturnType<typeof signedIn>>, undefined | typeof GUEST>,
    tag: string,
  ) => {
    const returnHost = new URL(request.redirectUri).host;
    const where =
      session.space.kind === 'shared'
        ? `in the shared space <strong>${escapeHtml(session.spaceName)}</strong>, which other people use too`
        : `in your own space, <strong>${escapeHtml(session.spaceName)}</strong>`;
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
${whoIsAsking(client)}
<p>Signed in as <strong>${escapeHtml(session.active.owner.email)}</strong>. If you agree, this assistant can, as you, ${where}:</p>
<ul><li>see what companies owe you, and ask Melete to chase one: you approve its first message here in Melete, and it follows up within the limits you set;</li>
<li>ask Melete to send an email, which waits for you to approve the exact text here in Melete;</li>
<li>save and look up details you tell it;</li>
<li>see where those jobs stand.</li></ul>
<p>When you answer, you go back to <strong>${escapeHtml(returnHost)}</strong>. Continue only if that is where you started.</p>
<p class="muted">Every email it proposes waits for your approval. You can disconnect it at any time in Melete, under Settings, Connections.</p>
<form method="post" action="${escapeHtml(addresses.authorize)}">${hidden}
<button class="allow" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button></form>`,
      new URL(request.redirectUri).origin,
    );
  };

  const tooMany = (c: Context) => {
    c.header('Retry-After', '60');
    return page(
      c,
      'Try again shortly',
      '<h1>Too many requests</h1><p>Wait a minute, then start connecting again from your assistant.</p>',
      undefined,
      429,
    );
  };

  app.get('/oauth/authorize', async (c) => {
    if (!(await authorizeRequests.allow(clientAddress(c)))) return tooMany(c);
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
    if (session === GUEST) return guestRefused(c);
    if (!session)
      return page(
        c,
        'Sign in to Melete',
        `<h1>Sign in to Melete first</h1>${whoIsAsking(read.client)}<p>This assistant wants to use Melete as you. <a href="${escapeHtml(addresses.origin)}/" target="_blank" rel="noopener">Sign in to Melete</a> in this browser, then <a href="">continue here</a>.</p>`,
      );
    return consentPage(
      c,
      read.request,
      read.client,
      session,
      consentTag(session.token, session.space.spaceId, read.request),
    );
  });

  app.post('/oauth/authorize', async (c) => {
    if (!(await authorizeRequests.allow(clientAddress(c)))) return tooMany(c);
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
    if (session === GUEST) return guestRefused(c);
    // A session that has since moved to another space was not shown this one.
    const expected = session ? consentTag(session.token, session.space.spaceId, read.request) : '';
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
    const { space } = session;
    await store.recordClient(read.client);
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
    if (!(await tokenRequests.allow(clientAddress(c))))
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
    // The token acts in the space the person agreed from, under the membership
    // they had then. Once that no longer holds, the whole sign-in ends; a later
    // invitation back does not revive it.
    const space = await selectedSpace(deps.db, grant.principalId, {
      spaceId: grant.spaceId,
      generation: grant.membershipGeneration,
    });
    if (!space) {
      await store.revokeFamily(grant.family);
      return unauthorized(c, true);
    }
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
        if (!(await toolCalls.allow(grant.family))) {
          c.header('Retry-After', '60');
          return c.json(
            rpcError(id, -32000, 'Too many tool calls from this assistant. Wait a minute.'),
            429,
          );
        }
        const actor: McpActor = {
          principalId: grant.principalId,
          spaceId: space.spaceId,
          membershipGeneration: grant.membershipGeneration,
          clientId: grant.clientId,
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
                        const proposed = await effects.proposeSend({
                          ...input,
                          membershipGeneration: actor.membershipGeneration,
                          assistantClientId: actor.clientId,
                        });
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
