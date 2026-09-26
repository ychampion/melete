/**
 * The sign-ins in progress for remote MCP servers. A sign-in starts with the
 * server's address, sends the person's browser to its authorization server,
 * and finishes when the browser comes back to this service's callback. The
 * tokens it earns become the connection's sealed credential through the same
 * installation path a pasted credential takes, so the grants, the approvals and
 * the receipts are exactly those of any other MCP connection.
 *
 * A sign-in in progress is held in this process's memory: its PKCE verifier and
 * state never touch storage, and a restart ends it.
 */
import { randomBytes } from 'node:crypto';
import type { ConnectionResponse, McpConnectionConfig } from '@melete/contracts';
import {
  type AuthorizationServer,
  authorizationUrl,
  callbackCode,
  discoverAuthorizationServer,
  discoverProtectedResource,
  exchangeCode,
  McpSignInFailure,
  type OAuthFetch,
  pkcePair,
  type RegisteredClient,
  randomState,
  registerClient,
  requestedScope,
} from './mcp-oauth.ts';

export type McpSignInRequest = {
  space_id?: string;
  label: string;
  mcp: McpConnectionConfig;
  /** A client the person registered with the server themselves, when it offers no other way. */
  client?: { client_id: string; client_secret?: string };
};

type Pending = {
  id: string;
  actor: string;
  spaceId: string;
  request: McpSignInRequest;
  state: string;
  verifier: string;
  redirectUri: string;
  server: AuthorizationServer;
  client: RegisteredClient;
  resource: string;
  expiresAt: number;
};

export type McpSignInStatus =
  | { state: 'pending'; expires_at: string }
  | { state: 'connected'; connection_id: string }
  | { state: 'failed'; error: string };

/** How long a person has to finish at the authorization server. */
const PENDING_TTL_MS = 15 * 60_000;
/** How long a finished sign-in can still be asked about. */
const FINISHED_TTL_MS = 10 * 60_000;

export type McpSignInHooks = {
  /** The service's public address, as the person's browser reaches it. */
  publicUrl?: string;
  /** Publish a Client ID Metadata Document at an https:// public address. */
  clientMetadata?: boolean;
  /** Refuses an actor who may not install in this space; runs before any address is fetched. */
  authorize(actor: string, spaceId: string | undefined): Promise<string>;
  /** The fetch this space's installations are held to. */
  fetcherFor(spaceId: string): Promise<OAuthFetch>;
  /** The ordinary installation path, given the credential the sign-in earned. */
  install(
    actor: string,
    request: McpSignInRequest & { credentials: Record<string, string> },
  ): Promise<ConnectionResponse>;
  now?: () => number;
};

export class McpSignIns {
  private readonly pending = new Map<string, Pending>();
  private readonly byState = new Map<string, string>();
  private readonly finished = new Map<
    string,
    { actor: string; status: McpSignInStatus; until: number }
  >();
  private readonly now: () => number;

  constructor(private readonly hooks: McpSignInHooks) {
    this.now = hooks.now ?? Date.now;
  }

  /**
   * Where the authorization server sends the browser back. The specification
   * allows only HTTPS or `localhost`, so any other public address has none.
   */
  redirectUri(): string | null {
    const base = this.base();
    if (!base) return null;
    const url = new URL(base);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return `${base}/api/oauth/callback`;
  }

  /** Where this service's client metadata document is published: HTTPS only. */
  clientMetadataUrl(): string | undefined {
    const base = this.base();
    return this.hooks.clientMetadata !== false && base?.startsWith('https://')
      ? `${base}/api/oauth/client-metadata.json`
      : undefined;
  }

