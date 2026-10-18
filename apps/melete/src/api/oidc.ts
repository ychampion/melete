/**
 * Sign-in with the installation's own OpenID Connect identity provider.
 *
 * `GET /signin/oidc/start` reads the provider's metadata, then sends the
 * browser there with PKCE, a state and a nonce. Those three, and where to come
 * back to in the app, travel in a short-lived cookie this service seals, so
 * nothing is stored before the person returns.
 *
 * `GET /signin/oidc/callback` checks the state against the cookie and the
 * issuer the provider names, spends the state so the same answer never works
 * twice, exchanges the code, and verifies the ID token against the provider's
 * published keys: signature (asymmetric algorithms only), issuer, audience,
 * expiry, nonce and a verified email. The person is then matched to an account
 * (a provider account linked before, or the verified email), or one is made
 * when `MELETE_OIDC_ACCOUNTS=create`, and signed in as a password would.
 *
 * `POST /signin/oidc/logout` is OpenID Connect Back-Channel Logout 1.0: the
 * provider says a subject signed out, and that person's browser sessions end.
 *
 * Every failure sends the browser back to the sign-in page with a fixed code;
 * nothing the provider said, and no token, is shown or logged.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { ID_PREFIXES } from '@melete/contracts';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import {
  type AuthorizationServer,
  authorizationUrl,
  callbackCode,
  discoverAuthorizationServer,
  exchangeCode,
  McpSignInFailure,
  type OAuthFetch,
  pkcePair,
  randomState,
} from '../connectors/mcp-oauth.ts';
import { session } from '../db/auth-schema.ts';
import type { Database } from '../db/client.ts';
import { oidcIdentity, oidcSpentState, owner, principal } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import { credentials, startSession } from './auth.ts';
import { OIDC_PATHS, oidcConfigured, PASSWORD_SIGNIN_PATHS } from './oidc-paths.ts';

export const OIDC_COOKIE = 'melete_oidc';
const COOKIE_TTL_SECONDS = 10 * 60;
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Asymmetric only: a key the provider publishes can never be used as a shared secret. */
const ID_TOKEN_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];
const CLOCK_TOLERANCE_SECONDS = 60;
/** How old a back-channel logout token may be. */
const LOGOUT_TOKEN_AGE_SECONDS = 10 * 60;
const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * With `MELETE_PASSWORD_SIGNIN=off` the identity provider is the only way in:
 * a password, an emailed link and a password reset are refused before they
 * run. Mounted ahead of the routes it closes.
 */
export function passwordSignInGate(env: Env): MiddlewareHandler {
  return async (c, next) => {
    if (
      !env.MELETE_PASSWORD_SIGNIN &&
      c.req.method === 'POST' &&
      PASSWORD_SIGNIN_PATHS.includes(c.req.path)
    )
      return c.json(
        {
          error: {
            code: 'password_signin_off',
            message: `This installation signs people in with ${env.MELETE_OIDC_LABEL}.`,
          },
        },
        403,
      );
    return next();
  };
}

/** Where the app is: the public address, without a trailing slash. */
function appBase(env: Env): string {
  const url = new URL(env.MELETE_PUBLIC_URL ?? 'http://localhost');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Where in the app to land once signed in: a path inside it, or the home
 * screen. The result always follows this installation's own address and `#`,
 * so it can never name another site.
 */
export function safeReturnPath(value: string | undefined | null): string {
  if (!value || value.length > 512) return '/';
  if (!/^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@/?%]*$/.test(value)) return '/';
  if (value === '/welcome' || value.startsWith('/welcome?')) return '/';
  return value;
}

type Pending = {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expires: number;
};

/**
 * The cookie carrying a sign-in in progress: AES-256-GCM under a key derived
 * from the master key, so the browser can neither read nor change it. Without
 * a master key the key lasts as long as the process.
 */
class PendingCookie {
  private readonly key: Buffer;
  constructor(
    secret: string | undefined,
    private readonly now: () => number,
  ) {
    this.key = secret
      ? createHmac('sha256', secret).update('melete oidc sign-in cookie v1').digest()
      : randomBytes(32);
  }

