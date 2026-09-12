import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spaceListResponse } from '@melete/contracts';
import { apiFetch, apiNetwork } from '../../src/api/listener.ts';
import { LoginThrottle } from '../../src/api/login-throttle.ts';
import { session } from '../../src/db/auth-schema.ts';
import { pingDatabase } from '../../src/db/client.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const password = 'my-test-password';
const email = 'owner@example.test';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

function app(nodeEnv: 'test' | 'production' = 'test') {
  return createApp({
    env: loadEnv({ NODE_ENV: nodeEnv }),
    db: database().db,
    checkDatabase: async () => 'ok',
  });
}

function credentials(body: object = { email, password }): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function cookie(response: Response): string {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('The response did not set a session cookie');
  return value;
}

describeWithDb('single-owner authentication against Postgres', () => {
  test('answers a ping on the migrated Postgres instance', async () => {
    expect(await pingDatabase(database())).toBe(true);
  });
  beforeEach(async () => {
    await database().sql`truncate "owner", "space" cascade`;
  }, 15_000);

  afterAll(async () => {
    await handle?.close();
  });

  test('racing setup requests atomically create one owner, space, and session', async () => {
    const api = app();
    const responses = await Promise.all([
      api.request('/setup', credentials()),
      api.request('/setup', credentials({ email: 'other@example.test', password })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const counts = await database().sql`
      select (select count(*)::int from "owner") as owners,
        (select count(*)::int from "space") as spaces,
        (select count(*)::int from "session") as sessions`;
    expect(counts?.[0]).toEqual({ owners: 1, spaces: 1, sessions: 1 });
    expect((await api.request('/setup', credentials())).status).toBe(409);
  });

  test('passwords use argon2id and only a digest of the opaque cookie is stored', async () => {
    const setup = await app().request('/setup', credentials());
    expect(setup.status).toBe(201);
    const setCookie = setup.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    const responseText = await setup.text();
    expect(responseText).not.toContain(password);
    expect(responseText).not.toContain('password_hash');
    expect(responseText).not.toContain('passwordHash');
    const rows = await database().sql`select password_hash from "owner"`;
    expect(rows?.[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
    expect(await Bun.password.verify(password, rows?.[0]?.password_hash)).toBe(true);
    const raw = cookie(setup).split('=')[1];
    expect(raw).toHaveLength(43);
    const sessions = await database().sql`select token_hash from "session"`;
    expect(sessions?.[0]?.token_hash).toBe(
      createHash('sha256')
        .update(raw ?? '')
        .digest('hex'),
    );
    expect(sessions?.[0]?.token_hash).not.toBe(raw);
  });

  test('login verifies the password, issues a fresh cookie, and returns the public owner', async () => {
    const api = app();
    const setup = await api.request('/setup', credentials());
    const wrong = await api.request('/login', credentials({ email, password: 'wrong-password' }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect(
      (await api.request('/login', credentials({ email: 'missing@example.test', password })))
        .status,
    ).toBe(401);
    const login = await api.request(
      '/login',
      credentials({ email: email.toUpperCase(), password }),
    );
    expect(login.status).toBe(200);
    expect(cookie(login)).not.toBe(cookie(setup));
    const me = await api.request('/me', { headers: { Cookie: cookie(login) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { owner: Record<string, unknown> };
    expect(body.owner.email).toBe(email);
    expect(Object.keys(body.owner).sort()).toEqual(['created_at', 'email', 'id']);
  });

  test('all other routes require a valid cookie while health stays public', async () => {
    const api = app();
    expect((await api.request('/health')).status).toBe(200);
    for (const path of ['/me', '/spaces', '/jobs', '/events', '/setup', '/missing']) {
      expect((await api.request(path)).status).toBe(401);
    }
    expect((await api.request('/jobs', { method: 'POST' })).status).toBe(401);
    expect(
      (await api.request('/me', { headers: { Cookie: 'melete_session=invalid' } })).status,
    ).toBe(401);
    expect(
      (
        await api.request('/me', {
          headers: { Cookie: `melete_session=${'x'.repeat(43)}` },
        })
      ).status,
    ).toBe(401);
  });

  test('the setup cookie reads the seeded personal space using the frozen response contract', async () => {
    const api = app();
    const setup = await api.request('/setup', credentials());
    const spaces = await api.request('/spaces', { headers: { Cookie: cookie(setup) } });
    expect(spaces.status).toBe(200);
    const body = spaceListResponse.parse(await spaces.json());
    expect(body.spaces).toHaveLength(1);
    expect(body.spaces[0]?.name).toBe('Personal');
    expect(body.spaces[0]?.kind).toBe('personal');
    expect(body.spaces[0]?.audience).toBe('owner');
  });

  test('an expired persistent session is rejected', async () => {
    const api = app();
    const setup = await api.request('/setup', credentials());
    await handle?.db.update(session).set({ expiresAt: new Date(0) });
    const me = await api.request('/me', { headers: { Cookie: cookie(setup) } });
    expect(me.status).toBe(401);
  });

  test('a second service instance recognizes the persisted session', async () => {
    const setup = await app().request('/setup', credentials());
    expect((await app().request('/me', { headers: { Cookie: cookie(setup) } })).status).toBe(200);
  });

  test('browser mutation gates reject cross-origin setup, login, and authenticated writes', async () => {
    const api = app();
    const foreign = {
      ...credentials(),
      headers: { 'Content-Type': 'application/json', Origin: 'https://another.example' },
    };
    expect((await api.request('/setup', foreign)).status).toBe(403);
    const setup = await api.request('/setup', credentials());
    expect((await api.request('/login', foreign)).status).toBe(403);
    expect(
      (
        await api.request('/jobs', {
          method: 'POST',
          headers: { Cookie: cookie(setup), 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request('/login', {
          ...credentials(),
          headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
        })
      ).status,
    ).toBe(200);
  });

  test('production cookies are secure and invalid setup bodies cannot create an owner', async () => {
    const api = app('production');
    expect((await api.request('/setup', credentials({ email: 'invalid', password }))).status).toBe(
      400,
    );
    expect((await api.request('/setup', credentials({ email, password: 'short' }))).status).toBe(
      400,
    );
    expect((await api.request('/setup', { method: 'POST', body: '{' })).status).toBe(400);
    const setup = await api.request('/setup', credentials());
    expect(setup.status).toBe(201);
    expect(setup.headers.get('set-cookie')).toContain('Secure');
  });

  test('runtime peers cannot claim the owner or read account state before or after setup', async () => {
    const api = app();
    const boundary = apiFetch(api, apiNetwork('172.20.0.3', '255.255.0.0'));
    const probe = async () => {
      for (const path of ['/setup', '/login', '/health']) {
        const response = await boundary(
          new Request(`http://melete:8787${path}`, path === '/health' ? {} : credentials()),
          { requestIP: () => ({ address: '172.21.0.2' }) },
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({
          error: { code: 'control_plane_forbidden', message: 'Forbidden.' },
        });
      }
    };
    await probe();
    const [before] = await database().sql`select count(*)::int as count from "owner"`;
    expect(before?.count).toBe(0);
    expect((await api.request('/setup', credentials())).status).toBe(201);
    await probe();
    const [after] = await database().sql`select count(*)::int as count from "owner"`;
    expect(after?.count).toBe(1);
  });

  test('login throttles the socket source before password checks and ignores forged source headers', async () => {
    let now = 0;
    const api = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: database().db,
      checkDatabase: async () => 'ok',
      loginThrottle: new LoginThrottle(() => now),
    });
    expect((await api.request('/setup', credentials())).status).toBe(201);
    const login = (source: string, correct = false) =>
      api.request(
        '/login',
        {
          ...credentials({ email, password: correct ? password : 'wrong-password' }),
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': String(Math.random()) },
        },
        { remoteAddress: source },
      );
    const burst = await Promise.all(Array.from({ length: 5 }, () => login('172.20.0.2')));
    expect(burst.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    const denied = await login('172.20.0.2', true);
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('1');
    expect(denied.headers.get('set-cookie')).toBeNull();
    expect((await login('172.20.0.4', true)).status).toBe(200);
    now = 1000;
    expect((await login('172.20.0.2')).status).toBe(401);
    const backedOff = await login('172.20.0.2');
    expect(backedOff.status).toBe(429);
    expect(backedOff.headers.get('retry-after')).toBe('2');
    now = 3000;
    expect((await login('172.20.0.2', true)).status).toBe(200);
    expect((await login('172.20.0.2', true)).status).toBe(200);
  });
});
