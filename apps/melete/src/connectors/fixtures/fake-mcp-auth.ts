/**
 * A loopback MCP server with its own authorization server, for tests only. It
 * answers the way the MCP authorization specification describes: a 401 with a
 * `WWW-Authenticate` challenge, protected resource metadata, authorization
 * server metadata, dynamic registration, an authorization endpoint that stands
 * in for the person approving, and a token endpoint that checks PKCE, the
 * redirect address, the client and the resource. Every switch below turns one
 * of those behaviours off or wrong, so a test can see the client refuse it.
 */
import { createHash, randomBytes } from 'node:crypto';

export type FakeMcpAuthOptions = {
  /** Put `resource_metadata` in the 401 challenge; otherwise only well-known discovery finds it. */
  challengeHeader?: boolean;
  challengeScope?: string;
  /** The resource the metadata declares; defaults to the MCP endpoint itself. */
  declaredResource?: (origin: string) => string;
  /** Serve metadata at the RFC 8414 location, the OpenID one, or both. */
  metadataAt?: 'oauth' | 'openid' | 'both';
  /** Name another issuer in the metadata document. */
  wrongIssuer?: boolean;
  /** Leave S256 out of `code_challenge_methods_supported`. */
  noS256?: boolean;
  dynamicRegistration?: boolean;
  clientMetadataDocuments?: boolean;
  /** Advertise and send `iss` in the authorization response. */
  issParameter?: boolean;
  /** Send this `iss` instead of the real issuer. */
  wrongIss?: string;
  /** The server needs no sign-in at all. */
  open?: boolean;
  /**
   * The revision the MCP endpoint speaks once signed in. A handshake revision
   * (`2025-03-26` to `2025-11-25`, or any other string, which the client should
   * refuse) answers `initialize` with it and keeps a session; `2026-07-28` is
   * stateless, answers only `server/discover` and requests that carry their
   * revision, and checks the headers that mirror each request. Default
   * `2025-11-25`.
   */
  protocol?: string;
  /** The tools the endpoint lists; left out, one `read_file`. */
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
};

/** One request the MCP endpoint answered once signed in, as it arrived. */
export type FakeMcpMessage = {
  method: string;
  params: Record<string, unknown>;
  headers: Record<string, string>;
};

export type FakeMcpAuth = {
  origin: string;
  mcpUrl: string;
  issuer: string;
  /** Every path asked for, in order. */
  requests: string[];
  registrations: Record<string, unknown>[];
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** Tokens handed out, to search logs and answers for. */
  issued: string[];
  /** What the MCP endpoint was sent once signed in, in order. */
  messages: FakeMcpMessage[];
  stop(): Promise<void>;
};

const STATELESS = '2026-07-28';
const rpcError = (id: unknown, code: number, message: string, data?: unknown, status = 400) =>
  Response.json(
    { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } },
    { status },
  );

/**
 * Once signed in, the endpoint speaks enough MCP for a connection's handshake,
 * its tool list and its calls, in the revision the options name.
 */
async function answerMcp(
  request: Request,
  options: FakeMcpAuthOptions,
  messages: FakeMcpMessage[],
): Promise<Response> {
  const message = (await request.json().catch(() => ({}))) as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  const method = String(message.method ?? '');
  const params = message.params ?? {};
  messages.push({ method, params, headers: Object.fromEntries(request.headers.entries()) });
  if (message.id === undefined) return new Response(null, { status: 202 });
  const protocol = options.protocol ?? '2025-11-25';
  const tools = options.tools ?? [{ name: 'read_file' }];
  const listed = tools.map((tool) => ({ inputSchema: { type: 'object' }, ...tool }));
  const call = () => {
    const name = String(params.name ?? '');
    if (!tools.some((tool) => tool.name === name))
      return { isError: true, content: [{ type: 'text', text: 'Unknown tool' }] };
    if (name === 'needs_input')
      return {
        resultType: 'input_required',
        inputRequests: { ask: { method: 'elicitation/create', params: {} } },
      };
    return { content: [{ type: 'text', text: `${name} done` }] };
  };
  if (protocol === STATELESS) {
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    const version = meta['io.modelcontextprotocol/protocolVersion'];
    if (method === 'initialize' || typeof version !== 'string')
      return rpcError(message.id, -32022, 'Unsupported protocol version', {
        supported: [STATELESS],
      });
    if (version !== STATELESS)
      return rpcError(message.id, -32022, 'Unsupported protocol version', {
        supported: [STATELESS],
        requested: version,
      });
    const named = ['tools/call', 'resources/read', 'prompts/get'].includes(method);
    if (
      request.headers.get('mcp-protocol-version') !== version ||
      request.headers.get('mcp-method') !== method ||
      (named && request.headers.get('mcp-name') !== params.name) ||
      request.headers.has('mcp-session-id')
    )
      return rpcError(message.id, -32020, 'Header mismatch');
    const result =
      method === 'server/discover'
        ? { supportedVersions: [STATELESS], capabilities: { tools: {} } }
        : method === 'tools/list'
          ? { tools: listed, ttlMs: 60_000, cacheScope: 'private' }
          : method === 'tools/call'
            ? call()
            : null;
    if (!result) return rpcError(message.id, -32601, 'Method not found', undefined, 404);
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: { resultType: 'complete', ...result },
    });
  }
  // A handshake server knows nothing of the stateless probe, and refuses any
  // request but `initialize` that comes without its session.
  if (method === 'initialize')
    return Response.json(
      {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: protocol, capabilities: { tools: {} } },
      },
      { headers: { 'mcp-session-id': 'fake-session' } },
    );
  if (request.headers.get('mcp-session-id') !== 'fake-session')
    return rpcError(message.id, -32000, 'Bad Request: No valid session ID provided');
  const result =
    method === 'tools/list'
      ? { tools: listed }
      : method === 'tools/call'
        ? call()
        : method === 'ping'
          ? {}
          : null;
  if (!result) return rpcError(message.id, -32601, 'Method not found', undefined, 200);
  return Response.json({ jsonrpc: '2.0', id: message.id, result });
}

