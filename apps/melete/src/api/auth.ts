import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ID_PREFIXES,
  magicLinkConsume,
  magicLinkRequest,
  spaceListResponse,
  unavailable,
} from '@melete/contracts';
import { and, eq, gt } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { session } from '../db/auth-schema.ts';
import type { Database } from '../db/client.ts';
import { owner, space } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { ExperienceSignIn } from '../experience/signin.ts';
import { newId } from '../ids.ts';

export const SESSION_COOKIE = 'melete_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const credentials = z.object({
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
  }
}

const publicOwner = (row: typeof owner.$inferSelect): SessionOwner => ({
  id: row.id,
  email: row.email,
  created_at: row.createdAt.toISOString(),
});

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function newSession(ownerId: string, spaceId?: string) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    row: {
      tokenHash: tokenHash(token),
      ownerId,
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

async function readCredentials(c: Context) {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/json') return null;
  const parsed = credentials.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export function mountAuth(
  app: Hono,
  deps: { db: Database | null; env: Env; sql?: Sql; registry?: ConnectorRegistry },
): void {
  const { db, env } = deps;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!allowedMutation(c)) {
      return c.json({ error: { code: 'origin_rejected', message: 'Use the same origin.' } }, 403);
    }
    const publicRoute =
      (c.req.method === 'GET' && c.req.path === '/health') ||
      (c.req.method === 'POST' &&
        [
          '/setup',
          '/login',
          '/signin/magic-link',
          '/signin/magic-link/consume',
          '/signin/google',
          '/signin/apple',
        ].includes(c.req.path));
    if (publicRoute) return next();

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
      .select({ owner, spaceId: session.spaceId })
      .from(session)
      .innerJoin(owner, eq(session.ownerId, owner.id))
      .where(and(eq(session.tokenHash, tokenHash(token)), gt(session.expiresAt, new Date())))
      .limit(1);
    if (!active) {
      return c.json({ error: { code: 'unauthorized', message: 'The session has expired.' } }, 401);
    }
    c.set('owner', publicOwner(active.owner));
    const selected =
      active.spaceId ??
      (
        await db
          .select({ id: space.id })
          .from(space)
          .where(eq(space.kind, 'personal'))
          .orderBy(space.createdAt, space.id)
          .limit(1)
      )[0]?.id;
    if (selected) c.set('experienceSpaceId', selected);
    return next();
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

  app.post('/setup', async (c) => {
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
      await tx.insert(space).values({
        id: personalId,
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
    sessionCookie(c, authenticated.token, env);
    return c.json({ owner: publicOwner(created) }, 201);
  });

  app.post('/login', async (c) => {
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
    const [found] = await db.select().from(owner).where(eq(owner.email, input.email)).limit(1);
    if (!found?.passwordHash || !(await Bun.password.verify(input.password, found.passwordHash))) {
      return c.json(
        { error: { code: 'invalid_credentials', message: 'Email or password is wrong.' } },
        401,
      );
    }
    const authenticated = newSession(found.id);
    await db.insert(session).values(authenticated.row);
    sessionCookie(c, authenticated.token, env);
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
    const rows = await db.select().from(space).orderBy(space.createdAt, space.id);
    return c.json(
      spaceListResponse.parse({
        spaces: rows.map((row) => ({
          id: row.id,
          name: row.name,
          kind: row.kind,
          audience: row.audience,
          git_path: row.gitPath,
          created_at: row.createdAt.toISOString(),
        })),
      }),
    );
  });
}
