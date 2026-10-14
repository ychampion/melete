/**
 * What disconnecting an account does beyond Melete's own rows.
 *
 * The connection's sealed tokens are deleted, every copy of them, and where
 * the provider lets an app withdraw its own access (RFC 7009, or GitHub's own
 * app authorization API), Melete asks it to, so the token is dead at the
 * provider too and not only forgotten here.
 *
 * One Google sign-in can stand behind several connections (mail, calendar,
 * Drive), each with its own sealed copy of the same grant. Google withdraws a
 * grant whole, so while another connection still uses that account the grant
 * is left alone and the person is told so. Microsoft offers no way for an app
 * to withdraw its own sign-in, and a key, token or password the person made
 * for Melete is theirs to delete: they may use it elsewhere too. In both cases
 * the answer names the page where the person does it, where there is one.
 *
 * A space that is removed has its access withdrawn the same way, before its
 * sealed tokens go with it.
 */
import type { ProviderAccess, ProviderRevokeAt } from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { type OAuthFetch, type OAuthIssuer, revokeToken } from '../gateway/oauth.ts';
import { GOOGLE_ENDPOINTS, type GoogleEndpoints, googleIssuer } from './google.ts';
import { mcpCredentials } from './mcp-credentials.ts';
import { metadataLocations, secureEndpoint } from './mcp-oauth.ts';
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

/** What a disconnection did at the provider, as the lifecycle answer carries it. */
export type ProviderOutcome = { provider_access: ProviderAccess; revoke_at?: ProviderRevokeAt };

const GOOGLE_KINDS = ['gmail', 'google_calendar', 'google_drive'];
const MICROSOFT_KINDS = ['outlook_mail', 'outlook_calendar'];

/** GitHub's sign-in, which publishes no RFC 7009 endpoint; an app withdraws through the REST API. */
const GITHUB_ISSUER = 'https://github.com/login/oauth';
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 65_536;

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

const logger = (options: RevocationOptions) =>
  options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
const reason = (error: unknown) => (error instanceof Error ? error.message : 'error');

/**
 * For the policy service's `afterRevoke`: withdraw the access at the provider
 * where that is possible, then delete the sealed tokens. It never undoes the
 * disconnection, and the tokens are deleted whatever the provider answered,
 * unless another connection still points at the same sealed copy: then the
 * copy, and the access it carries, stay for that connection.
 */
export function connectionRevocation(options: RevocationOptions, boundMs = 20_000) {
  const log = logger(options);
  return async (connection: RevokedConnection): Promise<ProviderOutcome | undefined> => {
    const ref = connection.secretRef;
    if (!ref) return undefined;
    const [shared] = await options.sql`select 1 from connection
      where secret_ref = ${ref} and id <> ${connection.id} limit 1`;
    if (shared) return { provider_access: 'kept_for_other_connections' };
    let outcome: ProviderOutcome | undefined;
    try {
      // Bounded, so a provider that does not answer cannot hold the disconnection up.
      outcome = await within(boundMs, withdraw(options, connection, ref));
    } catch {
      outcome = { provider_access: 'not_confirmed' };
    }
    // Read before the copy goes: which page it is can depend on the token.
    if (
      outcome &&
      !outcome.revoke_at &&
      (outcome.provider_access === 'not_offered' || outcome.provider_access === 'not_confirmed')
    ) {
      const at = await whereToRevoke(options, connection, ref).catch(() => undefined);
      if (at) outcome = { ...outcome, revoke_at: at };
    }
    try {
      await options.secrets.forget(ref, connection.spaceId);
    } catch (error) {
      // The startup sweep removes it later; nothing points at it any more.
      log(
        `connections: the sealed tokens of ${connection.id} were not deleted yet (${reason(error)})`,
      );
    }
    if (outcome?.provider_access === 'not_confirmed')
      log(`connections: the provider did not confirm withdrawing ${connection.id}'s access`);
    return outcome;
  };
}

/**
 * For a space being removed: withdraw at each provider the access the space's
 * connections hold, before their sealed tokens are deleted with the space.
 * Best effort and bounded per connection; it never stops the removal, and
 * running it twice asks the providers twice, which they answer the same way.
 */