export async function startFakeMcpAuth(options: FakeMcpAuthOptions = {}): Promise<FakeMcpAuth> {
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; resource: string }
  >();
  const state = {
    requests: [] as string[],
    registrations: [] as Record<string, unknown>[],
    authorizeRequests: [] as URLSearchParams[],
    tokenRequests: [] as URLSearchParams[],
    issued: [] as string[],
    messages: [] as FakeMcpMessage[],
  };
  let origin = '';
  const issuer = () => `${origin}/auth`;
  const mcpUrl = () => `${origin}/mcp`;

  const asMetadata = () => ({
    issuer: options.wrongIssuer ? 'https://elsewhere.example/auth' : issuer(),
    authorization_endpoint: `${origin}/auth/authorize`,
    token_endpoint: `${origin}/auth/token`,
    ...(options.dynamicRegistration !== false
      ? { registration_endpoint: `${origin}/auth/register` }
      : {}),
    scopes_supported: ['files:read', 'files:write', 'offline_access'],
    ...(options.noS256 ? {} : { code_challenge_methods_supported: ['S256'] }),
    ...(options.clientMetadataDocuments ? { client_id_metadata_document_supported: true } : {}),
    ...(options.issParameter ? { authorization_response_iss_parameter_supported: true } : {}),
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request): Promise<Response> => {
      const url = new URL(request.url);
      const at = url.pathname;
      state.requests.push(at);
      if (at === '/mcp' && request.method === 'DELETE') return new Response(null, { status: 204 });
      if (at === '/mcp') {
        const bearer = request.headers.get('authorization');
        if (
          options.open ||
          (bearer?.startsWith('Bearer ') && state.issued.includes(bearer.slice(7)))
        )
          return answerMcp(request, options, state.messages);
        const parts = [
          ...(options.challengeHeader !== false
            ? [`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`]
            : []),
          ...(options.challengeScope ? [`scope="${options.challengeScope}"`] : []),
        ];
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': `Bearer ${parts.join(', ')}`.trim() },
        });
      }
      if (at === '/.well-known/oauth-protected-resource/mcp')
        return Response.json({
          resource: options.declaredResource ? options.declaredResource(origin) : mcpUrl(),
          authorization_servers: [issuer()],
          scopes_supported: ['files:read'],
        });
      const where = options.metadataAt ?? 'oauth';
      if (at === '/.well-known/oauth-authorization-server/auth' && where !== 'openid')
        return Response.json(asMetadata());
      if (at === '/.well-known/openid-configuration/auth' && where !== 'oauth')
        return Response.json(asMetadata());
      if (at === '/auth/register' && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        state.registrations.push(body);
        return Response.json({ client_id: 'registered-client', ...body }, { status: 201 });
      }
      if (at === '/auth/authorize') {
        // Stands in for the person approving in their browser.
        state.authorizeRequests.push(url.searchParams);
        const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
        const code = `code-${randomBytes(12).toString('hex')}`;
        codes.set(code, {
          challenge: url.searchParams.get('code_challenge') ?? '',
          redirectUri: redirect.href,
          clientId: url.searchParams.get('client_id') ?? '',
          resource: url.searchParams.get('resource') ?? '',
        });
        state.issued.push(code);
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
        if (options.issParameter || options.wrongIss)
          redirect.searchParams.set('iss', options.wrongIss ?? issuer());
        return new Response(null, { status: 302, headers: { location: redirect.href } });
      }
      if (at === '/auth/token' && request.method === 'POST') {
        const fields = new URLSearchParams(await request.text());
        state.tokenRequests.push(fields);
        const grant = codes.get(fields.get('code') ?? '');
        codes.delete(fields.get('code') ?? '');
        const verified =
          grant &&
          fields.get('grant_type') === 'authorization_code' &&
          grant.clientId === fields.get('client_id') &&
          grant.redirectUri === fields.get('redirect_uri') &&
          grant.resource === fields.get('resource') &&
          createHash('sha256')
            .update(fields.get('code_verifier') ?? '')
            .digest('base64url') === grant.challenge;
        if (!verified) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        const access = `access-${randomBytes(12).toString('hex')}`;
        const refresh = `refresh-${randomBytes(12).toString('hex')}`;
        state.issued.push(access, refresh);
        return Response.json({
          access_token: access,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refresh,
          scope: 'files:read',
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    mcpUrl: mcpUrl(),
    issuer: issuer(),
    ...state,
    stop: async () => {
      await server.stop(true);
    },
  };
}
