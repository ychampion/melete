/**
 * What an account sign-in earns, and how a connection holds it. Each
 * connection a sign-in creates keeps its own sealed copy of the tokens and
 * reads them from its row on every call, so signing in again replaces the
 * credential of a connection that is already running. Google and Microsoft
 * connections both use this; only their endpoints and scopes differ.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import {
  OAuthFailure,
  type OAuthFetch,
  type OAuthIssuer,
  type OAuthTokens,
  refreshTokens,
} from '../gateway/oauth.ts';
import type { SealedSecretStore } from './secrets.ts';

/** An OAuth client the operator registered with a provider. */
export type AccountClient = { clientId: string; clientSecret: string };

/** What one connection keeps sealed. */
export const signedInCredential = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384).optional(),
    /** Milliseconds since the epoch. */
    expires_at: z.number().int().positive().optional(),
    scope: z.string().max(4096),
    account: z.email(),
  })
  .strict();
export type SignedInCredential = z.infer<typeof signedInCredential>;

export function signedInCredentialFrom(
  tokens: OAuthTokens,
  account: string,
  requestedScope: string,
): SignedInCredential {
  return signedInCredential.parse({
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expires_at: tokens.expiresAt } : {}),
    // An issuer that leaves `scope` out granted what was asked for (RFC 6749, 5.1).
    scope: tokens.scope ?? requestedScope,
    account,
  });
}

/**
 * The sign-in is over: the refresh token was refused, the person removed
 * access, or the connection was removed. Only signing in again helps.
 */
export class SignInEnded extends Error {
  readonly signInEnded = true;
  constructor() {
    super('sign_in_ended');
  }
}

export interface SignedInAccess {
  /** A current access token, refreshed first when it is about to expire. */
  token(): Promise<string>;
  /** The token after `used` was refused: a newer one, or a refreshed one. */
  renew(used: string): Promise<string>;
}

const EARLY_REFRESH_MS = 60_000;

/**
 * The tokens of one connection, read from its row each time. A refresh runs
 * once at a time in this process; the new tokens are sealed and replace the
 * row's secret only while the row still holds the one refreshed from. An
 * issuer that rotates refresh tokens hands back a new one, which is kept.
 */
export function signedInAccess(options: {
  sql: Sql;
  secrets: SealedSecretStore;
  connectionId: string;
  spaceId: string;
  issuer: OAuthIssuer;
  fetcher?: OAuthFetch;
  now?: () => number;
}): SignedInAccess {
  const now = options.now ?? Date.now;
  const fetcher: OAuthFetch = options.fetcher ?? ((request) => fetch(request));
  let refreshing: Promise<string> | undefined;

  const read = async () => {
    const [row] = await options.sql`select secret_ref, status from connection
      where id = ${options.connectionId} and space_id = ${options.spaceId}`;
    if (!row?.secret_ref || row.status === 'revoked') throw new SignInEnded();
    const ref = String(row.secret_ref);
    const credential = await options.secrets.withSecret(ref, options.spaceId, async (value) =>
      signedInCredential.parse(JSON.parse(value)),
    );
    return { ref, credential };
  };

  const refresh = (): Promise<string> => {
    refreshing ??= (async () => {
      const { ref, credential } = await read();
      if (!credential.refresh_token) throw new SignInEnded();
      let tokens: OAuthTokens;
      try {
        tokens = await refreshTokens(options.issuer, credential.refresh_token, fetcher, now());
      } catch (error) {
        if (error instanceof OAuthFailure && error.permanent) throw new SignInEnded();
        throw error;
      }
      const next: SignedInCredential = {
        ...credential,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? credential.refresh_token,
        expires_at: tokens.expiresAt,
        scope: tokens.scope ?? credential.scope,
      };
      const sealed = await options.secrets.put(options.spaceId, JSON.stringify(next));
      // A sign-in that replaced the secret meanwhile wins; this token still serves this call.
      await options.sql`update connection set secret_ref = ${sealed}
        where id = ${options.connectionId} and space_id = ${options.spaceId}
          and secret_ref = ${ref} and status <> 'revoked'`;
      return next.access_token;
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  return {
    async token() {
      const { credential } = await read();
      if (credential.expires_at && credential.expires_at - EARLY_REFRESH_MS <= now())
        return refresh();
      return credential.access_token;
    },
    async renew(used) {
      const { credential } = await read();
      return credential.access_token !== used ? credential.access_token : refresh();
    },
  };
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * One API call with the connection's token. A 401 is answered once with a
 * renewed token; a second 401 is returned for the caller to judge.
 */
export async function bearerRequest(
  access: SignedInAccess,
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal },
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let token = await access.token();
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetcher(url, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: 'error',
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    if (response.status !== 401 || attempt > 0) return response;
    await response.body?.cancel().catch(() => {});
    token = await access.renew(token);
  }
}

/** A response larger than its reader allows. */
export class ResponseTooLarge extends Error {
  constructor() {
    super('response too large');
  }
}

/** A response body's bytes, refused past `limit` rather than read whole. */
export async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? '0') > limit) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ResponseTooLarge();
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

/** A response body as JSON, refused past `limit` bytes rather than read whole. */
export async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const text = (await boundedBytes(response, limit)).toString('utf8');
  return text ? JSON.parse(text) : null;
}
