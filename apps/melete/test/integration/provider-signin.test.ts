import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../../src/env.ts';
import { PostgresCredentialRepository, ProviderSignIn } from '../../src/gateway/credentials.ts';
import { type FakeIssuer, startFakeIssuer } from '../../src/gateway/fixtures/fake-oauth.ts';
import { chatgptIssuer } from '../../src/gateway/oauth.ts';
import { createApp } from '../../src/index.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const masterKey = randomBytes(32).toString('hex');
const password = 'my-test-password';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

/** A response body, read loosely: each test checks the fields it names. */
// biome-ignore lint/suspicious/noExplicitAny: test bodies are asserted field by field.
type Json = Record<string, any>;

let issuer: FakeIssuer;
/** Every body the API answered with, searched for tokens after each test. */
let answered: string[];

function signInService(log: string[] = []) {
  return new ProviderSignIn({
    repository: new PostgresCredentialRepository(database().sql),
    issuers: { chatgpt: chatgptIssuer({ issuer: issuer.url }) },
    masterKey: () => masterKey,
    log: (line) => log.push(line),
  });
}

function app(withKey = true) {
  const env = loadEnv({ NODE_ENV: 'test', ...(withKey ? { MELETE_MASTER_KEY: masterKey } : {}) });
  const built = createApp({
    env,
    db: database().db,
    sql: database().sql,
    providerSignIn: withKey ? signInService() : undefined,
    checkDatabase: async () => 'ok',
  });
  return {
    async call(path: string, cookie: string, init: RequestInit = {}) {
      const response = await built.request(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', cookie, ...(init.headers ?? {}) },
      });
      const text = await response.text();
      answered.push(text);
      return {
        status: response.status,
        body: text ? (JSON.parse(text) as Json) : {},
      };
    },
    request: built.request.bind(built),
  };
}

const sessionOf = (response: Response) =>
  response.headers.get('set-cookie')?.split(';')[0] ?? 'missing';

async function owner(api: ReturnType<typeof app>) {
  const setup = await api.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password }),
  });
  expect(setup.status).toBe(201);
  return sessionOf(setup);
}

async function member(api: ReturnType<typeof app>, ownerCookie: string) {
  const made = await api.call('/principals', ownerCookie, {
    method: 'POST',
    body: JSON.stringify({ email: 'member@example.test', password }),
  });
  expect(made.status).toBe(201);
  const login = await api.request('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'member@example.test', password }),
  });
  expect(login.status).toBe(200);
  return sessionOf(login);
}

async function approve(authorizeUrl: string) {
  return (await fetch(authorizeUrl, { redirect: 'manual' })).headers.get('location') ?? '';
}