  seal(pending: Omit<Pending, 'expires'>): string {
    const body: Pending = {
      ...pending,
      expires: Math.floor(this.now() / 1000) + COOKIE_TTL_SECONDS,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const sealed = Buffer.concat([cipher.update(JSON.stringify(body), 'utf8'), cipher.final()]);
    return `v1.${Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64url')}`;
  }

  /** Null for anything absent, malformed, expired or not sealed by this installation. */
  open(value: string | undefined): Pending | null {
    if (!value || value.length > 2048 || !value.startsWith('v1.')) return null;
    const raw = Buffer.from(value.slice(3), 'base64url');
    if (raw.length < 29) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
      const body = JSON.parse(text) as Pending;
      if (
        typeof body.state !== 'string' ||
        typeof body.nonce !== 'string' ||
        typeof body.verifier !== 'string' ||
        typeof body.returnTo !== 'string' ||
        typeof body.expires !== 'number' ||
        body.expires * 1000 <= this.now()
      )
        return null;
      return body;
    } catch {
      return null;
    }
  }
}

/** A sign-in that stops, with the code the sign-in page explains. */
class OidcRefusal extends Error {
  constructor(readonly code: OidcErrorCode) {
    super(code);
  }
}

export type OidcErrorCode =
  | 'provider_unavailable'
  | 'signin_expired'
  | 'signin_declined'
  | 'signin_failed'
  | 'email_unverified'
  | 'not_allowed'
  | 'no_account'
  | 'account_disabled'
  | 'account_conflict'
  | 'setup_required';

const refuse = (code: OidcErrorCode): never => {
  throw new OidcRefusal(code);
};

/**
 * A claim by name, or, when no claim has that exact name, by a dotted path
 * into nested objects (`realm_access.roles`). A name that is a URL with dots
 * in it, as namespaced claims are, is found by its exact name first.
 */
function claimAt(claims: JWTPayload, name: string): unknown {
  if (Object.hasOwn(claims, name)) return claims[name];
  let found: unknown = claims;
  for (const part of name.split('.')) {
    if (!found || typeof found !== 'object' || Array.isArray(found) || !Object.hasOwn(found, part))
      return undefined;
    found = (found as Record<string, unknown>)[part];
  }
  return found;
}

