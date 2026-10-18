/**
 * What the session middleware and the setup status need to know about
 * sign-in through an identity provider (see oidc.ts), kept apart from the
 * routes so auth.ts and oidc.ts do not import each other.
 */
import type { Env } from '../env.ts';

export const OIDC_PATHS = {
  start: '/signin/oidc/start',
  callback: '/signin/oidc/callback',
  logout: '/signin/oidc/logout',
} as const;

/** The three routes anyone may call: a person on their way in has no session yet. */
export function oidcPublicPath(method: string, path: string): boolean {
  if (method === 'GET') return path === OIDC_PATHS.start || path === OIDC_PATHS.callback;
  return method === 'POST' && path === OIDC_PATHS.logout;
}

/** Routes a password or an emailed link signs in through, which `MELETE_PASSWORD_SIGNIN=off` closes. */
export const PASSWORD_SIGNIN_PATHS = [
  '/login',
  '/signin/magic-link',
  '/signin/magic-link/check',
  '/signin/magic-link/consume',
  '/password-reset',
  '/password-reset/check',
  '/password-reset/consume',
];

export const oidcConfigured = (env: Env): boolean =>
  Boolean(
    env.MELETE_OIDC_ISSUER &&
      env.MELETE_OIDC_CLIENT_ID &&
      env.MELETE_OIDC_CLIENT_SECRET &&
      env.MELETE_PUBLIC_URL,
  );

/** What the sign-in page offers: the setup status's `signin`. */
export function signInMethods(env: Env): {
  password: boolean;
  oidc: { label: string } | null;
} {
  return {
    password: env.MELETE_PASSWORD_SIGNIN,
    oidc: oidcConfigured(env) ? { label: env.MELETE_OIDC_LABEL } : null,
  };
}