describeWithDb('model-provider sign-in through the API', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
    issuer = await startFakeIssuer();
    answered = [];
  }, 15_000);

  afterEach(async () => {
    // Nothing the issuer handed out is in any answer or any table.
    const tables = await database().sql<{ name: string }[]>`
      select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const stored: string[] = [];
    for (const { name } of tables)
      stored.push(JSON.stringify(await database().sql`select * from ${database().sql(name)}`));
    const everything = [...answered, ...stored].join('\n');
    for (const token of issuer.issued) expect(everything).not.toContain(token);
    await issuer.stop();
  });

  afterAll(async () => {
    await handle?.close();
  });

  test('the owner signs in, reads the state and signs out; the provider revokes the grant', async () => {
    const api = app();
    const cookie = await owner(api);
    expect((await api.call('/model-providers/sign-in', cookie)).body).toEqual({
      providers: [
        {
          provider: 'chatgpt',
          state: 'signed_out',
          account: null,
          expires_at: null,
          reason: null,
          methods: ['device', 'browser'],
        },
      ],
    });
    const started = await api.call('/model-providers/chatgpt/sign-in', cookie, {
      method: 'POST',
      body: JSON.stringify({ method: 'browser' }),
    });
    expect(started.status).toBe(201);
    expect(started.body.redirect_uri).toBe('http://localhost:1455/auth/callback');
    const callback = await approve(started.body.authorize_url);
    const done = await api.call('/model-providers/chatgpt/sign-in/complete', cookie, {
      method: 'POST',
      body: JSON.stringify({ sign_in_id: started.body.sign_in_id, callback_url: callback }),
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'signed_in', account: 'owner@example.test' });
    const [row] = await database().sql`select * from provider_credential`;
    expect(row?.ciphertext).toStartWith('sealed-box-v1:');
    expect(row?.generation).toBe(1);

    const out = await api.call('/model-providers/chatgpt/sign-in', cookie, { method: 'DELETE' });
    expect(out.body.state).toBe('signed_out');
    expect(issuer.revoked).toHaveLength(1);
    expect(await database().sql`select * from provider_credential`).toHaveLength(0);
  });

  test('a device sign-in answers 202 until the code is entered', async () => {
    const api = app();
    const cookie = await owner(api);
    const started = await api.call('/model-providers/chatgpt/sign-in', cookie, {
      method: 'POST',
      body: '{}',
    });
    expect(started.body).toMatchObject({ method: 'device', user_code: 'ABCD-1234', interval: 1 });
    const complete = () =>
      api.call('/model-providers/chatgpt/sign-in/complete', cookie, {
        method: 'POST',
        body: JSON.stringify({ sign_in_id: started.body.sign_in_id }),
      });
    expect(await complete()).toEqual({ status: 202, body: { state: 'pending', interval: 1 } });
    issuer.approveDevice();
    await Bun.sleep(1100);
    expect((await complete()).body.state).toBe('signed_in');
  });

  test('a returned address with the wrong state is refused and finishes nothing', async () => {
    const api = app();
    const cookie = await owner(api);
    const started = await api.call('/model-providers/chatgpt/sign-in', cookie, {
      method: 'POST',
      body: JSON.stringify({ method: 'browser' }),
    });
    const forged = new URL(await approve(started.body.authorize_url));
    forged.searchParams.set('state', 'forged');
    const refused = await api.call('/model-providers/chatgpt/sign-in/complete', cookie, {
      method: 'POST',
      body: JSON.stringify({ sign_in_id: started.body.sign_in_id, callback_url: forged.href }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('state_mismatch');
    expect(await database().sql`select * from provider_credential`).toHaveLength(0);
  });

  test('only the setup owner manages sign-in, and only from the same origin', async () => {
    const api = app();
    const ownerCookie = await owner(api);
    const memberCookie = await member(api, ownerCookie);
    for (const [method, path, body] of [
      ['GET', '/model-providers/sign-in', undefined],
      ['GET', '/model-providers/chatgpt/sign-in', undefined],
      ['POST', '/model-providers/chatgpt/sign-in', '{}'],
      ['POST', '/model-providers/chatgpt/sign-in/complete', '{"sign_in_id":"x"}'],
      ['DELETE', '/model-providers/chatgpt/sign-in', undefined],
    ] as const) {
      const asMember = await api.call(path, memberCookie, { method, body });
      expect([path, asMember.status, asMember.body.error?.code]).toEqual([
        path,
        403,
        'owner_required',
      ]);
      expect((await api.call(path, '', { method, body })).status).toBe(401);
    }
    const crossSite = await api.call('/model-providers/chatgpt/sign-in', ownerCookie, {
      method: 'POST',
      body: '{}',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(crossSite.status).toBe(403);
    expect(crossSite.body.error.code).toBe('origin_rejected');
    expect(
      (await api.call('/model-providers/anthropic/sign-in', ownerCookie)).body.error.code,
    ).toBe('provider_not_available');
  });

  test('without a master key sign-in is unavailable', async () => {
    const api = app(false);
    const cookie = await owner(api);
    const refused = await api.call('/model-providers/sign-in', cookie);
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('sign_in_unavailable');
  });

  test('two services on one database refresh once, under the row lock', async () => {
    const api = app();
    const cookie = await owner(api);
    issuer.lifetime = 60;
    const started = await api.call('/model-providers/chatgpt/sign-in', cookie, {
      method: 'POST',
      body: JSON.stringify({ method: 'browser' }),
    });
    await api.call('/model-providers/chatgpt/sign-in/complete', cookie, {
      method: 'POST',
      body: JSON.stringify({
        sign_in_id: started.body.sign_in_id,
        callback_url: await approve(started.body.authorize_url),
      }),
    });
    issuer.refreshDelayMs = 100;
    // Past half of a sixty-second lifetime, both services must refresh.
    const later = Date.now() + 45_000;
    const service = () =>
      new ProviderSignIn({
        repository: new PostgresCredentialRepository(database().sql),
        issuers: { chatgpt: chatgptIssuer({ issuer: issuer.url }) },
        masterKey: () => masterKey,
        now: () => later,
        log: () => {},
      });
    const [first, second] = [service().credential('chatgpt'), service().credential('chatgpt')];
    const tokens = await Promise.all([first.current(), second.current(), first.current()]);
    expect(issuer.refreshCount).toBe(1);
    expect(new Set(tokens.map((token) => token.token)).size).toBe(1);
    const [row] = await database().sql`select generation, status from provider_credential`;
    expect(row).toEqual({ generation: 2, status: 'active' });
  });
});
