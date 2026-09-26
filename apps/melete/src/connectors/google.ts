/**
 * Signing in with Google: its endpoints, the scopes one consent asks for, and
 * how a Google sign-in names its account and what it granted. The endpoints
 * are fixed here, never read from a row or a request. A test replaces them
 * through the connector factory, the one place that builds these connectors.
 */
import { jwtClaims, type OAuthIssuer } from '../gateway/oauth.ts';
import {
  type AccountProvider,
  CALENDAR_GRANTS,
  MAIL_READ_GRANTS,
  SignInFailure,
} from './account-sign-in.ts';
import type { AccountClient } from './signed-in.ts';

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

export function googleIssuer(
  client: AccountClient,
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

export function googleProvider(
  client: AccountClient,
  endpoints: GoogleEndpoints = GOOGLE_ENDPOINTS,
): AccountProvider {
  return {
    name: 'google',
    issuer: (redirectUri) => googleIssuer(client, redirectUri, endpoints),
    /**
     * The id token came from Google's token endpoint over TLS: it must be for
     * this client, from Google, and for a verified address.
     */
    async account(tokens, clientId) {
      const claims = jwtClaims(tokens.idToken);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        typeof claims.email !== 'string' ||
        claims.email_verified !== true ||
        !audience.includes(clientId) ||
        !GOOGLE_ISSUERS.includes(String(claims.iss))
      )
        throw new SignInFailure('account_unverified');
      return claims.email.toLowerCase();
    },
    grants(granted) {
      const scopes = new Set(granted.split(/\s+/));
      return {
        ...(scopes.has(GOOGLE_SCOPES.mailRead)
          ? {
              mail: [
                ...MAIL_READ_GRANTS,
                ...(scopes.has(GOOGLE_SCOPES.mailSend) ? ['email.send'] : []),
              ],
            }
          : {}),
        ...(scopes.has(GOOGLE_SCOPES.calendar) ? { calendar: CALENDAR_GRANTS } : {}),
      };
    },
    labels: (account) => ({ mail: `Gmail (${account})`, calendar: `Google Calendar (${account})` }),
  };
}

/** The reason Google names in an error body, such as `rateLimitExceeded`. */
export function googleErrorReason(body: unknown): string | undefined {
  const error = (body as { error?: { errors?: { reason?: unknown }[] } } | null)?.error;
  const reason = error?.errors?.[0]?.reason;
  return typeof reason === 'string' ? reason : undefined;
}
