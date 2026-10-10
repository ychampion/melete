/**
 * What disconnecting an account does beyond Melete's own rows.
 *
 * The connection's sealed tokens are deleted, every copy of them, and where
 * the provider lets an app withdraw its own access (RFC 7009), Melete asks it
 * to, so the token is dead at the provider too and not only forgotten here.
 *
 * One Google sign-in can stand behind several connections (mail, calendar,
 * Drive), each with its own sealed copy of the same grant. Google withdraws a
 * grant whole, so while another connection still uses that account the grant
 * is left alone and the person is told so. Microsoft offers no way for an app
 * to withdraw its own sign-in, and a key or password the person made for
 * Melete is theirs to delete; in both cases the person is told where to do it.
 */
import type { ProviderAccess } from '@melete/contracts';
import type { Sql } from 'postgres';
import {
  discoverIssuer,
  type OAuthFetch,
  type OAuthIssuer,
  revokeToken,
} from '../gateway/oauth.ts';
import { GOOGLE_ENDPOINTS, type GoogleEndpoints, googleIssuer } from './google.ts';
import { mcpCredentials } from './mcp-credentials.ts';
import { reachFetch, spaceReach } from './public-fetch.ts';
import { PostgresSecretRepository, type SealedSecretStore } from './secrets.ts';
import { type AccountClient, signedInCredential } from './signed-in.ts';

/** The connection as it was when its revocation committed. */
export type RevokedConnection = {
  id: string;
  spaceId: string;
  provider: string;
  configuration: unknown;
  secretRef: string | null;
};

const GOOGLE_KINDS = ['gmail', 'google_calendar', 'google_drive'];
const MICROSOFT_KINDS = ['outlook_mail', 'outlook_calendar'];

export type RevocationOptions = {
  sql: Sql;
  secrets: SealedSecretStore;
  google?: { client: AccountClient; endpoints?: GoogleEndpoints };
  /** How Google is reached; tests pass a fake. */
  fetcher?: OAuthFetch;
  /** How an MCP server's issuer is reached, held to what the space may reach. */
  mcpFetch?: (spaceId: string) => Promise<OAuthFetch>;
  log?: (line: string) => void;
};

/**
 * For the policy service's `afterRevoke`: withdraw the access at the provider
 * where that is possible, then delete the sealed tokens. It never undoes the
 * disconnection, and the tokens are deleted whatever the provider answered.
 */
export function connectionRevocation(options: RevocationOptions) {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  return async (connection: RevokedConnection): Promise<ProviderAccess | undefined> => {
    const ref = connection.secretRef;
    if (!ref) return undefined;
    let access: ProviderAccess | undefined;
    try {
      access = await withdraw(options, connection, ref);
    } catch {
      access = 'not_confirmed';
    }
    try {
      await options.secrets.forget(ref, connection.spaceId);
    } catch (error) {
      // The startup sweep removes it later; nothing points at it any more.
      log(
        `connections: the sealed tokens of ${connection.id} were not deleted yet (${error instanceof Error ? error.message : 'error'})`,
      );
    }
    if (access === 'not_confirmed')
      log(`connections: the provider did not confirm withdrawing ${connection.id}'s access`);
    return access;
  };
}

async function withdraw(
  options: RevocationOptions,
  connection: RevokedConnection,
  ref: string,
): Promise<ProviderAccess | undefined> {
  const configuration = (connection.configuration ?? {}) as Record<string, unknown>;
  const kind = typeof configuration.kind === 'string' ? configuration.kind : null;
  // A connection signed in through a managed service is withdrawn there by its own hook.
  if (configuration.via === 'composio') return undefined;
  if (kind && MICROSOFT_KINDS.includes(kind)) return 'not_offered';
  if (kind && GOOGLE_KINDS.includes(kind)) {
    const credential = await options.secrets.withSecret(ref, connection.spaceId, async (value) =>
      signedInCredential.parse(JSON.parse(value)),
    );
    const [shared] = await options.sql`select 1 from connection
      where id <> ${connection.id} and status <> 'revoked'
        and configuration->>'kind' = any(${GOOGLE_KINDS})
        and lower(configuration->>'account') = lower(${credential.account})
        and coalesce(configuration->>'via', '') <> 'composio'
      limit 1`;
    if (shared) return 'kept_for_other_connections';
    if (!options.google) return 'not_confirmed';
    const issuer = googleIssuer(
      options.google.client,
      '',
      options.google.endpoints ?? GOOGLE_ENDPOINTS,
    );
    const done = await revokeToken(
      issuer,
      credential.refresh_token
        ? { value: credential.refresh_token, hint: 'refresh_token' }
        : { value: credential.access_token, hint: 'access_token' },
      options.fetcher ?? ((request) => fetch(request)),
    );
    return done ? 'withdrawn' : 'not_confirmed';
  }
  if (connection.provider === 'mcp') {
    const credential = await options.secrets
      .withSecret(ref, connection.spaceId, async (value) => mcpCredentials.parse(JSON.parse(value)))
      .catch(() => null);
    // A key the person pasted in is theirs to delete where they made it.
    if (!credential?.token_url || !options.mcpFetch) return 'not_offered';
    const fetcher = await options.mcpFetch(connection.spaceId);
    const found = await discoverIssuer(new URL(credential.token_url).origin, fetcher).catch(
      () => null,
    );
    if (!found?.revokeUrl) return 'not_offered';
    const issuer: OAuthIssuer = {
      provider: 'mcp',
      authorizeUrl: found.authorizeUrl,
      tokenUrl: found.tokenUrl,
      revokeUrl: found.revokeUrl,
      clientId: credential.client_id ?? '',
      ...(credential.client_secret ? { clientSecret: credential.client_secret } : {}),
      scopes: '',
      redirectUri: '',
      refreshEncoding: 'form',
    };
    const done = await revokeToken(
      issuer,
      credential.refresh_token
        ? { value: credential.refresh_token, hint: 'refresh_token' }
        : { value: credential.access_token, hint: 'access_token' },
      fetcher,
    );
    return done ? 'withdrawn' : 'not_confirmed';
  }
  // A key, an app password or a token the person made for Melete.
  return 'not_offered';
}

/** An MCP issuer is reached the way its server is: only where the space may reach. */
export function mcpIssuerFetch(sql: Sql) {
  return async (spaceId: string): Promise<OAuthFetch> => {
    const pinned = reachFetch({ reach: await spaceReach(sql, spaceId) });
    return async (request) =>
      pinned(request.url, {
        method: request.method,
        headers: request.headers,
        redirect: 'error',
        signal: request.signal,
        ...(request.body ? { body: await request.text() } : {}),
      });
  };
}

/**
 * Sealed tokens nothing points at, left by refreshes and disconnections before
 * each removed its own: deleted once a day has passed, so a sign-in that has
 * sealed its tokens and not yet saved its connection is never caught midway.
 * Answers how many went.
 */
export async function sweepUnreferencedSecrets(sql: Sql, now = Date.now()): Promise<number> {
  const inUse = await sql<{ id: string }[]>`select secret_ref as id from connection
    where secret_ref is not null`;
  return new PostgresSecretRepository(sql).forgetUnreferenced(
    inUse.map((row) => row.id),
    new Date(now - 24 * 60 * 60 * 1000),
  );
}
