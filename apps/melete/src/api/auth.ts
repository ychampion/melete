import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ATTACHMENT_LIMITS,
  attachmentSize,
  ID_PREFIXES,
  magicLinkConsume,
  magicLinkRequest,
  newPasswordInput,
  spaceListResponse,
  unavailable,
} from '@melete/contracts';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { attachmentSettingsFromEnv } from '../attachments/limits.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { session } from '../db/auth-schema.ts';
import type { Database } from '../db/client.ts';
import { owner, principal, space } from '../db/schema.ts';
import type { Env } from '../env.ts';
import type { AccountMailer } from '../experience/account-mail.ts';
import { ExperienceSignIn } from '../experience/signin.ts';
import { newId } from '../ids.ts';
import { MCP_PUBLIC_PATHS, mcpActorOf, mcpPublicPath } from '../mcp-server/actor.ts';
import { type LimitStore, PostgresLimitStore } from '../ops/limiter.ts';
import { principalContext, visibleSpace } from '../principals/authority.ts';
import {
  resolveSessionSpace,
  type SessionSpace,
  selectedSpace,
} from '../principals/session-space.ts';
import { REACH_WEBHOOK_PATH } from '../reach/routes.ts';
import { MULTIPLAYER_UNAVAILABLE, multiplayerEnabled } from '../rooms/preview.ts';
import { previewPath } from '../sandbox/preview-path.ts';
import { SMS_WEBHOOK_PATH } from '../sms/routes.ts';
import { viewPath } from '../viewer/headers.ts';
import { mountAccountAccess, sessionLabel } from './account-access.ts';
import { ensureDefaultConnections } from './connections.ts';
import { DEVICE_COOKIE, DEVICE_TTL_SECONDS, DeviceCookies } from './device-cookie.ts';
import type { RequestSource } from './listener.ts';
import { LoginThrottle } from './login-throttle.ts';
import { mountPassword } from './password.ts';
import { requireStrongPassword } from './password-policy.ts';
import { setupCodeRequired, spendSetupCode } from './setup-code.ts';

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
const sessionLimit = bodyLimit({ maxSize: SESSION_BODY_BYTES, onError: tooLarge });
/**
 * A file uploaded for a message may be larger than any JSON body: the file at
 * the operator's limit, the small copy a picture brings, and the form around them.
 */
const uploadLimitFor = (fileBytes: number) =>
  bodyLimit({
    maxSize: fileBytes + ATTACHMENT_LIMITS.model_image_bytes + 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: {
            code: 'attachment_too_large',
            message: `Files can be up to ${attachmentSize(fileBytes)}.`,
          },
        },
        413,
      ),
  });
/** One JSON-RPC message from an assistant: a tool's arguments, never an upload. */
const mcpBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
/** Browsers that have not signed in to an account before share this many attempts on it. */
const ACCOUNT_BURST = 10;
export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(1024),
});
/** The first account: a new password, and the setup code when the installation has one. */
export const setupCredentials = credentials.extend({
  password: newPasswordInput,
  setup_code: z.string().min(1).max(200).optional(),
});

export type SessionOwner = {
  id: string;
  email: string;
  created_at: string;
  /** `guest`: an invited account that uses only the rooms it was invited to. */
  kind?: 'person' | 'guest';
};

/** The kinds of account that may hold a session. A room's own principal never does. */
export const SIGN_IN_KINDS = ['person', 'guest'];

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
    /**
     * The digest of the browser session this request came with, so what is
     * issued for the session (an app view) can end with it. Unset for an
     * assistant's bearer token.
     */
    sessionDigest: string;
  }
}

const publicOwner = (row: typeof owner.$inferSelect): SessionOwner => ({
  id: row.id,
  email: row.email,
  created_at: row.createdAt.toISOString(),
});

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function newSession(ownerId: string, principalId = ownerId, spaceId?: string, label?: string) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    row: {
      tokenHash: tokenHash(token),
      ownerId,
      principalId,
      ...(spaceId ? { spaceId } : {}),
      ...(label ? { label } : {}),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
    },
  };
}

/** What the person's list calls the browser this request came from. */
const browserOf = (c: Context) => sessionLabel(c.req.header('User-Agent'));

function sessionCookie(c: Context, token: string, env: Env) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

/**
 * Sign a principal in on this response: a new session row and its cookie. For
 * routes outside this module that make an account, such as accepting a room
 * invite.
 */
export async function startSession(c: Context, db: Database, env: Env, principalId: string) {
  const [installation] = await db.select({ id: owner.id }).from(owner).limit(1);
  if (!installation) throw new Error('No installation to sign in to');
  const authenticated = newSession(installation.id, principalId, undefined, browserOf(c));
  await db.insert(session).values(authenticated.row);
  sessionCookie(c, authenticated.token, env);
}

