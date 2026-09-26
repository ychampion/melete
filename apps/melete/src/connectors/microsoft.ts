/**
 * Signing in with Microsoft: the identity platform's endpoints, the Microsoft
 * Graph scopes one consent asks for, and how a Microsoft sign-in names its
 * account and what it granted. Personal accounts (Outlook.com) and work or
 * school accounts both sign in through the `common` tenant unless the operator
 * names one. The endpoints are fixed here; only a test replaces them.
 */
import { z } from 'zod';
import { jwtClaims, type OAuthIssuer } from '../gateway/oauth.ts';
import {
  type AccountProvider,
  CALENDAR_GRANTS,
  MAIL_READ_GRANTS,
  SignInFailure,
} from './account-sign-in.ts';
import { type AccountClient, boundedJson } from './signed-in.ts';

export type MicrosoftEndpoints = {
  authorize: string;
  token: string;
  /** The signed-in person, `https://graph.microsoft.com/v1.0/me`. */
  graph: string;
};

export function microsoftEndpoints(tenant = 'common'): MicrosoftEndpoints {
  const authority = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
  return {
    authorize: `${authority}/authorize`,
    token: `${authority}/token`,
    graph: 'https://graph.microsoft.com/v1.0/me',
  };
}

const GRAPH = 'https://graph.microsoft.com/';

/**
 * The person's own address, reading mail, sending it, and the calendar. Drafts
 * stay in Melete, as they do for every mailbox.
 */
export const MICROSOFT_SCOPES = {
  profile: `${GRAPH}User.Read`,
  mailRead: `${GRAPH}Mail.Read`,
  mailSend: `${GRAPH}Mail.Send`,
  calendar: `${GRAPH}Calendars.ReadWrite`,
} as const;

export const MICROSOFT_SIGN_IN_SCOPE = [
  'openid',
  'email',
  'offline_access',
  ...Object.values(MICROSOFT_SCOPES),
].join(' ');

/** A v2.0 id token names the tenant that issued it. */
const ISSUER = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/;
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function microsoftIssuer(
  client: AccountClient,
  redirectUri: string,
  endpoints: MicrosoftEndpoints,
): OAuthIssuer {
  return {
    provider: 'microsoft',
    authorizeUrl: endpoints.authorize,
    tokenUrl: endpoints.token,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    scopes: MICROSOFT_SIGN_IN_SCOPE,
    redirectUri,
    refreshEncoding: 'form',
  };
}

/** Graph names its scopes with or without the resource prefix; compare the short names. */
function shortScopes(granted: string): Set<string> {
  return new Set(
    granted
      .split(/\s+/)
      .filter(Boolean)
      .map((scope) => (scope.startsWith(GRAPH) ? scope.slice(GRAPH.length) : scope).toLowerCase()),
  );
}

const profile = z.object({
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});

export function microsoftProvider(
  client: AccountClient,
  options: { tenant?: string; endpoints?: MicrosoftEndpoints; fetcher?: typeof fetch } = {},
): AccountProvider {
  const tenant = options.tenant ?? 'common';
  const endpoints = options.endpoints ?? microsoftEndpoints(tenant);
  const fetcher = options.fetcher ?? fetch;
  return {
    name: 'microsoft',
    issuer: (redirectUri) => microsoftIssuer(client, redirectUri, endpoints),
    /**
     * The id token must be for this client and from the identity platform (and
     * from the operator's tenant when one is named). The address is the one
     * Graph gives for the signed-in person, which is where mail is sent from.
     */
    async account(tokens, clientId) {
      const claims = jwtClaims(tokens.idToken);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const issued = ISSUER.exec(String(claims.iss));
      if (
        !audience.includes(clientId) ||
        !issued ||
        (TENANT_ID.test(tenant) && issued[1] !== tenant)
      )
        throw new SignInFailure('account_unverified');
      let answer: unknown;
      try {
        const response = await fetcher(`${endpoints.graph}?$select=mail,userPrincipalName`, {
          headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new SignInFailure('account_unverified');
        }
        answer = await boundedJson(response, 64 * 1024);
      } catch (error) {
        if (error instanceof SignInFailure) throw error;
        throw new SignInFailure('provider_unreachable');
      }
      const person = profile.safeParse(answer);
      const address = z
        .email()
        .safeParse(person.data?.mail ?? person.data?.userPrincipalName ?? '');
      if (!address.success) throw new SignInFailure('account_unverified');
      return address.data.toLowerCase();
    },
    grants(granted) {
      const scopes = shortScopes(granted);
      return {
        ...(scopes.has('mail.read')
          ? { mail: [...MAIL_READ_GRANTS, ...(scopes.has('mail.send') ? ['email.send'] : [])] }
          : {}),
        ...(scopes.has('calendars.readwrite') ? { calendar: CALENDAR_GRANTS } : {}),
      };
    },
    labels: (account) => ({
      mail: `Outlook (${account})`,
      calendar: `Outlook Calendar (${account})`,
    }),
  };
}

/** The code Graph names in an error body, such as `ErrorIrresolvableConflict`. */
export function graphErrorCode(body: unknown): string | undefined {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === 'string' ? code : undefined;
}
