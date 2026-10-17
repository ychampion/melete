/**
 * A browser with no session asks whether the first account still needs to be
 * made, so a fresh install can offer "Create your account" and every other
 * install can offer sign-in. The answer needs no session and says only
 * whether an owner exists.
 */
import { describe, expect, test } from 'bun:test';
import { setupStatusResponse } from '@melete/contracts';
import { loadEnv } from '../env.ts';
import { type AppDeps, createApp } from '../index.ts';

/** A database whose owner table holds `owners` rows, and nothing else is read. */
function appWith(owners: { id: string }[], settings: Record<string, string> = {}) {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  // Queries answer with no rows: no setup code was ever issued here.
  const sql = new Proxy(async () => [], { get: () => () => undefined }) as never;
  const db = {
    select: () => ({ from: () => ({ limit: async () => owners }) }),
  } as unknown as AppDeps['db'];
  return createApp({
    env: loadEnv(settings),
    checkDatabase: async () => 'ok',
    db,
    sql,
    registry: stub,
    jobs: stub,
    triggers: stub,
    approvals: stub,
    events: stub,
    proposer: stub,
    evaluator: stub,
    browserSessions: stub,
    memory: stub,
    removals: stub,
  });
}

describe('GET /setup', () => {
  test('a fresh install needs its first account, and says so without a session', async () => {
    const response = await appWith([]).request('/setup');
    expect(response.status).toBe(200);
    expect(setupStatusResponse.parse(await response.json())).toEqual({
      needed: true,
      multiplayer: false,
      code_required: false,
      email_sign_in: false,
    });
  });

  test("the installation's terms, privacy and support links are given only when set", async () => {
    const ask = async (settings: Record<string, string>) =>
      setupStatusResponse.parse(await (await appWith([], settings).request('/setup')).json());
    const none = await ask({});
    expect(Object.keys(none)).not.toContain('terms_url');
    expect(Object.keys(none)).not.toContain('privacy_url');
    expect(Object.keys(none)).not.toContain('support_url');
    expect(
      await ask({
        MELETE_TERMS_URL: 'https://example.net/terms',
        MELETE_PRIVACY_URL: 'https://example.net/privacy',
        MELETE_SUPPORT_URL: 'mailto:help@example.net',
      }),
    ).toMatchObject({
      terms_url: 'https://example.net/terms',
      privacy_url: 'https://example.net/privacy',
      support_url: 'mailto:help@example.net',
    });
    // One alone is given alone; an empty setting is no setting.
    const one = await ask({
      MELETE_PRIVACY_URL: 'https://example.net/privacy',
      MELETE_TERMS_URL: '',
    });
    expect(one.privacy_url).toBe('https://example.net/privacy');
    expect(one.terms_url).toBeUndefined();
    // Signed-in installs answer the same.
    const installed = await appWith([{ id: 'own_01M2000000000000000000000A' }], {
      MELETE_SUPPORT_URL: 'https://example.net/help',
    }).request('/setup');
    expect(setupStatusResponse.parse(await installed.json()).support_url).toBe(
      'https://example.net/help',
    );
  });

  test('a terms or privacy link must be https, and support https or mailto', () => {
    for (const [name, value] of [
      ['MELETE_TERMS_URL', 'http://example.net/terms'],
      ['MELETE_PRIVACY_URL', 'javascript:alert(1)'],
      ['MELETE_SUPPORT_URL', 'ftp://example.net'],
      ['MELETE_SUPPORT_URL', 'not a link'],
    ] as const)
      expect(() => loadEnv({ [name]: value })).toThrow(name);
    expect(loadEnv({ MELETE_SUPPORT_URL: 'mailto:help@example.net' }).MELETE_SUPPORT_URL).toBe(
      'mailto:help@example.net',
    );
  });

  test('an installation made with a setup code says the first account needs it', async () => {
    const response = await appWith([], { MELETE_SETUP_CODE_HASH: 'a'.repeat(64) }).request(
      '/setup',
    );
    expect(setupStatusResponse.parse(await response.json())).toMatchObject({
      needed: true,
      code_required: true,
    });
  });

  test('at an address other machines reach, the first account needs a code unless opened', async () => {
    const exposed = { MELETE_PUBLIC_URL: 'https://melete.example.test' };
    const ask = async (settings: Record<string, string>) =>
      setupStatusResponse.parse(await (await appWith([], settings).request('/setup')).json());
    expect(await ask(exposed)).toMatchObject({ needed: true, code_required: true });
    expect(await ask({ MELETE_WEB_ORIGIN: 'https://melete.example.test' })).toMatchObject({
      code_required: true,
    });
    expect(await ask({ ...exposed, MELETE_SETUP_CODE_HASH: '' })).toMatchObject({
      code_required: true,
    });
    expect(await ask({ ...exposed, MELETE_SETUP_OPEN: 'true' })).toMatchObject({
      code_required: false,
    });
    expect(await ask({ MELETE_PUBLIC_URL: 'http://127.0.0.1:3101' })).toMatchObject({
      code_required: false,
    });
    // Once the owner exists, there is nothing to claim.
    const installed = await appWith([{ id: 'own_01M2000000000000000000000A' }], exposed).request(
      '/setup',
    );
    expect(await installed.json()).toMatchObject({ needed: false, code_required: false });
  });

  test('once an owner exists, setup is no longer needed', async () => {
    const response = await appWith([{ id: 'own_01M2000000000000000000000A' }]).request('/setup');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      needed: false,
      multiplayer: false,
      code_required: false,
      email_sign_in: false,
    });
  });

  test('without a database it says the service is not configured', async () => {
    const response = await createApp({
      env: loadEnv({}),
      db: null,
      checkDatabase: async () => 'ok',
    }).request('/setup');
    expect(response.status).toBe(503);
  });
});