/** The two room-invite routes anyone may call, with or without a session (rooms/invites.ts). */
export const INVITE_PUBLIC_PATHS = ['/invites/view', '/invites/accept'];

/**
 * What a guest's session may reach: the rooms they were invited to (each room
 * route checks their place in that room), their own account, and a room's
 * files and computers, which check the room again. Everything else is refused
 * before it runs, so a surface that was never taught about guests never
 * serves one.
 */
export function guestMayUse(method: string, path: string): boolean {
  if (path === '/rooms' || path.startsWith('/rooms/')) return true;
  if (path === '/me') return method === 'GET' || method === 'PATCH';
  // Their own linked chat platform accounts, to see and to unlink.
  if (path === '/me/linked-accounts') return method === 'GET';
  if (/^\/me\/linked-accounts\/[^/]+\/[^/]+$/.test(path)) return method === 'DELETE';
  if (method === 'POST' && ['/signout', '/account/password'].includes(path)) return true;
  if (method === 'GET' && /^\/artifacts\/[^/]+\/content$/.test(path)) return true;
  // Watching a room's computer; taking it over is for the room's owners.
  if (/^\/sandbox\/sessions\/[^/]+\/live(\/close)?$/.test(path)) return method === 'POST';
  if (/^\/sandbox\/sessions\/[^/]+\/live\/frames$/.test(path)) return method === 'GET';
  return false;
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

async function readCredentials<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.infer<T> | null> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return null;
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

/** The live session a cookie names: its principal and the space it selected. */
export async function activeSession(db: Database, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
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
    .where(
      and(
        eq(session.tokenHash, tokenHash(token)),
        gt(session.expiresAt, new Date()),
        // A room's own principal holds no session, however one came to be written.
        inArray(principal.kind, SIGN_IN_KINDS),
        // Nor does an account the operator disabled.
        isNull(principal.disabledAt),
      ),
    )
    .limit(1);
  return active;
}

export function mountAuth(
  app: Hono,
  deps: {
    db: Database | null;
    env: Env;
    loginThrottle?: LoginThrottle;
    /** Where the limits are counted. Left out, in Postgres when there is one, so every instance shares them. */
    limits?: LimitStore;
    sql?: Sql;
    registry?: ConnectorRegistry;
    /** The installation's account mail sender; left out, the owner's own mailbox alone. */
    accountMail?: AccountMailer;
    /** Closes the connections of paired computers that ending an account's access disconnected. */
    devicesEnded?: (principalId: string, deviceIds: string[]) => Promise<void>;
  },
): void {
  const { db, env, registry } = deps;
  const handle = deps.sql;
  const setupCodeHash = env.MELETE_SETUP_CODE_HASH;
  const multiplayer = multiplayerEnabled(env);
  const signInKinds = multiplayer ? SIGN_IN_KINDS : ['person'];
  const uploadLimit = uploadLimitFor(attachmentSettingsFromEnv(env).fileBytes);
  const sessionBody = (c: Context, next: () => Promise<void>) =>
    c.req.method === 'POST' && c.req.path === '/attachments'
      ? uploadLimit(c, next)
      : sessionLimit(c, next);
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
  const limits = deps.limits ?? (handle ? new PostgresLimitStore(handle) : undefined);
  const loginThrottle =
    deps.loginThrottle ?? new LoginThrottle(undefined, undefined, limits, 'login.address');
  const clock = loginThrottle.clock;
  const accountThrottle = new LoginThrottle(clock, ACCOUNT_BURST, limits, 'login.account');
  const deviceThrottle = new LoginThrottle(clock, undefined, limits, 'login.device');
  const setupThrottle = new LoginThrottle(clock, undefined, limits, 'login.setup');
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
    // A tool call from Melete's own MCP endpoint, in this process, for the
    // person its access token names. The environment carrying the actor is set
    // only by that endpoint; a request from the network never has it.
    const actor = mcpActorOf(c.env);
    if (actor) {
      if (!db) {
        return c.json(
          { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
          503,
        );
      }
      const [person] = await db
        .select()
        .from(principal)
        // An assistant acts only for a person: a guest never holds a grant, and a
        // grant somehow written for one is refused here, as is a disabled account's.
        .where(
          and(
            eq(principal.id, actor.principalId),
            eq(principal.kind, 'person'),
            isNull(principal.disabledAt),
          ),
        )
        .limit(1);
      if (!person) {
        return c.json({ error: { code: 'unauthorized', message: 'The access has ended.' } }, 401);
      }
      // The grant acts in the space the person consented from, and in no other:
      // once they may no longer use it there, the access has ended.
      const resolved = await selectedSpace(db, person.id, {
        spaceId: actor.spaceId,
        generation: actor.membershipGeneration,
      });
      if (!resolved) {
        return c.json({ error: { code: 'unauthorized', message: 'The access has ended.' } }, 401);
      }
      c.set('owner', publicOwner(person));
      c.set('sessionSpace', resolved);
      c.set('experienceSpaceId', resolved.spaceId);
      return principalContext.run(person.id, () => sessionBody(c, next));
    }
    if (c.req.path === MCP_PUBLIC_PATHS.mcp && c.req.method === 'POST') return mcpBody(c, next);
    if (!allowedMutation(c)) {
      return c.json({ error: { code: 'origin_rejected', message: 'Use the same origin.' } }, 403);
    }
    const publicRoute =
      (c.req.method === 'GET' &&
        (c.req.path === '/health' ||
          c.req.path === '/health/detail' ||
          c.req.path === '/setup' ||
          // An authorization server reads this client's metadata without a session.
          c.req.path === '/oauth/client-metadata.json')) ||
      mcpPublicPath(c.req.method, c.req.path) ||
      (c.req.method === 'POST' &&
        [
          '/setup',
          '/login',
          '/signin/magic-link',
          '/signin/magic-link/consume',
          '/signin/google',
          '/signin/apple',
          '/signin/chatgpt',
          '/password-reset',
          '/password-reset/check',
          '/password-reset/consume',
          // A room invite is opened and accepted before its guest has an account.
          ...INVITE_PUBLIC_PATHS,
        ].includes(c.req.path));
    // A body is counted as it arrives, so one sent without a length, or with a
    // false one, is dropped at the limit rather than read and parsed whole.
    if (publicRoute) return publicBody(c, next);
    // The telephony provider's replies, keypresses and receipts carry no
    // session; each is believed only for its signature (see reach/routes.ts).
    if (c.req.method === 'POST' && REACH_WEBHOOK_PATH.test(c.req.path)) return publicBody(c, next);
    // So does a text to a person's own Twilio connection (see sms/routes.ts).
    if (c.req.method === 'POST' && SMS_WEBHOOK_PATH.test(c.req.path)) return publicBody(c, next);
    // A paired computer's companion holds no session. Every `/device/` route
    // checks the computer's own token and sets its own body limit; see
    // devices/routes.ts.
    if (c.req.path.startsWith('/device/')) return next();
    // A framed app's files are fetched from an opaque origin, which holds no
    // session. The token in the path is their whole authorisation; see
    // apps/serve.ts. Reading is all these routes do.
    if (viewPath(c.req.method, c.req.path)) return next();
    // A preview of a server in an agent's computer is fetched the same way; see
    // sandbox/preview.ts.
    if (previewPath(c.req.method, c.req.path)) return next();

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
    const active = await activeSession(db, token);
    if (!active) {
      return c.json({ error: { code: 'unauthorized', message: 'The session has expired.' } }, 401);
    }
    if (active.owner.kind === 'guest') {
      // With rooms switched off, a guest's sign-in reaches nothing at all.
      if (!multiplayer)
        return c.json(
          { error: { code: 'unauthorized', message: MULTIPLAYER_UNAVAILABLE.message } },
          401,
        );
      // A guest has no space of their own and no work outside their rooms.
      if (!guestMayUse(c.req.method, c.req.path))
        return c.json(
          {
            error: {
              code: 'guests_use_rooms',
              message: 'A guest account uses only the rooms it was invited to.',
            },
          },
          403,
        );
      c.set('owner', { ...publicOwner(active.owner), kind: 'guest' });
      c.set('sessionDigest', tokenHash(token));
      return principalContext.run(active.owner.id, () => sessionBody(c, next));
    }
    c.set('owner', { ...publicOwner(active.owner), kind: 'person' });
    c.set('sessionDigest', tokenHash(token));
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
      ? new ExperienceSignIn(deps.sql, deps.registry, env.MELETE_PUBLIC_URL, deps.accountMail)
      : undefined;
  if (deps.sql) {
    const devicesEnded = deps.devicesEnded ? { devicesEnded: deps.devicesEnded } : {};
    mountPassword(app, {
      sql: deps.sql,
      sessionCookie: SESSION_COOKIE,
      signIn,
      publicUrl: env.MELETE_PUBLIC_URL,
      clock,
      limits,
      ...devicesEnded,
    });
    mountAccountAccess(app, { sql: deps.sql, sessionCookie: SESSION_COOKIE, ...devicesEnded });
  }
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
    const label = browserOf(c);
    const token = await signIn.consume(input.token, (ownerId, principalId, spaceId) =>
      newSession(ownerId, principalId, spaceId, label),
    );
    sessionCookie(c, token, env);
    return c.json({ status: 'ok' });
  });
  for (const provider of ['google', 'apple'])
    app.post(`/signin/${provider}`, (c) =>
      c.json(unavailable('Use your password or an email sign-in link.')),
    );
  // Sign in with ChatGPT needs a client that OpenAI issues to the operator;
  // until an installation has one, the sign-in card says so.
  app.post('/signin/chatgpt', (c) =>
    c.json(unavailable('This installation hasn’t set up ChatGPT sign-in yet.')),
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
   * sign-in everywhere else. It says whether an owner exists, whether setup
   * needs the installation's code, and whether email sign-in can work here.
   */
  app.get('/setup', async (c) => {
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const [installed] = await db.select({ id: owner.id }).from(owner).limit(1);
    const needed = !installed;
    return c.json({
      needed,
      multiplayer,
      code_required: needed && handle ? await setupCodeRequired(handle, setupCodeHash) : false,
      email_sign_in: needed || !signIn ? false : await signIn.canSend(),
    });
  });

  app.post('/setup', async (c) => {
    const source = clientAddress(c);
    const retryAfter = await setupThrottle.admit(source);
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
    const input = await readCredentials(c, setupCredentials);
    if (!input) {
      return c.json(
        {
          error: {
            code: 'invalid_input',
            message: 'Provide an email and a password of at least 10 characters.',
          },
        },
        400,
      );
    }
    requireStrongPassword(input.password, input.email);
    // The code is checked before any work is done for whoever is asking.
    const codeNeeded = handle ? await setupCodeRequired(handle, setupCodeHash) : false;
    if (codeNeeded && !input.setup_code)
      return c.json(
        {
          error: {
            code: 'setup_code_required',
            message:
              'Enter the setup code for this installation. Whoever set it up has it, and the link they were given fills it in.',
          },
        },
        403,
      );
    if (codeNeeded && handle) {
      // Spent before the owner is made: a code that matched is used up even if
      // another setup wins the race, and a wrong one changes nothing.
      const spent = await handle.begin((tx) =>
        spendSetupCode(tx, setupCodeHash, input.setup_code ?? ''),
      );
      if (!spent)
        return c.json(
          {
            error: {
              code: 'invalid_setup_code',
              message:
                'That setup code is not right, or has expired. Check it, or ask for a new one.',
            },
          },
          403,
        );
    }
    const passwordHash = await Bun.password.hash(input.password, { algorithm: 'argon2id' });
    const ownerId = newId(ID_PREFIXES.owner);
    const personalId = newId(ID_PREFIXES.space);
    const authenticated = newSession(ownerId, ownerId, undefined, browserOf(c));
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
    await setupThrottle.succeeded(source);
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
      const retryAfter = await loginThrottle.admit(source);
      if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    }
    if (!db) {
      return c.json(
        { error: { code: 'database_unavailable', message: 'Configure Postgres.' } },
        503,
      );
    }
    const input = await readCredentials(c, credentials);
    if (!input) {
      return c.json(
        { error: { code: 'invalid_input', message: 'Provide an email and password.' } },
        400,
      );
    }
    const account = devices.account(input.email);
    const known = device?.account === account ? device : null;
    if (device && !known) {
      const retryAfter = await loginThrottle.admit(source);
      if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    }
    const retryAfter = await (known
      ? deviceThrottle.admit(known.nonce)
      : accountThrottle.admit(account));
    if (retryAfter > 0) return rateLimited(c, retryAfter, 'login');
    // An account that cannot sign in (a room's own principal, or a guest while
    // rooms are switched off) is looked up as if
    // the email were unknown, before any password is checked, so it costs the same.
    const [found] = await db
      .select()
      .from(principal)
      .where(
        and(
          eq(principal.email, input.email),
          inArray(principal.kind, signInKinds),
          isNull(principal.disabledAt),
        ),
      )
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
    const authenticated = newSession(installation.id, found.id, undefined, browserOf(c));
    await db.insert(session).values(authenticated.row);
    // Success clears only what this request paid into. The shared account
    // limiter gets this one attempt back and keeps every failure it has seen,
    // so it counts wrong passwords and one person signing in cannot reopen it.
    if (known) await deviceThrottle.succeeded(known.nonce);
    else {
      await loginThrottle.succeeded(source);
      await accountThrottle.refund(account);
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
          created_at: row.createdAt.toISOString(),
        })),
      }),
    );
  });
}
