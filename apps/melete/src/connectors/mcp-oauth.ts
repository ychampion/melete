/**
 * Signing in to a remote MCP server, as the MCP authorization specification
 * (revision 2026-07-28) asks of a client:
 *
 * 1. An unauthenticated request draws a 401 whose `WWW-Authenticate` header
 *    names the server's protected resource metadata (RFC 9728); without it the
 *    two well-known locations are tried in order.
 * 2. The metadata names an authorization server, whose own metadata is read
 *    from the RFC 8414 and OpenID locations in the specification's order. A
 *    document that names a different issuer, or offers no S256 PKCE, is refused.
 * 3. The client is a pre-registered one when the person supplies it, a Client
 *    ID Metadata Document when the server supports those and this service has a
 *    public HTTPS address, and a dynamically registered one otherwise.
 * 4. The authorization request carries PKCE, a state and the `resource` the
 *    token is for (RFC 8707); the response is checked against the recorded
 *    issuer (RFC 9207) before its code is spent.
 *
 * Nothing here stores or logs a token. Every failure is a fixed code; a server's
 * own error text is never carried, because it can echo what it was sent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MCP_PROTOCOL_VERSION } from './mcp-transport.ts';

/** A fetch that has already decided which addresses it may reach. */
export type OAuthFetch = (url: string, init: RequestInit) => Promise<Response>;

export class McpSignInFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const fail = (code: string): never => {
  throw new McpSignInFailure(code);
};

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 256 * 1024;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const loopback = (url: URL) => LOOPBACK.includes(url.hostname);

/** HTTPS, or plain HTTP on this machine; never with credentials or a fragment. */
export function secureEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url));
  } catch {
    return false;
  }
}

/**
 * The server's canonical URI (RFC 8707, MCP "Canonical Server URI"): lowercase
 * scheme and host, no fragment, and no trailing slash on a bare origin.
 */
export function canonicalResource(value: string): string {
  const url = new URL(value);
  url.hash = '';
  const text = url.href;
  return url.pathname === '/' && !url.search ? text.slice(0, -1) : text;
}

/** The `Bearer` challenge's parameters, as RFC 6750 and RFC 9728 define them. */
export function bearerChallenge(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const at = header.search(/(^|,\s*)Bearer(\s|$)/i);
  if (at < 0) return null;
  const rest = header.slice(at).replace(/^,?\s*Bearer\s*/i, '');
  const params: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))\s*(?:,\s*|$)/y;
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    const [, name, quoted, bare] = match;
    if (!name) break;
    params[name.toLowerCase()] =
      quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (bare ?? '');
    if (pattern.lastIndex >= rest.length) break;
  }
  return params;
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (!reader) break;
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader?.cancel().catch(() => {});
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

async function getJson(fetcher: OAuthFetch, url: string): Promise<unknown | null> {
  if (!secureEndpoint(url)) return null;
  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return readJson(response);
  } catch {
    return null;
  }
}

const protectedResourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

export type ProtectedResource = {
  /** The identifier every authorization and token request names. */
  resource: string;
  authorizationServers: string[];
  /** The scopes the 401 challenge asked for, which take precedence (MCP scope selection). */
  challengeScope?: string;
  scopesSupported?: string[];
};

/**
 * Whether a declared resource identifier covers the server being signed in to:
 * the same origin, and a path the server's own path lies under.
 */
function covers(resource: string, server: string): boolean {
  try {
    const declared = new URL(canonicalResource(resource));
    const target = new URL(canonicalResource(server));
    if (declared.origin !== target.origin || declared.search) return false;
    const path = declared.pathname.replace(/\/$/, '');
    return path === '' || target.pathname === path || target.pathname.startsWith(`${path}/`);
  } catch {
    return false;
  }
}

/**
 * Step 1: ask without a token, and read where the server says its
 * authorization is described. `null` when the server needs no sign-in at all.
 */
