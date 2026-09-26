/**
 * Signing in with Google, and holding what that sign-in earns. One consent
 * grants Gmail and Google Calendar together; each connection it creates keeps
 * its own sealed copy of the tokens and reads them from its row on every call,
 * so signing in again replaces the credential of a connection that is already
 * running.
 *
 * The endpoints are fixed here, never read from a row or a request. A test
 * replaces them through the connector factory, the one place that builds these
 * connectors.
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

export type GoogleEndpoints = {
  authorize: string;
  token: string;
  revoke: string;
  /** The signed-in person's mailbox, `.../gmail/v1/users/me`. */
  gmail: string;
  /** The signed-in person's primary calendar, `.../calendar/v3/calendars/primary`. */
  calendar: string;
};

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  calendar: 'https://www.googleapis.com/calendar/v3/calendars/primary',
};

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Reading mail, sending it, and the calendar's events. Drafts stay in Melete,
 * where approval already covers them, so no Gmail draft scope is asked for.
 */
export const GOOGLE_SCOPES = {
  mailRead: 'https://www.googleapis.com/auth/gmail.readonly',
  mailSend: 'https://www.googleapis.com/auth/gmail.send',
  calendar: 'https://www.googleapis.com/auth/calendar.events',
} as const;

export const GOOGLE_SIGN_IN_SCOPE = [
  'openid',
  'email',
  GOOGLE_SCOPES.mailRead,
  GOOGLE_SCOPES.mailSend,
  GOOGLE_SCOPES.calendar,
].join(' ');

export type GoogleClient = { clientId: string; clientSecret: string };

export function googleIssuer(
  client: GoogleClient,
  redirectUri: string,
  endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
): OAuthIssuer {
  return {
    provider: 'google',
    authorizeUrl: endpoints.authorize,
    tokenUrl: endpoints.token,
    revokeUrl: endpoints.revoke,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    scopes: GOOGLE_SIGN_IN_SCOPE,
    redirectUri,
    // A refresh token is issued only for offline access, and again on every
    // sign-in only when consent is asked for, so signing in again renews it.
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    refreshEncoding: 'form',
  };
}

/** What one connection keeps sealed. */
export const googleCredential = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384).optional(),
    /** Milliseconds since the epoch. */
    expires_at: z.number().int().positive().optional(),
    scope: z.string().max(4096),
    account: z.email(),
  })
  .strict();
export type GoogleCredential = z.infer<typeof googleCredential>;

export function googleCredentialFrom(tokens: OAuthTokens, account: string): GoogleCredential {
  return googleCredential.parse({
    access_token: tokens.accessToken,
    ...(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expires_at: tokens.expiresAt } : {}),
    scope: tokens.scope ?? GOOGLE_SIGN_IN_SCOPE,
    account,
  });
}

/**
 * The sign-in is over: the refresh token was refused, the person removed
 * access, or the connection was removed. Only signing in again helps.
 */
export class GoogleSignInEnded extends Error {
  readonly signInEnded = true;
  constructor() {
    super('google_sign_in_ended');
  }
}

export interface GoogleAccess {
  /** A current access token, refreshed first when it is about to expire. */
  token(): Promise<string>;
  /** The token after `used` was refused: a newer one, or a refreshed one. */
  renew(used: string): Promise<string>;
}

const EARLY_REFRESH_MS = 60_000;

/**
 * The tokens of one connection, read from its row each time. A refresh runs
 * once at a time in this process; the new tokens are sealed and replace the
 * row's secret only while the row still holds the one refreshed from.
 */
export function googleAccess(options: {
  sql: Sql;
  secrets: SealedSecretStore;
  connectionId: string;
  spaceId: string;
  issuer: OAuthIssuer;
  fetcher?: OAuthFetch;
  now?: () => number;
}): GoogleAccess {
  const now = options.now ?? Date.now;
  const fetcher: OAuthFetch = options.fetcher ?? ((request) => fetch(request));
  let refreshing: Promise<string> | undefined;

  const read = async () => {
    const [row] = await options.sql`select secret_ref, status from connection
      where id = ${options.connectionId} and space_id = ${options.spaceId}`;
    if (!row?.secret_ref || row.status === 'revoked') throw new GoogleSignInEnded();
    const ref = String(row.secret_ref);
    const credential = await options.secrets.withSecret(ref, options.spaceId, async (value) =>
      googleCredential.parse(JSON.parse(value)),
    );
    return { ref, credential };
  };

  const refresh = (): Promise<string> => {
    refreshing ??= (async () => {
      const { ref, credential } = await read();
      if (!credential.refresh_token) throw new GoogleSignInEnded();
      let tokens: OAuthTokens;
      try {
        tokens = await refreshTokens(options.issuer, credential.refresh_token, fetcher, now());
      } catch (error) {
        if (error instanceof OAuthFailure && error.permanent) throw new GoogleSignInEnded();
        throw error;
      }
      const next: GoogleCredential = {
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
 * One call to a Google API with the connection's token. A 401 is answered once
 * with a renewed token; a second 401 is returned for the caller to judge.
 */
export async function googleRequest(
  access: GoogleAccess,
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

/** A response body as JSON, refused past `limit` bytes rather than read whole. */
export async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? '0') > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Google response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Google response too large');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

/** The reason Google names in an error body, such as `rateLimitExceeded`. */
export function googleErrorReason(body: unknown): string | undefined {
  const error = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)
    ?.error;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}
