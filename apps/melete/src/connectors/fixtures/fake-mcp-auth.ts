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
  stop(): Promise<void>;
};

/** Once signed in, the endpoint speaks enough MCP for a connection's handshake and tool list. */
async function answerMcp(request: Request): Promise<Response> {
  const message = (await request.json().catch(() => ({}))) as { id?: unknown; method?: string };
  if (message.id === undefined) return new Response(null, { status: 202 });
  const result =
    message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} } }
      : message.method === 'tools/list'
        ? { tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] }
        : {};
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
      if (at === '/mcp') {
        const bearer = request.headers.get('authorization');
        if (
          options.open ||
          (bearer?.startsWith('Bearer ') && state.issued.includes(bearer.slice(7)))
        )
          return answerMcp(request);
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
