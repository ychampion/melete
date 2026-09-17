import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { spaceListResponse } from '@melete/contracts';
import { apiFetch, apiNetwork } from '../../src/api/listener.ts';
import { LoginThrottle } from '../../src/api/login-throttle.ts';
import { session } from '../../src/db/auth-schema.ts';
import { pingDatabase } from '../../src/db/client.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

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
    await resetTestRows(database().sql);
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

  const throttled = (clock: () => number) =>
    createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: database().db,
      checkDatabase: async () => 'ok',
      loginThrottle: new LoginThrottle(clock),
    });
  const deviceCookie = (response: Response): string => {
    const value = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_device='));
    if (!value) throw new Error('The response did not set a device cookie');
    return value;
  };
  const proxy = '172.20.0.5';
  const attempt = (
    api: ReturnType<typeof createApp>,
    client: string,
    options: { correct?: boolean; device?: string; account?: string } = {},
  ) =>
    api.request(
      '/login',
      {
        ...credentials({
          email: options.account ?? email,
          password: options.correct ? password : 'wrong-password',
        }),
        headers: {
          'Content-Type': 'application/json',
          ...(options.device ? { Cookie: options.device } : {}),
        },
      },
      // What the listener hands over once it has decided whose address to believe.
      { remoteAddress: proxy, clientAddress: client },
    );

  test('browsers behind the web proxy are throttled by their own address', async () => {
    const api = throttled(() => 0);
    expect((await api.request('/setup', credentials())).status).toBe(201);
    const burst = await Promise.all(Array.from({ length: 5 }, () => attempt(api, '198.51.100.1')));
    expect(burst.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    const denied = await attempt(api, '198.51.100.1', { correct: true });
    expect(denied.status).toBe(429);
    expect(denied.headers.get('retry-after')).toBe('1');
    // Another browser arrives through the same proxy socket and is not held back.
    expect((await attempt(api, '198.51.100.2', { correct: true })).status).toBe(200);
  });

  test('a forged client address from a peer that is not the proxy mints no fresh bucket', async () => {
    const api = throttled(() => 0);
    expect((await api.request('/setup', credentials())).status).toBe(201);
    const boundary = apiFetch(
      api,
      apiNetwork('172.20.0.3', '255.255.0.0'),
      (peer) => peer === proxy,
    );
    const from = (peer: string, claimed: string, account = email) =>
      boundary(
        new Request('http://melete-api:8787/login', {
          ...credentials({ email: account, password: 'wrong-password' }),
          headers: { 'Content-Type': 'application/json', 'X-Melete-Client-Address': claimed },
        }),
        { requestIP: () => ({ address: peer }) },
      );
    const forged = [];
    for (let i = 0; i < 7; i++) forged.push((await from('172.20.0.9', `203.0.113.${i}`)).status);
    expect(forged).toEqual([401, 401, 401, 401, 401, 429, 429]);
    // The proxy is believed, and each browser behind it has its own bucket.
    const proxied = [];
    for (let i = 0; i < 8; i++)
      proxied.push((await from(proxy, `203.0.113.${i}`, 'nobody@example.test')).status);
    expect(proxied).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    // A value that is not an address is not believed either; the proxy's own bucket takes it.
    const malformed = [];
    for (let i = 0; i < 6; i++)
      malformed.push((await from(proxy, `not-an-address-${i}`, `nobody${i}@example.test`)).status);
    expect(malformed).toEqual([401, 401, 401, 401, 401, 429]);
  });

  test('strangers cannot lock a known browser out of its account', async () => {
    let now = 0;
    const api = throttled(() => now);
    const setup = await api.request('/setup', credentials());
    expect(setup.status).toBe(201);
    expect(
      (
        await api.request('/principals', {
          ...credentials({ email: 'second@example.test', password }),
          headers: { 'Content-Type': 'application/json', Cookie: cookie(setup) },
        })
      ).status,
    ).toBe(201);
    const first = await attempt(api, '198.51.100.1', { correct: true });
    expect(first.status).toBe(200);
    const known = deviceCookie(first);
    const attributes = first.headers
      .getSetCookie()
      .find((entry) => entry.startsWith('melete_device='));
    expect(attributes).toContain('HttpOnly');
    expect(attributes).toContain('SameSite=Strict');
    expect(known).not.toContain(email);
    expect(cookie(first).startsWith('melete_session=')).toBe(true);
    const other = deviceCookie(
      await attempt(api, '198.51.100.2', { correct: true, account: 'second@example.test' }),
    );

    // One wrong guess each from many addresses: no address is throttled, the account is.
    const guesses = [];
    for (let i = 0; i < 10; i++) guesses.push((await attempt(api, `203.0.113.${i}`)).status);
    expect(guesses).toEqual(Array.from({ length: 10 }, () => 401));
    const locked = await attempt(api, '203.0.113.50', { correct: true });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('1');
    expect(locked.headers.get('set-cookie')).toBeNull();

    // The known browser signs in from its own address and from one a stranger used.
    expect((await attempt(api, '198.51.100.1', { correct: true, device: known })).status).toBe(200);
    expect((await attempt(api, '203.0.113.0', { correct: true, device: known })).status).toBe(200);
    // Proof for another account, or a tampered proof, earns nothing here.
    expect((await attempt(api, '203.0.113.51', { correct: true, device: other })).status).toBe(429);
    const tampered = `${known.slice(0, -2)}${known.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await attempt(api, '203.0.113.52', { correct: true, device: tampered })).status).toBe(
      429,
    );
    // The other account is untouched by all of this.
    expect(
      (await attempt(api, '203.0.113.53', { correct: true, account: 'second@example.test' }))
        .status,
    ).toBe(200);

    // Refused requests change nothing: the wait does not grow while they keep coming.
    for (let i = 0; i < 40; i++) {
      const refused = await attempt(api, `203.0.113.${60 + i}`);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBe('1');
    }
    now = 1000;
    expect((await attempt(api, '203.0.113.120', { correct: true })).status).toBe(200);
    // That sign-in handed its own attempt back but cleared nobody else's failures.
    expect((await attempt(api, '203.0.113.121')).status).toBe(401);
    expect((await attempt(api, '203.0.113.122', { correct: true })).status).toBe(429);
    // Signing in correctly, however often, never closes the account to new browsers.
    for (let i = 0; i < 25; i++)
      expect(
        (
          await attempt(api, `203.0.113.${130 + i}`, {
            correct: true,
            account: 'second@example.test',
          })
        ).status,
      ).toBe(200);

    // A known browser has an attempt budget of its own and spends nobody else's.
    now = 20 * 60_000;
    const wrong = [];
    for (let i = 0; i < 6; i++)
      wrong.push((await attempt(api, '198.51.100.1', { device: known })).status);
    expect(wrong).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await attempt(api, '198.51.100.9', { correct: true })).status).toBe(200);
  }, 60_000);

  test('setup answers an installed service before hashing and is throttled', async () => {
    const api = throttled(() => 0);
    expect((await api.request('/setup', credentials())).status).toBe(201);
    const hash = spyOn(Bun.password, 'hash');
    try {
      const source = { remoteAddress: proxy, clientAddress: '203.0.113.7' };
      const repeated = [];
      for (let i = 0; i < 7; i++) {
        const body = credentials({ email: `again${i}@example.test`, password });
        repeated.push((await api.request('/setup', body, source)).status);
      }
      expect(repeated).toEqual([409, 409, 409, 409, 409, 429, 429]);
      expect(hash).toHaveBeenCalledTimes(0);
      // Setup attempts spend no login budget, and another address is not held back.
      const elsewhere = { remoteAddress: proxy, clientAddress: '203.0.113.8' };
      expect((await api.request('/setup', credentials(), elsewhere)).status).toBe(409);
      expect((await attempt(api, '203.0.113.7', { correct: true })).status).toBe(200);
    } finally {
      hash.mockRestore();
    }
  });

  test('an unknown email costs the same password verification as a known one', async () => {
    const api = throttled(() => 0);
    expect((await api.request('/setup', credentials())).status).toBe(201);
    await database()
      .sql`insert into principal (id, email) values ('own_passwordless', 'nopassword@example.test')`;
    const verify = spyOn(Bun.password, 'verify');
    try {
      for (const account of ['missing@example.test', 'nopassword@example.test', email]) {
        verify.mockClear();
        const response = await attempt(api, '203.0.113.9', { account });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          error: { code: 'invalid_credentials', message: 'Email or password is wrong.' },
        });
        expect([account, verify.mock.calls.length]).toEqual([account, 1]);
        expect(String(verify.mock.calls[0]?.[1]).startsWith('$argon2id$')).toBe(true);
      }
    } finally {
      verify.mockRestore();
    }
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
