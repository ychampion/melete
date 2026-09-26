import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ID_PREFIXES,
  magicLinkConsume,
  magicLinkRequest,
  spaceListResponse,
  unavailable,
} from '@melete/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { session } from '../db/auth-schema.ts';
import type { Database } from '../db/client.ts';
import { owner, principal, space } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { ExperienceSignIn } from '../experience/signin.ts';
import { newId } from '../ids.ts';
import { principalContext, visibleSpace } from '../principals/authority.ts';
import { resolveSessionSpace, type SessionSpace } from '../principals/session-space.ts';
import { ensureDefaultConnections } from './connections.ts';
import { DEVICE_COOKIE, DEVICE_TTL_SECONDS, DeviceCookies } from './device-cookie.ts';
import type { RequestSource } from './listener.ts';
import { LoginThrottle } from './login-throttle.ts';

export const SESSION_COOKIE = 'melete_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
/**
 * The most a request body may carry. Before a session: a sign-in form, which
 * is a few hundred bytes. After one: the largest contract field, a million
 * characters of memory text, with room for JSON escaping.
 */
const PUBLIC_BODY_BYTES = 16 * 1024;
const SESSION_BODY_BYTES = 8 * 1024 * 1024;
const tooLarge = (c: Context) =>
  c.json({ error: { code: 'request_too_large', message: 'The request is too large.' } }, 413);
const publicBody = bodyLimit({ maxSize: PUBLIC_BODY_BYTES, onError: tooLarge });
const sessionBody = bodyLimit({ maxSize: SESSION_BODY_BYTES, onError: tooLarge });
/** Browsers that have not signed in to an account before share this many attempts on it. */
const ACCOUNT_BURST = 10;
export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(1024),
});

export type SessionOwner = { id: string; email: string; created_at: string };

declare module 'hono' {
  interface ContextVariableMap {
    owner: SessionOwner;
    experienceSpaceId: string;
    sessionSpace: SessionSpace;
    /**
     * A space this request brought into being, named by the route that made it.
     * Whatever every space is given is then given to that one space, and to no
     * other.
     */
    createdSpaceId: string;
  }
}

const publicOwner = (row: typeof owner.$inferSelect): SessionOwner => ({
  id: row.id,
  email: row.email,
  created_at: row.createdAt.toISOString(),
});

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function newSession(ownerId: string, principalId = ownerId, spaceId?: string) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    row: {
      tokenHash: tokenHash(token),
      ownerId,
      principalId,
      ...(spaceId ? { spaceId } : {}),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    },
  };
}

function sessionCookie(c: Context, token: string, env: Env) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/** Browser writes must originate from this API; scripts can omit Origin. */
function allowedMutation(c: Context): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return true;
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = c.req.header('Origin');
  return !origin || origin === new URL(c.req.url).origin;
}

/**
 * The browser a request is from: the address the trusted web proxy stated, or
 * the socket peer. The listener decides which; a request header never does.
 */
function clientAddress(c: Context): string {
  const source = c.env as RequestSource | undefined;
  return source?.clientAddress ?? source?.remoteAddress ?? 'unknown';
}

function rateLimited(c: Context, retryAfter: number, what: 'login' | 'setup') {
  c.header('Retry-After', String(retryAfter));
  return c.json(
    {
      error: {
        code: `${what}_rate_limited`,
        message: `Too many ${what} attempts. Try again later.`,
      },
    },
    429,
  );
}

let placeholderHash: Promise<string> | undefined;
/**
 * A hash nobody knows the password of. Verifying against it makes a login for
 * an unknown email, or an account without a password, cost what a real one
 * costs, so response time does not say which emails have accounts.
 */
function unknownAccountHash(): Promise<string> {
  placeholderHash ??= Bun.password
    .hash(randomBytes(32).toString('base64url'), { algorithm: 'argon2id' })
    .catch((error) => {
      placeholderHash = undefined;
      throw error;
    });
  return placeholderHash;
}