export async function discoverProtectedResource(
  serverUrl: string,
  fetcher: OAuthFetch,
): Promise<ProtectedResource | null> {
  if (!secureEndpoint(serverUrl)) fail('server_address_refused');
  let response: Response;
  try {
    response = await fetcher(serverUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Melete', version: '0.1' },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail('server_unreachable');
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return null;
  if (response.status !== 401) return fail('server_refused');
  const challenge = bearerChallenge(response.headers.get('www-authenticate'));
  const server = new URL(serverUrl);
  const candidates = challenge?.resource_metadata
    ? [challenge.resource_metadata]
    : [
        ...(server.pathname !== '/'
          ? [
              `${server.origin}/.well-known/oauth-protected-resource${server.pathname.replace(/\/$/, '')}`,
            ]
          : []),
        `${server.origin}/.well-known/oauth-protected-resource`,
      ];
  for (const candidate of candidates) {
    const parsed = protectedResourceMetadata.safeParse(await getJson(fetcher, candidate));
    if (!parsed.success) continue;
    if (!covers(parsed.data.resource, serverUrl)) fail('resource_mismatch');
    const authorizationServers = parsed.data.authorization_servers.filter(secureEndpoint);
    if (authorizationServers.length === 0) fail('authorization_server_refused');
    return {
      resource: canonicalResource(parsed.data.resource),
      authorizationServers,
      ...(challenge?.scope ? { challengeScope: challenge.scope } : {}),
      ...(parsed.data.scopes_supported ? { scopesSupported: parsed.data.scopes_supported } : {}),
    };
  }
  return fail('resource_metadata_unavailable');
}

const authorizationServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  scopes_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});

export type AuthorizationServer = z.infer<typeof authorizationServerMetadata>;

/** The metadata locations for an issuer, in the order the specification requires. */
export function metadataLocations(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * Step 2: the authorization server's metadata. The document must name exactly
 * the issuer it was fetched for, and must offer S256 PKCE, or sign-in stops.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  fetcher: OAuthFetch,
): Promise<AuthorizationServer> {
  if (!secureEndpoint(issuer)) fail('authorization_server_refused');
  for (const location of metadataLocations(issuer)) {
    const parsed = authorizationServerMetadata.safeParse(await getJson(fetcher, location));
    if (!parsed.success) continue;
    if (parsed.data.issuer !== issuer) return fail('issuer_mismatch');
    if (!parsed.data.code_challenge_methods_supported?.includes('S256'))
      return fail('pkce_unsupported');
    for (const endpoint of [
      parsed.data.authorization_endpoint,
      parsed.data.token_endpoint,
      ...(parsed.data.registration_endpoint ? [parsed.data.registration_endpoint] : []),
    ])
      if (!secureEndpoint(endpoint)) return fail('authorization_server_refused');
    return parsed.data;
  }
  return fail('authorization_server_metadata_unavailable');
}

export type RegisteredClient = {
  clientId: string;
  clientSecret?: string;
  method: 'pre_registered' | 'client_metadata_document' | 'dynamic';
};

/**
 * Step 3, in the specification's priority order: a client the person
 * registered themselves, then a Client ID Metadata Document, then dynamic
 * registration. Without any of them the person is asked for a client.
 */
