/**
 * Melete as the authorization server for its own MCP endpoint.
 *
 * An assistant (ChatGPT, Claude, Hermes, anything that speaks MCP) is a
 * public OAuth client. It registers itself, sends the person here to agree,
 * and exchanges the code it is handed, with its PKCE verifier, for tokens
 * that act for that one person in the space they agreed from. Nothing here
 * grants more than the person can already do signed in; the tokens only
 * reach the MCP tools, and the tools only reach the routes the person could
 * call themselves.
 *
 * Every secret is stored as a SHA-256 digest: a code, an access token and a
 * refresh token read from the database cannot be replayed. A code is used
 * once. A refresh token is rotated on every use, and one presented a second
 * time ends every token of that sign-in, since only a copy could present it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  pinnedWebRequest,
  publicPin,
  type ResolvedAddress,
  resolveHost,
  type WebTransport,
} from '../connectors/web.ts';

/** The one scope: use Melete's tools as the person who agreed. */
export const MCP_SCOPE = 'melete';
export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 60 * 60;
/** However often it is refreshed, a connection ends this long after the person agreed. */
export const CONNECTION_SECONDS = 90 * 24 * 60 * 60;
const CODE_SECONDS = 10 * 60;
/** A registration nobody has agreed to is dropped after a day. */
const UNUSED_CLIENT_SECONDS = 24 * 60 * 60;
/** At most this many registrations may wait for a person's agreement at once. */
export const UNUSED_CLIENT_LIMIT = 500;

/** Where everything is published, derived from the service's public address. */
export type McpServerAddresses = {
  /** The web origin people use, which forwards `/api` to this service. */
  origin: string;
  issuer: string;
  resource: string;
  authorize: string;
  token: string;
  register: string;
  revoke: string;
  resourceMetadata: string;
};

/** Undefined when the service has no public address: nothing outside could reach it. */
export function mcpServerAddresses(publicUrl: string | undefined): McpServerAddresses | undefined {
  if (!publicUrl) return undefined;
  const origin = new URL(publicUrl).origin;
  return {
    origin,
    issuer: origin,
    resource: `${origin}/api/mcp`,
    authorize: `${origin}/api/oauth/authorize`,
    token: `${origin}/api/oauth/token`,
    register: `${origin}/api/oauth/register`,
    revoke: `${origin}/api/oauth/revoke`,
    resourceMetadata: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
  };
}

