/**
 * Sign-in with an OpenID Connect identity provider, end to end against a
 * loopback provider and Postgres: a good sign-in, every ID token the service
 * must refuse, the two account modes, a disabled account, a required claim,
 * replayed answers, return paths that name another site, password sign-in
 * switched off, and back-channel logout.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { ID_PREFIXES } from '@melete/contracts';
import { runAccount } from '../../src/account/cli.ts';
import { operatorReset } from '../../src/account/reset-password.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { type FakeOidc, startFakeOidc } from '../fixtures/fake-oidc.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;
const PUBLIC_URL = 'https://melete.example.test';
const OWNER = 'owner@example.test';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

let fake: FakeOidc;
let basicFake: FakeOidc;

function app(settings: Record<string, string> = {}, provider: FakeOidc = fake) {
  return createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_PUBLIC_URL: PUBLIC_URL,
      MELETE_OIDC_ISSUER: provider.issuer,
      MELETE_OIDC_CLIENT_ID: provider.clientId,
      MELETE_OIDC_CLIENT_SECRET: provider.clientSecret,
      MELETE_OIDC_LABEL: 'Example ID',
      // The first account below is made without a setup code.
      MELETE_SETUP_OPEN: 'true',
      ...settings,
    }),
    db: database().db,
    checkDatabase: async () => 'ok',
  });
}

type App = ReturnType<typeof app>;

const cookieNamed = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1);

/** Opens the start route and follows the provider back, without calling the callback yet. */
async function begin(api: App, returnTo?: string) {
  const start = await api.request(
    `/signin/oidc/start${returnTo === undefined ? '' : `?return=${encodeURIComponent(returnTo)}`}`,
  );
  expect(start.status).toBe(302);
  const cookie = cookieNamed(start, 'melete_oidc');
  if (!cookie) throw new Error('The start route set no sign-in cookie');
  const authorize = new URL(start.headers.get('location') ?? '');
  const approved = await fetch(authorize, { redirect: 'manual' });
  const back = new URL(approved.headers.get('location') ?? '');
  expect(`${back.origin}${back.pathname}`).toBe(`${PUBLIC_URL}/api/signin/oidc/callback`);
  return { cookie, authorize, query: back.search };
}

async function finish(api: App, flow: { cookie: string; query: string }) {
  const callback = await api.request(`/signin/oidc/callback${flow.query}`, {
    headers: { cookie: flow.cookie },
  });
  expect(callback.status).toBe(302);
  return {
    location: callback.headers.get('location') ?? '',
    session: cookieNamed(callback, 'melete_session'),
  };
}

async function signIn(api: App, returnTo?: string) {
  return finish(api, await begin(api, returnTo));
}

const refusedWith = (code: string) => `${PUBLIC_URL}/#/welcome?signin_error=${code}`;

async function me(api: App, session: string | undefined) {
  const response = await api.request('/me', { headers: { cookie: session ?? '' } });
  return response.status === 200 ? ((await response.json()) as { owner: { email: string } }) : null;
}