async function readCredentials(c: Context) {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return null;
  const parsed = credentials.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export function mountAuth(
  app: Hono,
  deps: {
    db: Database | null;
    env: Env;
    loginThrottle?: LoginThrottle;
    sql?: Sql;
    registry?: ConnectorRegistry;
  },
): void {
  const { db, env, registry } = deps;
  const handle = deps.sql;
  /**
   * An account can reach its first request without a space of its own, and the
   * session makes one for it. The space is furnished where it is made, so the
   * request that made it already finds the connections every space has.
   */
  const furnish =
    db && handle && registry
      ? (spaceId: string) => ensureDefaultConnections({ db, sql: handle, registry, env }, spaceId)
      : undefined;
  // Four limiters on one clock: client addresses, accounts as seen by browsers
  // that are new to them, known devices, and setup attempts.
  const loginThrottle = deps.loginThrottle ?? new LoginThrottle();
  const accountThrottle = new LoginThrottle(loginThrottle.clock, ACCOUNT_BURST);
  const deviceThrottle = new LoginThrottle(loginThrottle.clock);
  const setupThrottle = new LoginThrottle(loginThrottle.clock);
  const devices = new DeviceCookies(env.MELETE_MASTER_KEY, loginThrottle.clock);
  const deviceCookie = (c: Context, email: string) =>
    setCookie(c, DEVICE_COOKIE, devices.issue(email), {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'Strict',
      path: '/',
      maxAge: DEVICE_TTL_SECONDS,
    });
  // Paid once, ahead of the first stranger, so the first unknown email is no slower than the rest.
  if (db) void unknownAccountHash().catch(() => undefined);

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!allowedMutation(c)) {
      return c.json({ error: { code: 'origin_rejected', message: 'Use the same origin.' } }, 403);
    }
    const publicRoute =
      (c.req.method === 'GET' &&
        (c.req.path === '/health' ||
          c.req.path === '/setup' ||
          // An authorization server reads this client's metadata without a session.
          c.req.path === '/oauth/client-metadata.json')) ||
      (c.req.method === 'POST' &&
        [
          '/setup',
          '/login',
          '/signin/magic-link',
          '/signin/magic-link/consume',
          '/signin/google',
          '/signin/apple',
        ].includes(c.req.path));
    // A body is counted as it arrives, so one sent without a length, or with a
    // false one, is dropped at the limit rather than read and parsed whole.
    if (publicRoute) return publicBody(c, next);

    const token = getCookie(c, SESSION_COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return c.json({ error: { code: 'unauthorized', message: 'A session is required.' } }, 401);
    }
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const [active] = await db
      .select({
        owner: principal,
        spaceId: session.spaceId,
        membershipGeneration: session.membershipGeneration,
      })
      .from(session)
      .innerJoin(
        principal,
        eq(principal.id, sql`coalesce(${session.principalId}, ${session.ownerId})`),
      )
      .where(and(eq(session.tokenHash, tokenHash(token)), gt(session.expiresAt, new Date())))
      .limit(1);
    if (!active) {
      return c.json({ error: { code: 'unauthorized', message: 'The session has expired.' } }, 401);
    }
    c.set('owner', publicOwner(active.owner));
    // The space follows the authenticated principal; no request or other account can supply it.
    const resolved = await resolveSessionSpace(
      db,
      env.MELETE_SPACES_DIR,
      active.owner.id,
      active.spaceId ? { spaceId: active.spaceId, generation: active.membershipGeneration } : null,
    );
    if (resolved.created) await furnish?.(resolved.spaceId);
    c.set('sessionSpace', resolved);
    c.set('experienceSpaceId', resolved.spaceId);
    return principalContext.run(active.owner.id, () => sessionBody(c, next));
  });

  const signIn =
    deps.sql && deps.registry
      ? new ExperienceSignIn(deps.sql, deps.registry, env.MELETE_PUBLIC_URL)
      : undefined;
  app.post('/signin/magic-link', async (c) => {
    const input = magicLinkRequest.parse(await c.req.json());
    return c.json(
      signIn
        ? await signIn.request(input.email)
        : unavailable('Email sign-in is not connected yet.'),
    );
  });
  app.post('/signin/magic-link/consume', async (c) => {
    const input = magicLinkConsume.parse(await c.req.json());
    if (!signIn) return c.json(unavailable('Email sign-in is not connected yet.'));
    sessionCookie(c, await signIn.consume(input.token, newSession), env);
    return c.json({ status: 'ok' });
  });
  for (const provider of ['google', 'apple'])
    app.post(`/signin/${provider}`, (c) =>
      c.json(unavailable('Use your password or an email sign-in link.')),
    );
  /**
   * Ends the session the cookie names. The row is removed rather than flagged,
   * so a later request with the same cookie is unauthorized, and the cookie
   * itself is cleared. Reaching here already required a live session.
   */
  app.post('/signout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (db && token) await db.delete(session).where(eq(session.tokenHash, tokenHash(token)));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ status: 'ok' });
  });

  /**
   * Whether the first account still needs to be created. Public, so a browser
   * with no session can show "Create your account" on a fresh install and
   * sign-in everywhere else. It says only whether an owner exists.
   */
  app.get('/setup', async (c) => {
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const [installed] = await db.select({ id: owner.id }).from(owner).limit(1);
    return c.json({ needed: !installed });
  });

  app.post('/setup', async (c) => {
    const source = clientAddress(c);
    const retryAfter = setupThrottle.admit(source);
    if (retryAfter > 0) return rateLimited(c, retryAfter, 'setup');
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    // An installed service says so before it parses or hashes anything. The
    // insert below still decides a race between two first setups.
    const [installed] = await db.select({ id: owner.id }).from(owner).limit(1);
    if (installed) {
      return c.json(
        { error: { code: 'already_setup', message: 'The owner is already set up.' } },
        409,
      );
    }
    const input = await readCredentials(c);
    if (!input) {
      return c.json(
        { error: { code: 'invalid_input', message: 'Provide an email and password.' } },
        400,
      );
    }
    const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id' });
    const ownerId = newId(ID_PREFIXES.owner);
    const personalId = newId(ID_PREFIXES.space);
    const authenticated = newSession(ownerId);
    const created = await db.transaction(async (tx) => {
      // ON CONFLICT also covers the singleton index, so concurrent setup has one winner.
      const [createdOwner] = await tx
        .insert(owner)
        .values({ id: ownerId, email: input.email, passwordHash })
        .onConflictDoNothing()
        .returning();
      if (!createdOwner) return null;
      await tx.insert(principal).values(createdOwner);
      await tx.insert(space).values({
        id: personalId,
        ownerPrincipalId: ownerId,
        name: 'Personal',
        kind: 'personal',
        audience: 'owner',
        gitPath: join(env.MELETE_SPACES_DIR, personalId),
      });
      await tx.insert(session).values(authenticated.row);
      return createdOwner;
    });
    if (!created) {
      return c.json(
        { error: { code: 'already_setup', message: 'The owner is already set up.' } },
        409,
      );
    }
    setupThrottle.succeeded(source);
    c.set('createdSpaceId', personalId);
    sessionCookie(c, authenticated.token, env);
    deviceCookie(c, created.email);
    return c.json({ owner: publicOwner(created) }, 201);
  });

  /**
   * Three limits stand in front of the password check, and each request pays
   * exactly one path through them before the database or the hash is touched.
   * A browser without proof of an earlier sign-in pays by client address and
   * then into the limiter every such browser shares for the account. A browser
   * that carries valid proof for this very account pays only into a budget of
   * its own, so strangers who exhaust the shared limiter, from any number of
   * addresses, cannot keep a known browser out. Proof for another account, or
   * proof that does not verify, earns nothing.
   */
  app.post('/login', async (c) => {
    const source = clientAddress(c);
    const device = devices.verify(getCookie(c, DEVICE_COOKIE));
    if (!device) {
      const retryAfter = loginThrottle.admit(source);
      if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    }
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const input = await readCredentials(c);
    if (!input) {
      return c.json(
        { error: { code: 'invalid_input', message: 'Provide an email and password.' } },
        400,
      );
    }
    const account = devices.account(input.email);
    const known = device?.account === account ? device : null;
    if (device && !known) {
      const retryAfter = loginThrottle.admit(source);
      if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    }
    const retryAfter = known ? deviceThrottle.admit(known.nonce) : accountThrottle.admit(account);
    if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    const [found] = await db
      .select()
      .from(principal)
      .where(eq(principal.email, input.email))
      .limit(1);
    const verified = await Bun.password.verify(
      input.password,
      found?.passwordHash ?? (await unknownAccountHash()),
    );
    if (!found?.passwordHash || !verified) {
      return c.json(
        { error: { code: 'invalid_credentials', message: 'Email or password is wrong.' } },
        401,
      );
    }
    const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
    if (!installation)
      return c.json({ error: { code: 'unauthorized', message: 'Setup is required.' } }, 401);
    const authenticated = newSession(installation.id, found.id);
    await db.insert(session).values(authenticated.row);
    // Success clears only what this request paid into. The shared account
    // limiter gets this one attempt back and keeps every failure it has seen,
    // so it counts wrong passwords and one person signing in cannot reopen it.
    if (known) deviceThrottle.succeeded(known.nonce);
    else {
      loginThrottle.succeeded(source);
      accountThrottle.refund(account);
    }
    sessionCookie(c, authenticated.token, env);
    deviceCookie(c, found.email);
    return c.json({ owner: publicOwner(found) });
  });

  app.get('/me', (c) => c.json({ owner: c.get('owner') }));

  app.get('/spaces', async (c) => {
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const rows = await db
      .select()
      .from(space)
      .where(visibleSpace(space.id))
      .orderBy(space.createdAt, space.id);
    return c.json(
      spaceListResponse.parse({
        spaces: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          audience: row.audience,
          owner_principal_id: row.ownerPrincipalId,
          git_path: row.gitPath,
          created_at: row.createdAt.toISOString(),
        })),
      }),
    );
  });
}