/** RFC 8414 metadata, which a client finds before it registers. */
export function authorizationServerMetadata(addresses: McpServerAddresses) {
  return {
    issuer: addresses.issuer,
    authorization_endpoint: addresses.authorize,
    token_endpoint: addresses.token,
    registration_endpoint: addresses.register,
    revocation_endpoint: addresses.revoke,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** RFC 9728 metadata, which the MCP endpoint's 401 points to. */
export function protectedResourceMetadata(addresses: McpServerAddresses) {
  return {
    resource: addresses.resource,
    authorization_servers: [addresses.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Melete',
  };
}

/** An error the token and registration endpoints answer with, in RFC 6749's words. */
export class OAuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'invalid_client'
      | 'invalid_grant'
      | 'unsupported_grant_type'
      | 'invalid_scope'
      | 'invalid_target'
      | 'invalid_redirect_uri'
      | 'invalid_client_metadata'
      | 'access_denied'
      | 'temporarily_unavailable',
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
/**
 * A place a code may be sent: HTTPS anywhere, or plain HTTP only back to this
 * computer, as a desktop client listens there. No fragment, no credentials.
 */
export function redirectUriAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password || value.length > 2000) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.includes(url.hostname);
}

const clientName = z
  .string()
  .max(120)
  .transform((value) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim());
const registration = z
  .object({
    redirect_uris: z.array(z.string()).min(1).max(10),
    client_name: clientName.optional(),
    token_endpoint_auth_method: z.string().optional(),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    scope: z.string().max(500).optional(),
  })
  .passthrough();

export type McpClientRecord = {
  id: string;
  name: string;
  redirectUris: string[];
  /**
   * For a client identified by its metadata document, the host that document
   * was read from: the one part of its identity this server has checked. A
   * registered client's name is whatever it chose to call itself.
   */
  verifiedHost?: string;
};

function checkedClient(
  input: unknown,
  id: string | undefined,
): Pick<McpClientRecord, 'name' | 'redirectUris'> {
  const parsed = registration.safeParse(input);
  if (!parsed.success)
    throw new OAuthError('invalid_client_metadata', 'The client metadata is not valid.');
  const metadata = parsed.data;
  if (!metadata.redirect_uris.every(redirectUriAllowed))
    throw new OAuthError(
      'invalid_redirect_uri',
      'A redirect address must be HTTPS, or HTTP back to this computer.',
    );
  if (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none')
    throw new OAuthError(
      'invalid_client_metadata',
      'Only public clients are supported: use token_endpoint_auth_method none with PKCE.',
    );
  if (
    metadata.grant_types &&
    !metadata.grant_types.every((grant) => ['authorization_code', 'refresh_token'].includes(grant))
  )
    throw new OAuthError(
      'invalid_client_metadata',
      'Only the code and refresh grants are offered.',
    );
  if (metadata.response_types && !metadata.response_types.every((type) => type === 'code'))
    throw new OAuthError('invalid_client_metadata', 'Only the code response is offered.');
  if (id !== undefined && (metadata as { client_id?: unknown }).client_id !== id)
    throw new OAuthError(
      'invalid_client_metadata',
      'The metadata document names a different client_id.',
    );
  return {
    name: metadata.client_name || new URL(metadata.redirect_uris[0] ?? 'https://unknown').host,
    redirectUris: [...new Set(metadata.redirect_uris)],
  };
}

/** A client ID metadata document's address: HTTPS with a path, nothing that could hide a second meaning. */
export function metadataDocumentUrl(clientId: string): URL | undefined {
  try {
    const url = new URL(clientId);
    if (
      url.protocol !== 'https:' ||
      url.pathname === '/' ||
      url.hash ||
      url.username ||
      url.password ||
      clientId.length > 2000
    )
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export type OAuthStoreOptions = {
  /** Fetches a client metadata document; the default resolves, checks and pins a public address. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  transport?: WebTransport;
  now?: () => Date;
};

export type McpGrant = {
  clientId: string;
  principalId: string;
  spaceId: string;
  membershipGeneration: number | null;
  resource: string;
  scope: string;
};

/** A live access token's grant, with the sign-in it belongs to. */
export type McpAccess = McpGrant & { family: string };

export type TokenPair = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export class OAuthStore {
  private readonly resolve: (host: string) => Promise<ResolvedAddress[]>;
  private readonly transport: WebTransport;
  private readonly now: () => Date;

  constructor(
    private readonly sql: Sql,
    readonly addresses: McpServerAddresses,
    options: OAuthStoreOptions = {},
  ) {
    this.resolve = options.resolve ?? resolveHost;
    this.transport = options.transport ?? pinnedWebRequest;
    this.now = options.now ?? (() => new Date());
  }

  /** Timestamps are bound as ISO text: the driver here does not serialise a Date itself. */
  private stamp() {
    return this.now().toISOString();
  }

  private later(seconds: number) {
    return new Date(this.now().getTime() + seconds * 1000).toISOString();
  }

  private earlier(seconds: number) {
    return new Date(this.now().getTime() - seconds * 1000).toISOString();
  }

  /** RFC 7591 registration of a public client. */
  async register(input: unknown) {
    const client = checkedClient(input, undefined);
    // Registration is open to anyone, so what nobody agreed to does not pile up.
    await this
      .sql`delete from mcp_client c where c.created_at < ${this.earlier(UNUSED_CLIENT_SECONDS)}
      and not exists (select 1 from mcp_authorization a where a.client_id = c.id)
      and not exists (select 1 from mcp_token t where t.client_id = c.id)`;
    const [waiting] = await this.sql`select count(*)::int as n from mcp_client c
      where not exists (select 1 from mcp_authorization a where a.client_id = c.id)`;
    if (Number(waiting?.n ?? 0) >= UNUSED_CLIENT_LIMIT)
      throw new OAuthError(
        'temporarily_unavailable',
        'Too many assistants are waiting to be connected. Try again later.',
        429,
      );
    const id = secret('mcpc').slice(0, 48);
    const [row] = await this.sql`insert into mcp_client (id, name, redirect_uris)
      values (${id}, ${client.name}, ${JSON.stringify(client.redirectUris)}::jsonb)
      returning created_at`;
    return {
      client_id: id,
      client_id_issued_at: Math.floor(new Date(String(row?.created_at)).getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /**
   * The client an id names. A registered id is read from the table; an HTTPS
   * id is a metadata document, read afresh from a public address only. Reading
   * one records nothing: see `recordClient`.
   */
  async client(clientId: string): Promise<McpClientRecord | undefined> {
    const document = metadataDocumentUrl(clientId);
    if (document) return this.documentClient(clientId, document);
    if (!/^mcpc_[A-Za-z0-9_-]{1,64}$/.test(clientId)) return undefined;
    const [row] = await this.sql`select id, name, redirect_uris from mcp_client
      where id = ${clientId} and metadata_url is null`;
    return row
      ? { id: String(row.id), name: String(row.name), redirectUris: row.redirect_uris as string[] }
      : undefined;
  }

  /**
   * The name of a client this server already knows, read from the table only:
   * a metadata document is recorded when a person allows it.
   */
  async clientName(clientId: string): Promise<string | undefined> {
    if (clientId.length > 2048) return undefined;
    const [row] = await this.sql`select name from mcp_client where id = ${clientId}`;
    return row ? String(row.name) : undefined;
  }

  private async documentClient(clientId: string, url: URL): Promise<McpClientRecord | undefined> {
    let pinned: ResolvedAddress | undefined;
    try {
      pinned = publicPin(await this.resolve(url.hostname));
    } catch {
      pinned = undefined;
    }
    // A client document lives on the public internet; a private address is refused unread.
    if (!pinned) return undefined;
    let body: unknown;
    try {
      const response = await this.transport(url, pinned, {
        maxBytes: 64 * 1024,
        timeoutMs: 5_000,
        accept: 'application/json',
      });
      if (response.status !== 200) return undefined;
      body = JSON.parse(response.body);
    } catch {
      return undefined;
    }
    try {
      return { id: clientId, ...checkedClient(body, clientId), verifiedHost: url.host };
    } catch {
      return undefined;
    }
  }

  /**
   * Records a metadata-document client once a person has allowed it, so its
   * tokens name a known client. Anyone can make this server read a document;
   * only a person's Allow makes it keep one.
   */
  async recordClient(client: McpClientRecord): Promise<void> {
    if (!client.verifiedHost) return;
    await this.sql`insert into mcp_client (id, name, redirect_uris, metadata_url)
      values (${client.id}, ${client.name}, ${JSON.stringify(client.redirectUris)}::jsonb, ${client.id})
      on conflict (id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris`;
  }

  /**
   * Whether an error about a request may be sent back to this address before a
   * person has answered. Registration is open, so it can name any address, and
   * a redirect from here would otherwise take anyone anywhere (RFC 9700 4.11.2).
   * Trusted: this computer, the metadata document's own host, or an address a
   * person here has already let this client return to.
   */
  async trustedReturn(client: McpClientRecord, redirectUri: string): Promise<boolean> {
    const url = new URL(redirectUri);
    if (url.protocol === 'http:' && LOOPBACK.includes(url.hostname)) return true;
    if (client.verifiedHost && url.host === client.verifiedHost) return true;
    const [allowed] = await this.sql`select 1 from mcp_authorization
      where client_id = ${client.id} and redirect_uri = ${redirectUri} limit 1`;
    return Boolean(allowed);
  }

  /** A code for one client, redirect, challenge and resource, as the person who agreed. */
  async issueCode(grant: McpGrant & { redirectUri: string; codeChallenge: string }) {
    const code = secret('mcpa');
    await this.sql`insert into mcp_authorization (code_hash, client_id, principal_id, space_id,
      membership_generation, redirect_uri, code_challenge, resource, scope, expires_at)
      values (${digest(code)}, ${grant.clientId}, ${grant.principalId}, ${grant.spaceId},
      ${grant.membershipGeneration}, ${grant.redirectUri}, ${grant.codeChallenge}, ${grant.resource},
      ${grant.scope}, ${this.later(CODE_SECONDS)})`;
    return code;
  }

  /** The code grant: once, by the client it was issued to, with the verifier behind its challenge. */
  async exchangeCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
    resource?: string;
  }): Promise<TokenPair> {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier))
      throw new OAuthError('invalid_request', 'The code verifier is not valid.');
    // A refusal is decided inside the transaction and raised after it commits, so
    // a burnt code and a revoked family stay burnt and revoked.
    const outcome = await this.sql.begin(async (tx) => {
      const [row] = await tx`update mcp_authorization set used_at = ${this.stamp()}
        where code_hash = ${digest(input.code)} and used_at is null returning *`;
      if (!row) {
        // A code seen before was used by someone: whatever it bought ends here.
        await tx`update mcp_token set revoked_at = ${this.stamp()} where revoked_at is null
          and family = ${digest(`code:${input.code}`)}`;
        return new OAuthError('invalid_grant', 'The code is not valid.');
      }
      const challenge = createHash('sha256').update(input.verifier).digest('base64url');
      if (
        new Date(String(row.expires_at)).getTime() <= this.now().getTime() ||
        row.client_id !== input.clientId ||
        row.redirect_uri !== input.redirectUri ||
        row.code_challenge !== challenge ||
        (input.resource !== undefined && input.resource !== row.resource)
      )
        return new OAuthError('invalid_grant', 'The code is not valid for this request.');
      const ends = new Date(this.now().getTime() + CONNECTION_SECONDS * 1000);
      return this.issueTokens(tx as unknown as Sql, digest(`code:${input.code}`), ends, {
        clientId: String(row.client_id),
        principalId: String(row.principal_id),
        spaceId: String(row.space_id),
        membershipGeneration:
          row.membership_generation === null ? null : Number(row.membership_generation),
        resource: String(row.resource),
        scope: String(row.scope),
      });
    });
    if (outcome instanceof OAuthError) throw outcome;
    return outcome;
  }

  /** The refresh grant, rotating the token; a token presented twice ends its whole sign-in. */
  async refresh(input: {
    refreshToken: string;
    clientId: string;
    resource?: string;
  }): Promise<TokenPair> {
    const outcome = await this.sql.begin(async (tx) => {
      const [row] =
        await tx`select * from mcp_token where token_hash = ${digest(input.refreshToken)}
        and kind = 'refresh' for update`;
      if (!row) return new OAuthError('invalid_grant', 'The refresh token is not valid.');
      if (row.used_at || row.revoked_at) {
        await tx`update mcp_token set revoked_at = ${this.stamp()}
          where family = ${row.family} and revoked_at is null`;
        return new OAuthError('invalid_grant', 'The refresh token is not valid.');
      }
      if (
        new Date(String(row.expires_at)).getTime() <= this.now().getTime() ||
        row.client_id !== input.clientId ||
        (input.resource !== undefined && input.resource !== row.resource)
      )
        return new OAuthError('invalid_grant', 'The refresh token is not valid for this request.');
      // The sign-in's first token marks when the person agreed. Every token is
      // issued to expire by then, so a refresh cannot carry the connection past it.
      const [family] = await tx`select min(created_at) as began from mcp_token
        where family = ${row.family}`;
      const ends =
        new Date(String(family?.began ?? row.created_at)).getTime() + CONNECTION_SECONDS * 1000;
      await tx`update mcp_token set used_at = ${this.stamp()} where token_hash = ${row.token_hash}`;
      return this.issueTokens(tx as unknown as Sql, String(row.family), new Date(ends), {
        clientId: String(row.client_id),
        principalId: String(row.principal_id),
        spaceId: String(row.space_id),
        membershipGeneration:
          row.membership_generation === null ? null : Number(row.membership_generation),
        resource: String(row.resource),
        scope: String(row.scope),
      });
    });
    if (outcome instanceof OAuthError) throw outcome;
    return outcome;
  }

  /** A token pair for one sign-in, neither of which outlives the connection's end. */
  private async issueTokens(
    sql: Sql,
    family: string,
    ends: Date,
    grant: McpGrant,
  ): Promise<TokenPair> {
    const access = secret('mlta');
    const refresh = secret('mltr');
    const until = (seconds: number) =>
      new Date(Math.min(this.now().getTime() + seconds * 1000, ends.getTime())).toISOString();
    for (const [token, kind, seconds] of [
      [access, 'access', ACCESS_TOKEN_SECONDS],
      [refresh, 'refresh', REFRESH_TOKEN_SECONDS],
    ] as const)
      await sql`insert into mcp_token (token_hash, kind, family, client_id, principal_id, space_id,
        membership_generation, resource, scope, expires_at, created_at)
        values (${digest(token)}, ${kind}, ${family}, ${grant.clientId}, ${grant.principalId},
        ${grant.spaceId}, ${grant.membershipGeneration}, ${grant.resource}, ${grant.scope},
        ${until(seconds)}, ${this.stamp()})`;
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope: grant.scope,
    };
  }

  /** RFC 7009: revoking either token ends the whole sign-in it belongs to. */
  async revoke(token: string): Promise<void> {
    await this.sql`update mcp_token set revoked_at = ${this.stamp()} where revoked_at is null
      and family = (select family from mcp_token where token_hash = ${digest(token)})`;
  }

  /** Ends one sign-in: every token that shares its family. */
  async revokeFamily(family: string): Promise<void> {
    await this.sql`update mcp_token set revoked_at = ${this.stamp()}
      where family = ${family} and revoked_at is null`;
  }

  /** The person and space an access token acts for, if it is live and meant for this resource. */
  async authenticate(token: string): Promise<McpAccess | undefined> {
    if (!/^mlta_[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const [row] = await this.sql`select * from mcp_token where token_hash = ${digest(token)}
      and kind = 'access' and revoked_at is null and expires_at > ${this.stamp()}
      and resource = ${this.addresses.resource}`;
    if (!row) return undefined;
    return {
      family: String(row.family),
      clientId: String(row.client_id),
      principalId: String(row.principal_id),
      spaceId: String(row.space_id),
      membershipGeneration:
        row.membership_generation === null ? null : Number(row.membership_generation),
      resource: String(row.resource),
      scope: String(row.scope),
    };
  }

  /** The assistants a person has let in, one line per client still holding a live token. */
  async connected(principalId: string) {
    const rows = await this.sql`select c.id, c.name, min(t.created_at) as since
      from mcp_token t join mcp_client c on c.id = t.client_id
      where t.principal_id = ${principalId} and t.revoked_at is null and t.expires_at > ${this.stamp()}
      group by c.id, c.name order by since`;
    return rows.map((row) => ({
      client_id: String(row.id),
      name: String(row.name),
      since: new Date(String(row.since)).toISOString(),
    }));
  }

  /** Disconnect one assistant: every token it holds for this person ends. */
  async disconnect(principalId: string, clientId: string): Promise<boolean> {
    const rows = await this.sql`update mcp_token set revoked_at = ${this.stamp()}
      where principal_id = ${principalId} and client_id = ${clientId} and revoked_at is null
      returning token_hash`;
    return rows.length > 0;
  }
}