  private base(): string | null {
    if (!this.hooks.publicUrl) return null;
    try {
      const url = new URL(this.hooks.publicUrl);
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  }

  /** Begins a sign-in; the answer is the address to open in the browser. */
  async start(
    actor: string,
    request: McpSignInRequest,
  ): Promise<{
    sign_in_id: string;
    authorize_url: string;
    redirect_uri: string;
    expires_at: string;
  }> {
    this.sweep();
    const spaceId = await this.hooks.authorize(actor, request.space_id);
    const redirectUri = this.redirectUri();
    if (!redirectUri) throw new McpSignInFailure('callback_unavailable');
    const fetcher = await this.hooks.fetcherFor(spaceId);
    const protectedResource = await discoverProtectedResource(request.mcp.url, fetcher);
    if (!protectedResource) throw new McpSignInFailure('sign_in_not_needed');
    // The first listed server; the resource's metadata names them in its own preference.
    const issuer = protectedResource.authorizationServers[0] as string;
    const server = await discoverAuthorizationServer(issuer, fetcher);
    const client = await registerClient(server, {
      redirectUri,
      clientMetadataUrl: this.clientMetadataUrl(),
      preRegistered: request.client,
      fetcher,
    });
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const id = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + PENDING_TTL_MS;
    this.pending.set(id, {
      id,
      actor,
      spaceId,
      request: { ...request, space_id: spaceId },
      state,
      verifier,
      redirectUri,
      server,
      client,
      resource: protectedResource.resource,
      expiresAt,
    });
    this.byState.set(state, id);
    return {
      sign_in_id: id,
      authorize_url: authorizationUrl(server, {
        clientId: client.clientId,
        redirectUri,
        state,
        challenge,
        resource: protectedResource.resource,
        scope: requestedScope(protectedResource, server),
      }),
      redirect_uri: redirectUri,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Finishes the sign-in the browser came back for. It is spent whether it
   * succeeds or not, and only the person who started it can finish it.
   */
  async complete(actor: string, query: URLSearchParams): Promise<ConnectionResponse> {
    this.sweep();
    const id = this.byState.get(query.get('state') ?? '');
    const entry = id ? this.pending.get(id) : undefined;
    if (!entry || entry.actor !== actor) throw new McpSignInFailure('sign_in_not_found');
    this.pending.delete(entry.id);
    this.byState.delete(entry.state);
    try {
      const code = callbackCode(query, {
        state: entry.state,
        issuer: entry.server.issuer,
        issParameterSupported: entry.server.authorization_response_iss_parameter_supported === true,
      });
      const fetcher = await this.hooks.fetcherFor(entry.spaceId);
      const tokens = await exchangeCode(
        entry.server,
        {
          code,
          verifier: entry.verifier,
          redirectUri: entry.redirectUri,
          client: entry.client,
          resource: entry.resource,
        },
        fetcher,
        this.now(),
      );
      const credentials: Record<string, string> = {
        access_token: tokens.accessToken,
        client_id: entry.client.clientId,
        resource: entry.resource,
        ...(tokens.expiresAt ? { expires_at: tokens.expiresAt } : {}),
        ...(tokens.refreshToken
          ? { refresh_token: tokens.refreshToken, token_url: entry.server.token_endpoint }
          : {}),
        ...(entry.client.clientSecret ? { client_secret: entry.client.clientSecret } : {}),
      };
      const installed = await this.hooks.install(actor, { ...entry.request, credentials });
      this.finish(entry.id, actor, { state: 'connected', connection_id: installed.connection.id });
      return installed;
    } catch (error) {
      const code = error instanceof McpSignInFailure ? error.code : 'install_failed';
      this.finish(entry.id, actor, { state: 'failed', error: code });
      throw error;
    }
  }

  status(actor: string, id: string): McpSignInStatus | null {
    this.sweep();
    const entry = this.pending.get(id);
    if (entry)
      return entry.actor === actor
        ? { state: 'pending', expires_at: new Date(entry.expiresAt).toISOString() }
        : null;
    const done = this.finished.get(id);
    return done && done.actor === actor ? done.status : null;
  }

  private finish(id: string, actor: string, status: McpSignInStatus) {
    this.finished.set(id, { actor, status, until: this.now() + FINISHED_TTL_MS });
  }

  private sweep() {
    const now = this.now();
    for (const [id, entry] of this.pending)
      if (entry.expiresAt <= now) {
        this.pending.delete(id);
        this.byState.delete(entry.state);
      }
    for (const [id, done] of this.finished) if (done.until <= now) this.finished.delete(id);
  }
}