describe('the multiplayer switch', () => {
  // Every route the switch covers, as a person, an invite link and a guest would call it.
  const covered: [string, string, unknown?][] = [
    ['GET', '/rooms'],
    ['POST', '/rooms', { name: 'Design' }],
    ['GET', '/rooms/spc_01M2000000000000000000000A'],
    ['POST', '/rooms/spc_01M2000000000000000000000A/invites', { email: 'a@example.com' }],
    ['POST', '/rooms/spc_01M2000000000000000000000A/threads', { text: 'hi' }],
    ['POST', '/invites/view', { token: 'x' }],
    ['POST', '/invites/accept', { token: 'x', password: 'a long password' }],
    ['GET', '/handoffs'],
    ['POST', '/handoffs/hof_01M2000000000000000000000A', { decision: 'accept' }],
    ['GET', '/me/linked-accounts'],
    ['DELETE', '/me/linked-accounts/slack/U1'],
    ['POST', '/spaces/shared', { name: 'Team' }],
    ['POST', '/spaces/spc_01M2000000000000000000000A/memberships', { principal_id: 'p' }],
  ];
  const send = (app: ReturnType<typeof appWith>, [method, path, body]: (typeof covered)[number]) =>
    app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });

  test('off by default: every covered route answers 404 not_available, and setup says so', async () => {
    const app = appWith([{ id: 'own_01M2000000000000000000000A' }]);
    expect(await (await app.request('/setup')).json()).toEqual({
      needed: false,
      multiplayer: false,
      code_required: false,
      email_sign_in: false,
    });
    for (const route of covered) {
      const response = await send(app, route);
      expect([route[1], response.status]).toEqual([route[1], 404]);
      expect(await response.json()).toEqual({
        error: {
          code: 'not_available',
          message: 'Rooms and shared spaces are not available on this server.',
        },
      });
    }
    // A single-player route is not covered: it asks for a session as before.
    expect((await app.request('/conversations')).status).toBe(401);
  });

  test('on: the covered routes reach sign-in as before, and setup says so', async () => {
    const app = appWith([{ id: 'own_01M2000000000000000000000A' }], {
      MELETE_PREVIEW_MULTIPLAYER: 'true',
    });
    expect(await (await app.request('/setup')).json()).toEqual({
      needed: false,
      multiplayer: true,
      code_required: false,
      email_sign_in: false,
    });
    for (const route of covered.filter(([, path]) => !path.startsWith('/invites/'))) {
      const response = await send(app, route);
      expect([route[1], response.status]).toEqual([route[1], 401]);
    }
  });
});
