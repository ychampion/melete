/**
 * Signing out ends the session behind the cookie: the row is gone, the cookie
 * is cleared, and the same cookie no longer opens anything.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

withDb('sign-out', () => {
  afterAll(async () => {
    await handle?.close();
  });

  test('a signed-out session is unauthorized afterwards and its cookie is cleared', async () => {
    if (!handle) return;
    const app = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: handle.db,
      checkDatabase: async () => 'ok',
    });
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'leaving@example.test', password: 'fixture-password' }),
    });
    expect(setup.status).toBe(201);
    const cookie = setup.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Setup omitted the session');
    expect((await app.request('/me', { headers: { cookie } })).status).toBe(200);

    const signedOut = await app.request('/signout', { method: 'POST', headers: { cookie } });
    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({ status: 'ok' });
    const cleared = signedOut.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('melete_session=');
    expect(cleared).toMatch(/Max-Age=0|Expires=/);

    const sessions = await handle.sql`select count(*)::int as n from session`;
    expect(sessions[0]?.n).toBe(0);
    expect((await app.request('/me', { headers: { cookie } })).status).toBe(401);
    expect((await app.request('/profile', { headers: { cookie } })).status).toBe(401);
    // Signing out again with the dead cookie is refused the same way.
    expect((await app.request('/signout', { method: 'POST', headers: { cookie } })).status).toBe(
      401,
    );
    // Without any session the route is not public either.
    expect((await app.request('/signout', { method: 'POST' })).status).toBe(401);
  });
});