export function spaceAccessWithdrawal(options: RevocationOptions, boundMs = 20_000) {
  const log = logger(options);
  return async (spaceId: string): Promise<void> => {
    const rows = await options.sql<
      { id: string; provider: string; configuration: unknown; secret_ref: string }[]
    >`select id, provider, configuration, secret_ref from connection
      where space_id = ${spaceId} and secret_ref is not null order by id`;
    const asked = new Set<string>();
    for (const row of rows) {
      const ref = String(row.secret_ref);
      if (asked.has(ref)) continue;
      asked.add(ref);
      const connection = {
        id: row.id,
        spaceId,
        provider: row.provider,
        configuration: row.configuration,
        secretRef: ref,
      };
      try {
        const outcome = await within(boundMs, withdraw(options, connection, ref, spaceId));
        if (outcome?.provider_access === 'not_confirmed')
          log(`connections: the provider did not confirm withdrawing ${row.id}'s access`);
      } catch (error) {
        log(`connections: the provider access of ${row.id} was not withdrawn (${reason(error)})`);
      }
    }
  };
}

async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the provider did not answer in time')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the provider to withdraw the connection's access. `leaving` names a
 * space being removed: its other connections no longer count as still using
 * a shared grant.
 */
async function withdraw(
  options: RevocationOptions,
  connection: RevokedConnection,
  ref: string,
  leaving?: string,
): Promise<ProviderOutcome | undefined> {
  const configuration = (connection.configuration ?? {}) as Record<string, unknown>;
  const kind = typeof configuration.kind === 'string' ? configuration.kind : null;
  // A connection signed in through a managed service is withdrawn there by its own hook.
  if (configuration.via === 'composio') return undefined;
  if (kind && MICROSOFT_KINDS.includes(kind)) return { provider_access: 'not_offered' };
  if (kind && GOOGLE_KINDS.includes(kind)) {
    const credential = await options.secrets.withSecret(ref, connection.spaceId, async (value) =>
      signedInCredential.parse(JSON.parse(value)),
    );
    const [shared] = await options.sql`select 1 from connection
      where id <> ${connection.id} and status <> 'revoked'
        and configuration->>'kind' = any(${GOOGLE_KINDS})
        and lower(configuration->>'account') = lower(${credential.account})
        and coalesce(configuration->>'via', '') <> 'composio'
        and (${leaving ?? null}::text is null or space_id <> ${leaving ?? null}::text)
      limit 1`;
    if (shared) return { provider_access: 'kept_for_other_connections' };
    if (!options.google) return { provider_access: 'not_confirmed' };
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
    return { provider_access: done ? 'withdrawn' : 'not_confirmed' };
  }
  if (connection.provider === 'mcp') {
    const credential = await options.secrets
      .withSecret(ref, connection.spaceId, async (value) => mcpCredentials.parse(JSON.parse(value)))
      .catch(() => null);
    // A key the person pasted in has no client: it is theirs to delete where they made it.
    if (!credential?.client_id || !options.mcpFetch) return { provider_access: 'not_offered' };
    const fetcher = await options.mcpFetch(connection.spaceId);
    const server = await mcpAuthorization(credential, fetcher);
    if (!server) return { provider_access: 'not_offered' };
    if (server.issuer === GITHUB_ISSUER)
      return withdrawGithub(options, connection, credential, fetcher, leaving);
    if (!server.revokeUrl) return { provider_access: 'not_offered' };
    const issuer: OAuthIssuer = {
      provider: 'mcp',
      authorizeUrl: '',
      tokenUrl: server.tokenUrl,
      revokeUrl: server.revokeUrl,
      clientId: credential.client_id,
      // The secret goes only beside the token endpoint the credential is
      // refreshed at. An issuer found from what the server names now was
      // never checked against the one that issued the token.
      ...(credential.client_secret && credential.token_url
        ? { clientSecret: credential.client_secret }
        : {}),
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
    return { provider_access: done ? 'withdrawn' : 'not_confirmed' };
  }
  // A key, an app password or a token the person made for Melete.
  return { provider_access: 'not_offered' };
}

type McpCredential = z.infer<typeof mcpCredentials>;

const authorizationServerMetadata = z.object({
  issuer: z.string(),
  token_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
});
const protectedResourceMetadata = z.object({
  authorization_servers: z.array(z.string()).min(1),
});

/**
 * The authorization server that issued an MCP credential, found as signing in
 * found it: from the token endpoint the credential was refreshed at (its
 * issuer is that address's origin or a path above it), or from what the
 * server it was issued for names. A document counts only when it names the
 * issuer it was fetched for and, where the credential has one, the same token
 * endpoint; its revocation endpoint only when it is on the token endpoint's
 * own origin.
 */
async function mcpAuthorization(
  credential: McpCredential,
  fetcher: OAuthFetch,
): Promise<{ issuer: string; tokenUrl: string; revokeUrl?: string } | null> {
  const issuers: string[] = [];
  if (credential.token_url) {
    const token = new URL(credential.token_url);
    const segments = token.pathname.split('/').filter(Boolean);
    for (let depth = 0; depth < segments.length && depth <= 3; depth += 1)
      issuers.push(
        `${token.origin}${segments
          .slice(0, depth)
          .map((s) => `/${s}`)
          .join('')}`,
      );
  }
  if (credential.resource)
    for (const server of await authorizationServersOf(credential.resource, fetcher))
      if (!issuers.includes(server)) issuers.push(server);
  for (const issuer of issuers.slice(0, 6)) {
    for (const location of metadataLocations(issuer)) {
      const parsed = authorizationServerMetadata.safeParse(await getJson(fetcher, location));
      if (!parsed.success || parsed.data.issuer !== issuer) continue;
      const { token_endpoint: tokenUrl, revocation_endpoint: revokeUrl } = parsed.data;
      if (!secureEndpoint(tokenUrl)) continue;
      if (credential.token_url && new URL(tokenUrl).href !== new URL(credential.token_url).href)
        continue;
      const revocable =
        revokeUrl &&
        secureEndpoint(revokeUrl) &&
        new URL(revokeUrl).origin === new URL(tokenUrl).origin;
      return { issuer, tokenUrl, ...(revocable ? { revokeUrl } : {}) };
    }
  }
  return null;
}

/** The authorization servers an MCP server's protected resource metadata names. */
async function authorizationServersOf(resource: string, fetcher: OAuthFetch): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return [];
  }
  const path = url.pathname.replace(/\/$/, '');
  for (const location of [
    ...(path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${url.origin}/.well-known/oauth-protected-resource`,
  ]) {
    const parsed = protectedResourceMetadata.safeParse(await getJson(fetcher, location));
    if (parsed.success) return parsed.data.authorization_servers.filter(secureEndpoint);
  }
  return [];
}

async function getJson(fetcher: OAuthFetch, url: string): Promise<unknown> {
  if (!secureEndpoint(url)) return null;
  try {
    const response = await fetcher(
      new Request(url, {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const text = await response.text();
    return text.length > MAX_METADATA_BYTES ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * GitHub withdraws an app's access through its REST API, with the app's own
 * client id and secret. The whole grant goes when no other connection could
 * stand on it; otherwise only this connection's token does.
 */
async function withdrawGithub(
  options: RevocationOptions,
  connection: RevokedConnection,
  credential: McpCredential,
  fetcher: OAuthFetch,
  leaving: string | undefined,
): Promise<ProviderOutcome> {
  const revokeAt = { name: 'GitHub', url: 'https://github.com/settings/applications' };
  if (!credential.client_id || !credential.client_secret)
    return { provider_access: 'not_offered', revoke_at: revokeAt };
  const server = (connection.configuration as { server?: { endpoint?: { url?: unknown } } } | null)
    ?.server?.endpoint?.url;
  const [other] = await options.sql`select 1 from connection
    where id <> ${connection.id} and provider = 'mcp' and status <> 'revoked'
      and secret_ref is not null
      and (${typeof server === 'string' ? server : null}::text is null
        or configuration->'server'->'endpoint'->>'url' = ${typeof server === 'string' ? server : null}::text)
      and (${leaving ?? null}::text is null or space_id <> ${leaving ?? null}::text)
    limit 1`;
  const basic = Buffer.from(`${credential.client_id}:${credential.client_secret}`).toString(
    'base64',
  );
  try {
    const response = await fetcher(
      new Request(
        `${GITHUB_API}/applications/${encodeURIComponent(credential.client_id)}/${other ? 'token' : 'grant'}`,
        {
          method: 'DELETE',
          redirect: 'error',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Basic ${basic}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          body: JSON.stringify({ access_token: credential.access_token }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      ),
    );
    await response.body?.cancel().catch(() => {});
    return response.status === 204
      ? { provider_access: 'withdrawn' }
      : { provider_access: 'not_confirmed', revoke_at: revokeAt };
  } catch {
    return { provider_access: 'not_confirmed', revoke_at: revokeAt };
  }
}

/**
 * Where the person cancels a credential Melete could not withdraw itself: the
 * provider's own page for it, where there is one Melete can name.
 */
async function whereToRevoke(
  options: RevocationOptions,
  connection: RevokedConnection,
  ref: string,
): Promise<ProviderRevokeAt | undefined> {
  const configuration = (connection.configuration ?? {}) as Record<string, unknown>;
  const kind = typeof configuration.kind === 'string' ? configuration.kind : null;
  if (kind && GOOGLE_KINDS.includes(kind))
    return { name: 'Google', url: 'https://myaccount.google.com/linkedapps' };
  if (kind && MICROSOFT_KINDS.includes(kind)) {
    const account = typeof configuration.account === 'string' ? configuration.account : '';
    // Personal accounts list the apps they let in on one page; work and school accounts on another.
    return /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(account)
      ? { name: 'Microsoft', url: 'https://account.live.com/consent/Manage' }
      : { name: 'Microsoft', url: 'https://myapps.microsoft.com' };
  }
  if (connection.provider === 'command_line') {
    const adapter = configuration.adapter;
    if (adapter === 'github') {
      // Classic and fine-grained tokens are listed on different pages.
      const token = await options.secrets
        .withSecret(ref, connection.spaceId, async (value) => value.slice(0, 12))
        .catch(() => '');
      return {
        name: 'GitHub',
        url: token.startsWith('ghp_')
          ? 'https://github.com/settings/tokens'
          : token.startsWith('gho_') || token.startsWith('ghu_')
            ? 'https://github.com/settings/applications'
            : 'https://github.com/settings/personal-access-tokens',
      };
    }
    if (adapter === 'gitlab')
      return { name: 'GitLab', url: 'https://gitlab.com/-/user_settings/personal_access_tokens' };
    if (adapter === 'npm')
      return { name: 'npm', url: 'https://docs.npmjs.com/revoking-access-tokens' };
    if (adapter === 'aws') return { name: 'AWS', url: 'https://console.aws.amazon.com/iam/' };
    return undefined;
  }
  if (connection.provider === 'twilio')
    return { name: 'Twilio', url: 'https://console.twilio.com' };
  if (kind === 'mail' || kind === 'caldav') {
    const host =
      kind === 'mail'
        ? (configuration.mail as { imap?: { host?: unknown } } | undefined)?.imap?.host
        : (() => {
            const address = (configuration.caldav as { calendar_url?: unknown } | undefined)
              ?.calendar_url;
            return typeof address === 'string' && URL.canParse(address)
              ? new URL(address).hostname
              : undefined;
          })();
    // An app password made for Melete is deleted where it was made.
    if (
      typeof host === 'string' &&
      /(^|\.)(gmail|googlemail|google|googleusercontent)\.com$/i.test(host)
    )
      return { name: 'Google', url: 'https://myaccount.google.com/apppasswords' };
  }
  return undefined;
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
    new Date(now - DAY_MS),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sweep sealed tokens nothing uses now and once a day after, by whichever
 * instance leads the work; the returned function stops it.
 */
export function startSecretSweep(
  sql: Sql,
  leads: () => Promise<boolean> = async () => true,
  everyMs = DAY_MS,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  const sweep = () => {
    void leads()
      .then((leading) => (leading ? sweepUnreferencedSecrets(sql) : 0))
      .then((count) => {
        if (count) say(`connections: deleted ${count} sealed tokens nothing used`);
      })
      .catch((error: unknown) =>
        say(
          `connections: unused sealed tokens were not checked (${error instanceof Error ? error.message : 'error'})`,
        ),
      );
  };
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
