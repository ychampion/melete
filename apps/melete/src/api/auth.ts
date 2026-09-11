import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ID_PREFIXES, spaceListResponse } from '@melete/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { session } from '../db/auth-schema.ts';
import type { Database } from '../db/client.ts';
import { owner, principal, space } from '../db/schema.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import { principalContext, visibleSpace } from '../principals/authority.ts';

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
  }
}

const publicOwner = (row: typeof owner.$inferSelect): SessionOwner => ({
  id: row.id,
  email: row.email,
  created_at: row.createdAt.toISOString(),
});

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function newSession(ownerId: string, principalId = ownerId) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    row: {
      tokenHash: tokenHash(token),
      ownerId,
      principalId,
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

export function mountAuth(app: Hono, deps: { db: Database | null; env: Env }): void {
  const { db, env } = deps;

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!allowedMutation(c)) {
      return c.json({ error: { code: 'origin_rejected', message: 'Use the same origin.' } }, 403);
    }
    const publicRoute =
      (c.req.method === 'GET' && c.req.path === '/health') ||
      (c.req.method === 'POST' && ['/setup', '/login'].includes(c.req.path));
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
      .select({ owner: principal })
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
    return principalContext.run(active.owner.id, next);
  });

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
    const [found] = await db
      .select()
      .from(principal)
      .where(eq(principal.email, input.email))
      .limit(1);
    if (!found?.passwordHash || !(await Bun.password.verify(input.password, found.passwordHash))) {
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