withDb('sign-in with an OpenID Connect identity provider', () => {
  beforeAll(async () => {
    fake = await startFakeOidc();
    basicFake = await startFakeOidc({ basicOnly: true });
  });
  afterAll(async () => {
    await fake?.stop();
    await basicFake?.stop();
    await handle?.close();
  });
  beforeEach(async () => {
    await resetTestRows(database().sql);
    fake.claims = {};
    fake.signing = 'published';
    // The installation exists: its first account was made with a password.
    const setup = await app().request('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OWNER, password: 'a-long-owner-password' }),
    });
    expect(setup.status).toBe(201);
  }, 15_000);

  test('the setup status names the button, and an existing account signs in', async () => {
    const api = app();
    expect(((await (await api.request('/setup')).json()) as { signin: unknown }).signin).toEqual({
      password: true,
      oidc: { label: 'Example ID' },
    });
    fake.claims = { sub: 'owner-subject', email: 'Owner@Example.test' };
    const flow = await begin(api, '/chat/c_1');
    // PKCE, state, nonce and the configured scopes go to the provider; no resource does.
    expect(flow.authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorize.searchParams.get('nonce')).toBeTruthy();
    expect(flow.authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(flow.authorize.searchParams.get('client_id')).toBe(fake.clientId);
    expect(flow.authorize.searchParams.has('resource')).toBe(false);
    const done = await finish(api, flow);
    expect(done.location).toBe(`${PUBLIC_URL}/#/chat/c_1`);
    expect((await me(api, done.session))?.owner.email).toBe(OWNER);
    const linked = await database()
      .sql`select issuer, subject from oidc_identity where principal_id = (select id from principal where email = ${OWNER})`;
    expect([...linked]).toEqual([{ issuer: fake.issuer, subject: 'owner-subject' }]);
    // Later sign-ins follow the linked subject even after the provider's email changes.
    fake.claims = { sub: 'owner-subject', email: 'renamed@example.test' };
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
  });

  test('a provider that takes the client secret only by HTTP Basic is sent it that way', async () => {
    const api = app({}, basicFake);
    basicFake.claims = { sub: 'basic-subject', email: OWNER };
    const done = await signIn(api);
    expect(done.location).toBe(`${PUBLIC_URL}/#/`);
    expect((await me(api, done.session))?.owner.email).toBe(OWNER);
    expect(basicFake.tokenRequests.at(-1)?.has('client_secret')).toBe(false);
  });

  for (const [what, claims] of [
    ['another nonce', { nonce: 'not-the-one-sent' }],
    ['no nonce', { nonce: undefined }],
    ['another issuer', { iss: 'https://issuer.elsewhere.example' }],
    ['another audience', { aud: 'some-other-client' }],
    ['several audiences without this client as the party', { aud: ['melete-test-client', 'x'] }],
    ['an expiry long past', { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ['no subject', { sub: undefined }],
  ] as const)
    test(`an ID token with ${what} is refused`, async () => {
      fake.claims = { email: OWNER, ...claims };
      const done = await signIn(app());
      expect(done.location).toBe(refusedWith('signin_failed'));
      expect(done.session).toBeUndefined();
    });

  for (const signing of ['none', 'hs256-public-key', 'unpublished', 'header-key'] as const)
    test(`an ID token signed ${signing} is refused`, async () => {
      fake.claims = { email: OWNER };
      fake.signing = signing;
      const done = await signIn(app());
      expect(done.location).toBe(refusedWith('signin_failed'));
      expect(done.session).toBeUndefined();
      // A key the token names for itself is never fetched.
      expect(fake.headerKeyFetches).toBe(0);
    });

  test('accepted shapes: several audiences naming this client as the party, a string "true", a little clock skew', async () => {
    const api = app();
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { aud: [fake.clientId, 'another-api'], azp: fake.clientId },
      { email_verified: 'true' },
      // Expired 30 seconds ago: inside the minute of tolerance.
      { exp: now - 30, iat: now - 330 },
    ]) {
      fake.claims = { sub: 'owner-subject', email: OWNER, ...claims };
      expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
    }
    for (const claims of [
      // Past the tolerance.
      { exp: now - 120, iat: now - 420 },
      // One audience, but issued to another party.
      { azp: 'some-other-client' },
    ]) {
      fake.claims = { sub: 'owner-subject', email: OWNER, ...claims };
      expect((await signIn(api)).location).toBe(refusedWith('signin_failed'));
    }
  });

  test('an email that only case-folds to an account’s email does not reach that account', async () => {
    const api = app({ MELETE_OIDC_ACCOUNTS: 'create' });
    await database()
      .sql`insert into principal (id, email) values (${newId(ID_PREFIXES.owner)}, 'kelly@example.test')`;
    // U+212A KELVIN SIGN lower-cases to an ASCII "k": a different mailbox at the provider.
    fake.claims = { sub: 'kelvin', email: `${String.fromCharCode(0x212a)}elly@example.test` };
    const done = await signIn(api);
    expect(done.location).toBe(refusedWith('email_unverified'));
    expect(done.session).toBeUndefined();
    expect(await database().sql`select 1 from oidc_identity where subject = 'kelvin'`).toHaveLength(
      0,
    );
    // Plain upper case is the same address and still finds the account.
    fake.claims = { sub: 'kelly-subject', email: 'KELLY@Example.TEST' };
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe('kelly@example.test');
  });

  test('a state spent on a failed exchange cannot be tried again', async () => {
    const api = app();
    fake.claims = { email: OWNER };
    const flow = await begin(api);
    const query = new URLSearchParams(flow.query);
    const realCode = query.get('code') ?? '';
    query.set('code', 'not-a-code-the-provider-issued');
    const failed = await finish(api, { cookie: flow.cookie, query: `?${query}` });
    expect(failed.location).toBe(refusedWith('signin_failed'));
    query.set('code', realCode);
    const retried = await finish(api, { cookie: flow.cookie, query: `?${query}` });
    expect(retried.location).toBe(refusedWith('signin_expired'));
    expect(retried.session).toBeUndefined();
  });

  test('email linking limited to accounts without a password', async () => {
    const api = app({ MELETE_OIDC_EMAIL_LINK: 'no-password' });
    const { sql } = database();
    // The owner chose a password at setup: a verified email alone does not claim it.
    fake.claims = { sub: 'owner-subject', email: OWNER };
    expect((await signIn(api)).location).toBe(refusedWith('account_conflict'));
    expect(await sql`select 1 from oidc_identity`).toHaveLength(0);
    // An account the operator made without a password is claimed by its email.
    expect((await runAccount(sql, ['create', 'made@example.test'], PUBLIC_URL)).code).toBe(0);
    fake.claims = { sub: 'made-subject', email: 'made@example.test' };
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe('made@example.test');
    // The operator opens the owner's account to one link through the provider.
    const opened = await runAccount(sql, ['link', OWNER], PUBLIC_URL);
    expect(opened.code).toBe(0);
    // An opening that has run out claims nothing.
    await sql`update principal set oidc_link_until = now() - interval '1 minute' where email = ${OWNER}`;
    fake.claims = { sub: 'owner-subject', email: OWNER };
    expect((await signIn(api)).location).toBe(refusedWith('account_conflict'));
    expect((await runAccount(sql, ['link', OWNER], PUBLIC_URL)).code).toBe(0);
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
    // The opening is used up, and later sign-ins follow the link.
    const [owner] = await sql`select oidc_link_until from principal where email = ${OWNER}`;
    expect(owner?.oidc_link_until).toBeNull();
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
    // Another subject with the owner's email still gets nowhere.
    fake.claims = { sub: 'someone-else', email: OWNER };
    expect((await signIn(api)).location).toBe(refusedWith('account_conflict'));
    expect((await runAccount(sql, ['link', 'nobody@example.test'], PUBLIC_URL)).code).toBe(1);
  });

  test('an email the provider has not verified is refused', async () => {
    for (const verified of [false, undefined, 'false']) {
      fake.claims = { email: OWNER, email_verified: verified };
      const done = await signIn(app());
      expect(done.location).toBe(refusedWith('email_unverified'));
      expect(done.session).toBeUndefined();
    }
    expect((await database().sql`select count(*)::int as n from oidc_identity`)[0]?.n).toBe(0);
  });

  test('existing accounts only: an unknown email gets no account', async () => {
    fake.claims = { sub: 'stranger', email: 'stranger@example.test' };
    const done = await signIn(app());
    expect(done.location).toBe(refusedWith('no_account'));
    expect(
      await database().sql`select 1 from principal where email = 'stranger@example.test'`,
    ).toHaveLength(0);
  });

  test('creating accounts: concurrent first sign-ins make exactly one account', async () => {
    const api = app({ MELETE_OIDC_ACCOUNTS: 'create' });
    fake.claims = { sub: 'newcomer', email: 'newcomer@example.test' };
    const flows = await Promise.all(Array.from({ length: 6 }, () => begin(api)));
    const results = await Promise.all(flows.map((flow) => finish(api, flow)));
    for (const result of results) {
      expect(result.location).toBe(`${PUBLIC_URL}/#/`);
      expect((await me(api, result.session))?.owner.email).toBe('newcomer@example.test');
    }
    const { sql } = database();
    expect(
      (await sql`select count(*)::int as n from principal where email = 'newcomer@example.test'`)[0]
        ?.n,
    ).toBe(1);
    expect(
      (await sql`select count(*)::int as n from oidc_identity where subject = 'newcomer'`)[0]?.n,
    ).toBe(1);
    const [made] = await sql`select kind, password_hash, admin from principal
      where email = 'newcomer@example.test'`;
    expect(made).toEqual({ kind: 'person', password_hash: null, admin: false });
  });

  test('a second subject with the same email does not take over the linked account', async () => {
    const api = app({ MELETE_OIDC_ACCOUNTS: 'create' });
    fake.claims = { sub: 'first', email: 'shared@example.test' };
    expect((await signIn(api)).location).toBe(`${PUBLIC_URL}/#/`);
    fake.claims = { sub: 'second', email: 'shared@example.test' };
    const done = await signIn(api);
    expect(done.location).toBe(refusedWith('account_conflict'));
    expect(done.session).toBeUndefined();
  });

  test('a disabled account is refused, linked or not', async () => {
    const api = app();
    fake.claims = { sub: 'owner-subject', email: OWNER };
    expect((await signIn(api)).session).toBeDefined();
    await database().sql`update principal set disabled_at = now() where email = ${OWNER}`;
    const linked = await signIn(api);
    expect(linked.location).toBe(refusedWith('account_disabled'));
    expect(linked.session).toBeUndefined();
    await database().sql`delete from oidc_identity`;
    expect((await signIn(api)).location).toBe(refusedWith('account_disabled'));
  });

  test('a required claim decides who may enter', async () => {
    const api = app({ MELETE_OIDC_REQUIRE_CLAIM: 'groups=melete' });
    fake.claims = { email: OWNER };
    expect((await signIn(api)).location).toBe(refusedWith('not_allowed'));
    fake.claims = { email: OWNER, groups: ['staff', 'other'] };
    expect((await signIn(api)).location).toBe(refusedWith('not_allowed'));
    fake.claims = { email: OWNER, groups: ['staff', 'melete'] };
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
    const flag = app({ MELETE_OIDC_REQUIRE_CLAIM: 'melete_access=true' });
    fake.claims = { email: OWNER, melete_access: true };
    expect((await signIn(flag)).session).toBeDefined();
  });

  test('an answer is used once: a replay with its cookie, or another sign-in’s cookie, is refused', async () => {
    const api = app();
    fake.claims = { email: OWNER };
    const flow = await begin(api);
    expect((await finish(api, flow)).session).toBeDefined();
    const exchanges = fake.tokenRequests.length;
    const replay = await finish(api, flow);
    expect(replay.location).toBe(refusedWith('signin_expired'));
    expect(replay.session).toBeUndefined();
    // Refused before the code was spent again.
    expect(fake.tokenRequests.length).toBe(exchanges);

    const mine = await begin(api);
    const theirs = await begin(api);
    const crossed = await finish(api, { cookie: mine.cookie, query: theirs.query });
    expect(crossed.location).toBe(refusedWith('signin_expired'));
    expect(
      (await finish(api, { cookie: 'melete_oidc=v1.forged', query: theirs.query })).location,
    ).toBe(refusedWith('signin_expired'));
    const without = await api.request(`/signin/oidc/callback${theirs.query}`);
    expect(without.headers.get('location')).toBe(refusedWith('signin_expired'));
    // A cookie from another installation's key opens nothing either.
    const other = app({ MELETE_MASTER_KEY: 'k'.repeat(40) });
    expect((await finish(other, theirs)).location).toBe(refusedWith('signin_expired'));
  });

  test('a return path naming another site lands on the home screen', async () => {
    const api = app();
    fake.claims = { email: OWNER };
    for (const target of [
      '//evil.example/x',
      'https://evil.example/',
      '/\\evil.example',
      'javascript:alert(1)',
      ' /chat',
      `/${'a'.repeat(600)}`,
    ]) {
      const done = await signIn(api, target);
      expect(done.location).toBe(`${PUBLIC_URL}/#/`);
    }
    expect((await signIn(api, '/plans?tab=week')).location).toBe(`${PUBLIC_URL}/#/plans?tab=week`);
  });

  test('a provider error comes back as declined, and nothing is signed in', async () => {
    const api = app();
    const flow = await begin(api);
    const state = new URLSearchParams(flow.query).get('state') ?? '';
    const done = await finish(api, {
      cookie: flow.cookie,
      query: `?error=access_denied&state=${encodeURIComponent(state)}`,
    });
    expect(done.location).toBe(refusedWith('signin_declined'));
    expect(done.session).toBeUndefined();
  });

  test('with password sign-in off, the provider is the only way in', async () => {
    const api = app({ MELETE_PASSWORD_SIGNIN: 'off' });
    const status = (await (await api.request('/setup')).json()) as Record<string, unknown>;
    expect(status.signin).toEqual({ password: false, oidc: { label: 'Example ID' } });
    expect(status.email_sign_in).toBe(false);
    for (const path of ['/login', '/signin/magic-link', '/password-reset']) {
      const refused = await api.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: OWNER, password: 'a-long-owner-password' }),
      });
      expect(refused.status).toBe(403);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'password_signin_off',
      );
    }
    fake.claims = { email: OWNER };
    expect((await me(api, (await signIn(api)).session))?.owner.email).toBe(OWNER);
  });

  test('with password sign-in off, a reset link the operator prints is refused too, and the CLI says so', async () => {
    const api = app({ MELETE_PASSWORD_SIGNIN: 'off' });
    const { sql } = database();
    const issued = await operatorReset(sql, OWNER, PUBLIC_URL);
    if (!issued.ok) throw new Error(issued.message);
    for (const [path, body] of [
      ['/password-reset/check', { token: issued.code }],
      ['/password-reset/consume', { token: issued.code, password: 'another-long-password-1' }],
      ['/signin/magic-link/check', { token: issued.code }],
      ['/signin/magic-link/consume', { token: issued.code }],
    ] as const) {
      const refused = await api.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(refused.status).toBe(403);
    }
    const off = { passwordSignIn: false };
    const reset = await runAccount(sql, ['reset', OWNER], PUBLIC_URL, undefined, off);
    expect(reset.code).toBe(1);
    expect(reset.out).toContain('MELETE_PASSWORD_SIGNIN');
    const made = await runAccount(
      sql,
      ['create', 'later@example.test', '--json'],
      PUBLIC_URL,
      undefined,
      off,
    );
    expect(made.code).toBe(0);
    const json = JSON.parse(made.out) as Record<string, unknown>;
    expect(json.link).toBeNull();
    expect(json.code).toBeUndefined();
    expect(
      await sql`select 1 from password_reset where principal_id = (select id from principal where email = 'later@example.test')`,
    ).toHaveLength(0);
  });

  test('without a provider set up the routes are not there', async () => {
    const api = createApp({
      env: loadEnv({ NODE_ENV: 'test' }),
      db: database().db,
      checkDatabase: async () => 'ok',
    });
    expect((await api.request('/signin/oidc/start')).status).toBe(404);
    expect(((await (await api.request('/setup')).json()) as { signin: unknown }).signin).toEqual({
      password: true,
      oidc: null,
    });
  });

  test('back-channel logout ends the subject’s browser sessions', async () => {
    const api = app();
    fake.claims = { sub: 'owner-subject', email: OWNER };
    const first = await signIn(api);
    const second = await signIn(api);
    expect(await me(api, first.session)).not.toBeNull();
    const now = Math.floor(Date.now() / 1000);
    const logout = (logout_token: string) =>
      api.request('/signin/oidc/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ logout_token }).toString(),
      });
    const claims = {
      iss: fake.issuer,
      aud: fake.clientId,
      sub: 'owner-subject',
      iat: now,
      jti: 'logout-1',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    };
    // A token without the logout event, or carrying a nonce, is refused and ends nothing.
    expect((await logout(await fake.sign({ ...claims, events: {} }))).status).toBe(400);
    expect((await logout(await fake.sign({ ...claims, nonce: 'n' }))).status).toBe(400);
    expect((await logout('not-a-token')).status).toBe(400);
    expect(await me(api, first.session)).not.toBeNull();
    const ended = await logout(await fake.sign(claims, 'logout+jwt'));
    expect(ended.status).toBe(200);
    expect(await me(api, first.session)).toBeNull();
    expect(await me(api, second.session)).toBeNull();
    // A logout token is used once: replayed, it does not end the session made since.
    const third = await signIn(api);
    const replay = await logout(await fake.sign(claims, 'logout+jwt'));
    expect(replay.status).toBe(400);
    expect(await me(api, third.session)).not.toBeNull();
    // The event's value has to be an object.
    const nulled = await logout(
      await fake.sign({
        ...claims,
        jti: 'logout-2',
        events: { 'http://schemas.openid.net/event/backchannel-logout': null },
      } as never),
    );
    expect(nulled.status).toBe(400);
    expect(await me(api, third.session)).not.toBeNull();
  });

  test('back-channel logout ends only that subject’s sessions', async () => {
    const api = app();
    expect(
      (await runAccount(database().sql, ['create', 'other@example.test'], PUBLIC_URL)).code,
    ).toBe(0);
    fake.claims = { sub: 'owner-subject', email: OWNER };
    const owner = await signIn(api);
    fake.claims = { sub: 'other-subject', email: 'other@example.test' };
    const other = await signIn(api);
    const now = Math.floor(Date.now() / 1000);
    const token = await fake.sign({
      iss: fake.issuer,
      aud: fake.clientId,
      sub: 'owner-subject',
      iat: now,
      jti: 'logout-only-owner',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    const ended = await api.request('/signin/oidc/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: token }).toString(),
    });
    expect(ended.status).toBe(200);
    expect(await me(api, owner.session)).toBeNull();
    expect((await me(api, other.session))?.owner.email).toBe('other@example.test');
  });
});