/** Whether the ID token carries the claim the operator requires, or a list that holds its value. */
export function hasRequiredClaim(
  claims: JWTPayload,
  required: { name: string; value: string } | undefined,
): boolean {
  if (!required) return true;
  const found = claimAt(claims, required.name);
  const matches = (item: unknown) =>
    (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') &&
    String(item) === required.value;
  return Array.isArray(found) ? found.some(matches) : matches(found);
}

export type OidcDeps = {
  db: Database | null;
  env: Env;
  /** How the provider is reached; the provider is the operator's own choice. */
  fetcher?: OAuthFetch;
  now?: () => number;
};

export function mountOidc(app: Hono, deps: OidcDeps): void {
  const { db, env } = deps;
  const now = deps.now ?? Date.now;
  const fetcher: OAuthFetch = deps.fetcher ?? ((url, init) => fetch(url, init));
  const cookies = new PendingCookie(env.MELETE_MASTER_KEY, now);
  const configured = oidcConfigured(env);
  const issuer = env.MELETE_OIDC_ISSUER ?? '';
  const clientId = env.MELETE_OIDC_CLIENT_ID ?? '';
  const clientSecret = env.MELETE_OIDC_CLIENT_SECRET ?? '';
  const redirectUri = `${appBase(env)}/api${OIDC_PATHS.callback}`;

  let discovered: { server: AuthorizationServer; at: number } | undefined;
  let keys: { uri: string; set: ReturnType<typeof createRemoteJWKSet> } | undefined;
  const provider = async () => {
    if (discovered && now() - discovered.at < DISCOVERY_TTL_MS) return discovered.server;
    let server: AuthorizationServer;
    try {
      server = await discoverAuthorizationServer(issuer, fetcher, { pkceListed: false });
    } catch {
      return refuse('provider_unavailable');
    }
    if (!server.jwks_uri) return refuse('provider_unavailable');
    discovered = { server, at: now() };
    return server;
  };
  const keySet = (server: AuthorizationServer) => {
    const uri = server.jwks_uri ?? '';
    if (keys?.uri !== uri)
      keys = { uri, set: createRemoteJWKSet(new URL(uri), { timeoutDuration: 10_000 }) };
    return keys.set;
  };
  const verify = async (token: string, server: AuthorizationServer) => {
    try {
      const { payload } = await jwtVerify(token, keySet(server), {
        issuer,
        audience: clientId,
        algorithms: ID_TOKEN_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: new Date(now()),
      });
      return payload;
    } catch {
      return refuse('signin_failed');
    }
  };

  const toApp = (c: Context, path: string) => {
    deleteCookie(c, OIDC_COOKIE, { path: '/' });
    return c.redirect(`${appBase(env)}/#${path}`, 302);
  };
  const toSignIn = (c: Context, code: OidcErrorCode) => {
    process.stderr.write(`oidc: sign-in refused (${code})\n`);
    return toApp(c, `/welcome?signin_error=${code}`);
  };
  const unavailable = (c: Context) =>
    c.json(
      {
        error: {
          code: 'not_available',
          message: 'This installation has no identity provider set up.',
        },
      },
      404,
    );

  app.get(OIDC_PATHS.start, async (c) => {
    if (!configured) return unavailable(c);
    let server: AuthorizationServer;
    try {
      server = await provider();
    } catch (error) {
      if (error instanceof OidcRefusal) return toSignIn(c, error.code);
      throw error;
    }
    const pkce = pkcePair();
    const state = randomState();
    const nonce = randomState();
    setCookie(
      c,
      OIDC_COOKIE,
      cookies.seal({
        state,
        nonce,
        verifier: pkce.verifier,
        returnTo: safeReturnPath(c.req.query('return')),
      }),
      {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        // The provider sends the browser back with a top-level GET, which carries a Lax cookie.
        sameSite: 'Lax',
        path: '/',
        maxAge: COOKIE_TTL_SECONDS,
      },
    );
    return c.redirect(
      authorizationUrl(server, {
        clientId,
        redirectUri,
        state,
        challenge: pkce.challenge,
        scope: env.MELETE_OIDC_SCOPES,
        nonce,
      }),
      302,
    );
  });

  app.get(OIDC_PATHS.callback, async (c) => {
    if (!configured) return unavailable(c);
    if (!db)
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    try {
      const pending = cookies.open(getCookie(c, OIDC_COOKIE)) ?? refuse('signin_expired');
      const server = await provider();
      const query = new URL(c.req.url).searchParams;
      let code: string;
      try {
        code = callbackCode(query, {
          state: pending.state,
          issuer,
          issParameterSupported: server.authorization_response_iss_parameter_supported === true,
        });
      } catch (error) {
        if (error instanceof McpSignInFailure)
          return toSignIn(
            c,
            error.code === 'sign_in_declined'
              ? 'signin_declined'
              : error.code === 'state_mismatch'
                ? 'signin_expired'
                : 'signin_failed',
          );
        throw error;
      }
      // The state is spent before the code is: an answer replayed with its cookie stops here.
      const spent = await spendOnce(
        db,
        `state ${pending.state}`,
        new Date((pending.expires + CLOCK_TOLERANCE_SECONDS) * 1000),
        now(),
      );
      if (!spent) return toSignIn(c, 'signin_expired');
      let idToken: string | undefined;
      try {
        idToken = (
          await exchangeCode(
            server,
            {
              code,
              verifier: pending.verifier,
              redirectUri,
              client: { clientId, clientSecret, method: 'pre_registered' },
            },
            fetcher,
            now(),
          )
        ).idToken;
      } catch (error) {
        if (error instanceof McpSignInFailure) return toSignIn(c, 'signin_failed');
        throw error;
      }
      if (!idToken) return toSignIn(c, 'signin_failed');
      const claims = await verify(idToken, server);
      if (claims.nonce !== pending.nonce) return toSignIn(c, 'signin_failed');
      // Several audiences name the party the token was issued to, which must be this client.
      if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
        return toSignIn(c, 'signin_failed');
      if (claims.azp !== undefined && claims.azp !== clientId) return toSignIn(c, 'signin_failed');
      if (typeof claims.iat !== 'number' || typeof claims.exp !== 'number')
        return toSignIn(c, 'signin_failed');
      const subject = claims.sub;
      if (typeof subject !== 'string' || subject.length < 1 || subject.length > 255)
        return toSignIn(c, 'signin_failed');
      // The address shape every other way in accepts, checked before it is
      // lower-cased: Unicode case mapping folds some letters into ASCII ones
      // (U+212A KELVIN SIGN becomes "k"), which would name another mailbox's account.
      const parsedEmail = credentials.shape.email.safeParse(
        typeof claims.email === 'string' ? claims.email.trim() : undefined,
      );
      if (!parsedEmail.success) return toSignIn(c, 'email_unverified');
      const email = parsedEmail.data;
      if (claims.email_verified !== true && claims.email_verified !== 'true')
        return toSignIn(c, 'email_unverified');
      if (!hasRequiredClaim(claims, env.MELETE_OIDC_REQUIRE_CLAIM))
        return toSignIn(c, 'not_allowed');
      const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
      if (!installation) return toSignIn(c, 'setup_required');
      const principalId = await resolveAccount(db, {
        issuer,
        subject,
        email,
        create: env.MELETE_OIDC_ACCOUNTS === 'create',
        emailLink: env.MELETE_OIDC_EMAIL_LINK,
        at: now(),
      });
      await startSession(c, db, env, principalId);
      return toApp(c, pending.returnTo);
    } catch (error) {
      if (error instanceof OidcRefusal) return toSignIn(c, error.code);
      // The browser came here by a redirect: it goes back to the sign-in page
      // rather than to a JSON error, and the cause is logged by kind only.
      process.stderr.write(
        `oidc: sign-in failed (${error instanceof Error ? error.name : 'error'})\n`,
      );
      return toSignIn(c, 'signin_failed');
    }
  });

  // OpenID Connect Back-Channel Logout 1.0: the provider, not a browser, posts a logout token.
  app.post(OIDC_PATHS.logout, async (c) => {
    if (!configured) return unavailable(c);
    if (!db)
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    const invalid = () =>
      c.json({ error: 'invalid_request', error_description: 'The logout token was refused.' }, 400);
    if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded')
      return invalid();
    const form = new URLSearchParams(await c.req.text().catch(() => ''));
    const token = form.get('logout_token');
    if (!token || token.length > 16_384) return invalid();
    let claims: JWTPayload;
    try {
      const server = await provider();
      claims = (
        await jwtVerify(token, keySet(server), {
          issuer,
          audience: clientId,
          algorithms: ID_TOKEN_ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          currentDate: new Date(now()),
          maxTokenAge: LOGOUT_TOKEN_AGE_SECONDS,
          requiredClaims: ['iat', 'jti'],
        })
      ).payload;
    } catch {
      return invalid();
    }
    const isObject = (value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    if (
      !isObject(claims.events) ||
      !isObject((claims.events as Record<string, unknown>)[BACKCHANNEL_EVENT]) ||
      'nonce' in claims ||
      typeof claims.sub !== 'string' ||
      typeof claims.jti !== 'string' ||
      claims.jti.length > 512 ||
      typeof claims.iat !== 'number'
    )
      return invalid();
    // Each logout token is used once (Back-Channel Logout 1.0, section 2.6): a
    // replay within its lifetime would end sessions made since.
    const fresh = await spendOnce(
      db,
      `logout ${claims.jti}`,
      new Date((claims.iat + LOGOUT_TOKEN_AGE_SECONDS + CLOCK_TOLERANCE_SECONDS) * 1000),
      now(),
    );
    if (!fresh) return invalid();
    const [linked] = await db
      .select({ principalId: oidcIdentity.principalId })
      .from(oidcIdentity)
      .where(and(eq(oidcIdentity.issuer, issuer), eq(oidcIdentity.subject, claims.sub)))
      .limit(1);
    if (linked)
      await db
        .delete(session)
        .where(sql`coalesce(${session.principalId}, ${session.ownerId}) = ${linked.principalId}`);
    return c.body(null, 200);
  });
}

/**
 * Records a sign-in's state, or a logout token's id, as used; false when it
 * already was. Expired records go as new ones arrive.
 */
async function spendOnce(db: Database, key: string, expiresAt: Date, at: number): Promise<boolean> {
  await db.delete(oidcSpentState).where(lt(oidcSpentState.expiresAt, new Date(at)));
  const rows = await db
    .insert(oidcSpentState)
    .values({ stateHash: createHash('sha256').update(key).digest('hex'), expiresAt })
    .onConflictDoNothing()
    .returning({ stateHash: oidcSpentState.stateHash });
  return rows.length === 1;
}

/**
 * The account a provider's person signs in to: the one their provider account
 * was linked to before, otherwise the person account with their verified
 * email, which the provider account is then linked to. With `create`, a person
 * account is made when neither exists; two first sign-ins at once make one
 * account, because the email and the provider account are each unique and the
 * one that loses the race finds what the other made.
 *
 * With `emailLink: 'no-password'`, the email alone claims only an account
 * that has no password (one the operator made, or one this sign-in made). An
 * account with a password is claimed only while the operator has opened it
 * with `melete account link <email>`, and that opening is used up by the link.
 */
export async function resolveAccount(
  db: Database,
  who: {
    issuer: string;
    subject: string;
    email: string;
    create: boolean;
    emailLink?: 'any' | 'no-password';
    /** Now, in milliseconds, for the operator's opening. */
    at?: number;
  },
): Promise<string> {
  const usable = (row: typeof principal.$inferSelect) => {
    if (row.kind !== 'person') return refuse('account_conflict');
    if (row.disabledAt) return refuse('account_disabled');
    return row.id;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const [linked] = await db
      .select({ account: principal })
      .from(oidcIdentity)
      .innerJoin(principal, eq(principal.id, oidcIdentity.principalId))
      .where(and(eq(oidcIdentity.issuer, who.issuer), eq(oidcIdentity.subject, who.subject)))
      .limit(1);
    if (linked) return usable(linked.account);
    const [byEmail] = await db.select().from(principal).where(eq(principal.email, who.email));
    if (byEmail) {
      const id = usable(byEmail);
      const opened =
        byEmail.oidcLinkUntil !== null && byEmail.oidcLinkUntil.getTime() > (who.at ?? Date.now());
      if (who.emailLink === 'no-password' && byEmail.passwordHash && !opened)
        return refuse('account_conflict');
      const made = await db
        .insert(oidcIdentity)
        .values({ issuer: who.issuer, subject: who.subject, principalId: id })
        .onConflictDoNothing()
        .returning({ principalId: oidcIdentity.principalId });
      if (made.length === 1) {
        if (byEmail.oidcLinkUntil !== null)
          await db.update(principal).set({ oidcLinkUntil: null }).where(eq(principal.id, id));
        return id;
      }
      // Either a concurrent sign-in linked this same subject (found on the next
      // pass), or the account is already linked to another subject at this
      // provider, which this one must not take over.
      const [mine] = await db
        .select({ principalId: oidcIdentity.principalId })
        .from(oidcIdentity)
        .where(and(eq(oidcIdentity.issuer, who.issuer), eq(oidcIdentity.subject, who.subject)))
        .limit(1);
      if (!mine) return refuse('account_conflict');
      continue;
    }
    if (!who.create) return refuse('no_account');
    // The person's own space is made at their first request, as for any new account.
    const created = await db
      .transaction(async (tx) => {
        const [row] = await tx
          .insert(principal)
          .values({ id: newId(ID_PREFIXES.owner), email: who.email })
          .onConflictDoNothing()
          .returning({ id: principal.id });
        if (!row) return null;
        const [link] = await tx
          .insert(oidcIdentity)
          .values({ issuer: who.issuer, subject: who.subject, principalId: row.id })
          .onConflictDoNothing()
          .returning({ principalId: oidcIdentity.principalId });
        if (!link) {
          tx.rollback();
          return null;
        }
        return row.id;
      })
      .catch((error: unknown) => {
        // drizzle's rollback() throws to end the transaction; the next pass finds the winner.
        if (error instanceof Error && error.name === 'TransactionRollbackError') return null;
        throw error;
      });
    if (created) return created;
  }
  return refuse('account_conflict');
}
