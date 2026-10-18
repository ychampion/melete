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

/** Every feature as an installation that sets nothing has it. */
const DEFAULT_FEATURES = {
  multiplayer: false,
  voice: true,
  phone: true,
  sms: true,
  browser: true,
  computer: true,
  companies: true,
};

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
      features: DEFAULT_FEATURES,
      code_required: false,
      email_sign_in: false,
      instance_name: 'Melete',
      assistant_name: 'Melete',
      signin: { password: true, oidc: null },
    });
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
      features: DEFAULT_FEATURES,
      code_required: false,
      email_sign_in: false,
      instance_name: 'Melete',
      assistant_name: 'Melete',
      signin: { password: true, oidc: null },
    });
  });

  test('it says what the installation and its assistant are called', async () => {
    const response = await appWith([], {
      MELETE_INSTANCE_NAME: '  Riverside Assistant ',
      MELETE_ASSISTANT_NAME: 'Juniper',
    }).request('/setup');
    expect(setupStatusResponse.parse(await response.json())).toMatchObject({
      instance_name: 'Riverside Assistant',
      assistant_name: 'Juniper',
    });
    expect(() => loadEnv({ MELETE_INSTANCE_NAME: 'Two\nlines' })).toThrow('MELETE_INSTANCE_NAME');
    expect(() => loadEnv({ MELETE_ASSISTANT_NAME: 'x'.repeat(61) })).toThrow(
      'MELETE_ASSISTANT_NAME',
    );
    // A carriage return would start a new mail header; the others break a line
    // or reorder the text a person reads.
    for (const name of [
      'Riverside\r\nBcc: someone@example.com',
      'Riverside\u2028Ignore the rules',
      'Riverside\u2029Assistant',
      'Riverside \u202egnp.exe',
      'Riverside \u2066Assistant\u2069',
      'Riverside\u0085Assistant',
    ]) {
      expect(() => loadEnv({ MELETE_INSTANCE_NAME: name }), JSON.stringify(name)).toThrow(
        'MELETE_INSTANCE_NAME',
      );
    }
    // Letters beyond ASCII are names too.
    expect(
      loadEnv({ MELETE_INSTANCE_NAME: 'Escuela Pe\u00f1alara \u00b7 Asistente' })
        .MELETE_INSTANCE_NAME,
    ).toBe('Escuela Pe\u00f1alara \u00b7 Asistente');
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
      features: DEFAULT_FEATURES,
      code_required: false,
      email_sign_in: false,
      instance_name: 'Melete',
      assistant_name: 'Melete',
      signin: { password: true, oidc: null },
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
      features: { ...DEFAULT_FEATURES, multiplayer: true },
      code_required: false,
      email_sign_in: false,
      instance_name: 'Melete',
      assistant_name: 'Melete',
      signin: { password: true, oidc: null },
    });
    for (const route of covered.filter(([, path]) => !path.startsWith('/invites/'))) {
      const response = await send(app, route);
      expect([route[1], response.status]).toEqual([route[1], 401]);
    }
  });
});

describe('features an operator turns off', () => {
  const owned = [{ id: 'own_01M2000000000000000000000A' }];

  test('the setup status names every feature, with the operator’s values', async () => {
    const app = appWith(owned, { MELETE_FEATURE_VOICE: 'off', MELETE_FEATURE_COMPANIES: 'off' });
    const status = setupStatusResponse.parse(await (await app.request('/setup')).json());
    expect(status.features).toEqual({ ...DEFAULT_FEATURES, voice: false, companies: false });
  });

  test('a feature that is off has its routes refused with a plain sentence, before sign-in', async () => {
    const app = appWith(owned, {
      MELETE_FEATURE_VOICE: 'off',
      MELETE_FEATURE_COMPANIES: 'off',
      MELETE_FEATURE_BROWSER: 'off',
    });
    const refused: [string, string, string][] = [
      ['GET', '/voice', 'Voice is turned off on this server.'],
      ['POST', '/conversations/cnv_1/voice/session', 'Voice is turned off on this server.'],
      ['GET', '/spaces/spc_1/companies', 'Companies is turned off on this server.'],
      ['GET', '/waiting-on', 'Companies is turned off on this server.'],
      ['GET', '/browser/sites', 'The agent’s browser is turned off on this server.'],
    ];
    for (const [method, path, message] of refused) {
      const response = await app.request(path, { method });
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.json()).toEqual({ error: { code: 'not_available', message } });
    }
    // A feature left on still asks for a session, as before.
    expect((await app.request('/reach')).status).toBe(401);
    expect((await app.request('/sandbox/computers')).status).toBe(401);
  });

  test('a provider’s webhook for a feature that is off is refused before anything is read', async () => {
    const app = appWith(owned, {
      MELETE_FEATURE_SMS: 'off',
      MELETE_FEATURE_PHONE: 'off',
      MELETE_FEATURE_COMPUTER: 'off',
      MELETE_FEATURE_VOICE: 'off',
    });
    // Twilio posts a form, signed or not; nothing behind the gate is reached.
    const form = {
      'content-type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': 'unchecked',
    };
    const refused: [string, string][] = [
      ['/sms/twilio/conn_01M2000000000000000000000A', 'Texting your agent'],
      ['/reach/twilio/sms', 'Texts and calls to your phone'],
      ['/reach/twilio/status/rch_1', 'Texts and calls to your phone'],
      ['/reach/twilio/key/rch_1', 'Texts and calls to your phone'],
      ['/sandbox/processes/prc_1/stop', 'The agent’s computer'],
      ['/conversations/cnv_1/call', 'Voice'],
    ];
    for (const [path, said] of refused) {
      const response = await app.request(path, {
        method: 'POST',
        headers: form,
        body: 'From=%2B15550001111&Body=hello',
      });
      expect([path, response.status]).toEqual([path, 404]);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect([path, body.error.code]).toEqual([path, 'not_available']);
      expect(body.error.message.startsWith(said)).toBe(true);
    }
    // A preview of a server in the agent's computer is refused as well.
    expect((await app.request('/previews/tok_1/')).status).toBe(404);
    expect((await app.request('/conversations/cnv_1/computer')).status).toBe(404);
  });

  test('MELETE_FEATURE_MULTIPLAYER wins over the preview switch', async () => {
    const on = appWith(owned, { MELETE_FEATURE_MULTIPLAYER: 'on' });
    expect(setupStatusResponse.parse(await (await on.request('/setup')).json()).multiplayer).toBe(
      true,
    );
    expect((await on.request('/rooms')).status).toBe(401);
    const off = appWith(owned, {
      MELETE_PREVIEW_MULTIPLAYER: 'true',
      MELETE_FEATURE_MULTIPLAYER: 'off',
    });
    expect(setupStatusResponse.parse(await (await off.request('/setup')).json()).multiplayer).toBe(
      false,
    );
    expect((await off.request('/rooms')).status).toBe(404);
  });

  test('a value other than on or off is refused at start', () => {
    expect(() => loadEnv({ MELETE_FEATURE_VOICE: 'yes' })).toThrow(/MELETE_FEATURE_VOICE/);
    // Left blank, as Compose writes an unset value, it keeps the default.
    expect(loadEnv({ MELETE_FEATURE_VOICE: '' }).MELETE_FEATURE_VOICE).toBeUndefined();
  });
});