export async function registerClient(
  server: AuthorizationServer,
  options: {
    redirectUri: string;
    /** Where this service publishes its client metadata document, when it can. */
    clientMetadataUrl?: string;
    preRegistered?: { client_id: string; client_secret?: string };
    fetcher: OAuthFetch;
  },
): Promise<RegisteredClient> {
  if (options.preRegistered)
    return {
      clientId: options.preRegistered.client_id,
      ...(options.preRegistered.client_secret
        ? { clientSecret: options.preRegistered.client_secret }
        : {}),
      method: 'pre_registered',
    };
  if (server.client_id_metadata_document_supported && options.clientMetadataUrl)
    return { clientId: options.clientMetadataUrl, method: 'client_metadata_document' };
  if (!server.registration_endpoint) return fail('client_registration_required');
  let response: Response;
  try {
    response = await options.fetcher(server.registration_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Melete',
        redirect_uris: [options.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: loopback(new URL(options.redirectUri)) ? 'native' : 'web',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail('registration_failed');
  }
  const body = await readJson(response);
  const registered = z
    .object({ client_id: z.string().min(1).max(1024), client_secret: z.string().min(1).optional() })
    .safeParse(body);
  if (!response.ok || !registered.success) return fail('registration_failed');
  return {
    clientId: registered.data.client_id,
    ...(registered.data.client_secret ? { clientSecret: registered.data.client_secret } : {}),
    method: 'dynamic',
  };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const randomState = (): string => randomBytes(32).toString('base64url');

/**
 * The scopes to ask for: the 401 challenge's when it gave some, otherwise every
 * scope the resource lists, and nothing when it lists none. `offline_access` is
 * added when the authorization server offers it, so the sign-in can be renewed.
 */
export function requestedScope(
  resource: ProtectedResource,
  server: AuthorizationServer,
  /**
   * Scopes already granted or asked for by a step-up challenge. Signing in
   * again asks for their union with the server's own, so nothing granted
   * before is lost (MCP authorization, scope selection and step-up).
   */
  also: string[] = [],
): string | undefined {
  const base = resource.challengeScope
    ? resource.challengeScope.split(/\s+/).filter(Boolean)
    : (resource.scopesSupported ?? []);
  const scopes = new Set([...base, ...also]);
  if (server.scopes_supported?.includes('offline_access')) scopes.add('offline_access');
  return scopes.size ? [...scopes].join(' ') : undefined;
}

export function authorizationUrl(
  server: AuthorizationServer,
  request: {
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    resource: string;
    scope?: string;
  },
): string {
  const url = new URL(server.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('code_challenge', request.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', request.state);
  url.searchParams.set('resource', request.resource);
  if (request.scope) url.searchParams.set('scope', request.scope);
  return url.href;
}

/**
 * Step 4's check, before any code is spent: the state is the one sent, and the
 * issuer is the one recorded (RFC 9207 Section 2.4, as the MCP table applies
 * it). On an issuer mismatch nothing the response says is acted on or shown.
 */
export function callbackCode(
  query: URLSearchParams,
  expected: { state: string; issuer: string; issParameterSupported: boolean },
): string {
  const state = query.get('state');
  if (!state || state !== expected.state) fail('state_mismatch');
  const iss = query.get('iss');
  if (iss !== null && iss !== expected.issuer) fail('issuer_mismatch');
  if (iss === null && expected.issParameterSupported) fail('issuer_missing');
  if (query.get('error')) fail('sign_in_declined');
  const code = query.get('code');
  if (!code || code.length > 4096) fail('callback_invalid');
  return code as string;
}

const tokenResponse = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
  expires_in: z.number().int().positive().max(31_536_000).optional(),
  refresh_token: z.string().min(1).max(16_384).optional(),
  scope: z.string().optional(),
});

export type SignedInTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
};

/** Spends the code with its PKCE verifier, for the one resource the token is for. */
export async function exchangeCode(
  server: AuthorizationServer,
  request: {
    code: string;
    verifier: string;
    redirectUri: string;
    client: RegisteredClient;
    resource: string;
  },
  fetcher: OAuthFetch,
  now: number = Date.now(),
): Promise<SignedInTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: request.client.clientId,
    code_verifier: request.verifier,
    resource: request.resource,
  });
  if (request.client.clientSecret) form.set('client_secret', request.client.clientSecret);
  let response: Response;
  try {
    response = await fetcher(server.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail('token_endpoint_unreachable');
  }
  const body = await readJson(response);
  const parsed = tokenResponse.safeParse(body);
  if (!response.ok || !parsed.success) return fail('code_exchange_refused');
  return {
    accessToken: parsed.data.access_token,
    ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
    ...(parsed.data.expires_in
      ? { expiresAt: new Date(now + parsed.data.expires_in * 1000).toISOString() }
      : {}),
    ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
  };
}

/** The client metadata document this service publishes (Client ID Metadata Documents). */
export function clientMetadataDocument(clientMetadataUrl: string, redirectUri: string) {
  return {
    client_id: clientMetadataUrl,
    client_name: 'Melete',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}
