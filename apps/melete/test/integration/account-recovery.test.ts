import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { describeReset, operatorReset } from '../../src/account/reset-password.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const email = 'owner@example.test';
const password = 'first-password-1';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

function app() {
  return createApp({
    env: loadEnv({ NODE_ENV: 'test' }),
    db: database().db,
    sql: database().sql,
    checkDatabase: async () => 'ok',
  });
}

const json = (body: object, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const cookieOf = (response: Response) => {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error('No session cookie was set');
  return value;
};
const sessionCount = async () =>
  Number((await database().sql`select count(*)::int as n from session`)[0]?.n);

describeWithDb('changing and resetting a password', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
  }, 15_000);
  afterAll(async () => {
    await handle?.close();
  });

  async function signedIn(api = app()) {
    const setup = await api.request('/setup', json({ email, password }));
    expect(setup.status).toBe(201);
    const here = cookieOf(setup);
    const elsewhere = cookieOf(await api.request('/login', json({ email, password })));
    return { api, here, elsewhere };
  }

  test('change password checks the current one, keeps this session and ends the others', async () => {
    const { api, here, elsewhere } = await signedIn();
    // A wrong current password is refused without signing the person out.
    const wrong = await api.request(
      '/account/password',
      json({ current_password: 'not-it-at-all', new_password: 'second-password-2' }, here),
    );
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('wrong_password');
    expect((await api.request('/me', { headers: { Cookie: here } })).status).toBe(200);

    const changed = await api.request(
      '/account/password',
      json({ current_password: password, new_password: 'second-password-2' }, here),
    );
    expect(changed.status).toBe(200);
    expect((await api.request('/me', { headers: { Cookie: here } })).status).toBe(200);
    expect((await api.request('/me', { headers: { Cookie: elsewhere } })).status).toBe(401);
    expect(await sessionCount()).toBe(1);
    expect((await api.request('/login', json({ email, password }))).status).toBe(401);
    expect(
      (await api.request('/login', json({ email, password: 'second-password-2' }))).status,
    ).toBe(200);
    // Both rows that carry the account's password moved together.
    const [row] = await database()
      .sql`select (select password_hash from owner) = (select password_hash from principal) as same`;
    expect(row?.same).toBe(true);
  });

  test('change password is throttled per account', async () => {
    const { api, here } = await signedIn();
    const statuses = [];
    for (let index = 0; index < 7; index++)
      statuses.push(
        (
          await api.request(
            '/account/password',
            json(
              { current_password: `wrong-${index}-guess`, new_password: 'another-pass-3' },
              here,
            ),
          )
        ).status,
      );
    expect(statuses).toContain(429);
    expect(statuses.slice(0, 4).every((status) => status === 400)).toBe(true);
  });

  test('the operator command prints a one-time link that sets a password and ends every session', async () => {
    const { api, here, elsewhere } = await signedIn();
    const missing = await operatorReset(database().sql, 'nobody@example.test', undefined);
    expect(missing.ok).toBe(false);
    expect(describeReset(missing)).toContain('No account signs in as nobody@example.test');

    const first = await operatorReset(database().sql, 'Owner@Example.test', 'https://melete.test');
    const second = await operatorReset(database().sql, email, 'https://melete.test');
    if (!first.ok || !second.ok) throw new Error('reset was not issued');
    expect(second.link).toStartWith('https://melete.test/#/reset?token=');
    expect(describeReset(second)).toContain('expires in 60 minutes');
    // Only a digest is stored.
    const stored = await database().sql`select token_hash from password_reset`;
    expect(stored.map((row) => row.token_hash)).toContain(
      createHash('sha256').update(second.code).digest('hex'),
    );
    expect(JSON.stringify(stored)).not.toContain(second.code);

    // The older link stopped working when the newer one was printed.
    const stale = await api.request(
      '/password-reset/consume',
      json({ token: first.code, new_password: 'reset-password-4' }),
    );
    expect(stale.status).toBe(400);

    const used = await api.request(
      '/password-reset/consume',
      json({ token: second.code, new_password: 'reset-password-4' }),
    );
    expect(used.status).toBe(200);
    expect(await sessionCount()).toBe(0);
    for (const cookie of [here, elsewhere])
      expect((await api.request('/me', { headers: { Cookie: cookie } })).status).toBe(401);
    expect(
      (await api.request('/login', json({ email, password: 'reset-password-4' }))).status,
    ).toBe(200);
    // A link works once.
    const again = await api.request(
      '/password-reset/consume',
      json({ token: second.code, new_password: 'reset-password-5' }),
    );
    expect(again.status).toBe(400);
  });

  test('one link used twice at once sets exactly one password', async () => {
    const { api } = await signedIn();
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    const tries = ['racing-password-1', 'racing-password-2'];
    const statuses = await Promise.all(
      tries.map(
        async (next) =>
          (
            await api.request(
              '/password-reset/consume',
              json({ token: issued.code, new_password: next }),
            )
          ).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 400]);
    const signIns = await Promise.all(
      tries.map(
        async (next) => (await api.request('/login', json({ email, password: next }))).status,
      ),
    );
    expect(signIns.filter((status) => status === 200)).toHaveLength(1);
  });

  test('a reset also ends what connected apps were granted', async () => {
    await signedIn();
    const [owner] = await database().sql`select p.id, s.id as space_id from principal p
      join space s on s.owner_principal_id = p.id where p.email = ${email} limit 1`;
    if (!owner) throw new Error('no owner');
    await database().sql`insert into mcp_client (id, name, redirect_uris)
      values ('mcp_client_test', 'Test app', ${JSON.stringify(['https://app.example.test/cb'])}::jsonb)`;
    for (const kind of ['access', 'refresh'])
      await database().sql`insert into mcp_token (token_hash, kind, family, client_id, principal_id,
        space_id, resource, scope, expires_at)
        values (${`hash-${kind}`}, ${kind}, 'family-1', 'mcp_client_test', ${owner.id},
        ${owner.space_id}, 'https://melete.test/mcp', 'melete', now() + interval '1 day')`;
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    const used = await app().request(
      '/password-reset/consume',
      json({ token: issued.code, new_password: 'reset-password-6' }),
    );
    expect(used.status).toBe(200);
    const live = await database()
      .sql`select count(*)::int as n from mcp_token where revoked_at is null`;
    expect(Number(live[0]?.n)).toBe(0);
  });

  test('an expired link is refused and guessing links is throttled', async () => {
    const { api } = await signedIn();
    const issued = await operatorReset(database().sql, email, undefined);
    if (!issued.ok) throw new Error('reset was not issued');
    expect(issued.link).toBeNull();
    expect(describeReset(issued)).toContain(issued.code);
    await database().sql`update password_reset set expires_at = now() - interval '1 second'`;
    const expired = await api.request(
      '/password-reset/consume',
      json({ token: issued.code, new_password: 'reset-password-6' }),
    );
    expect(expired.status).toBe(400);
    const statuses = [];
    for (let index = 0; index < 8; index++)
      statuses.push(
        (
          await api.request(
            '/password-reset/consume',
            json({ token: `guess-${index}-${'x'.repeat(30)}`, new_password: 'reset-password-7' }),
          )
        ).status,
      );
    expect(statuses).toContain(429);
    expect((await api.request('/login', json({ email, password }))).status).toBe(200);
  });

  test('asking for an email link without a mailbox says how to get one instead', async () => {
    const { api } = await signedIn();
    const response = await api.request('/password-reset', json({ email }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; reason?: string };
    expect(body.status).toBe('not_available');
    expect(body.reason).toContain('print you a reset link');
  });
});
