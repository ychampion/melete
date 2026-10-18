/**
 * The feature registry: an operator's `MELETE_FEATURE_<NAME>` switch, a
 * person's own value that can only narrow it, and the gate that refuses a
 * feature's routes for one person.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { loadEnv } from './env.ts';
import {
  FEATURE_NAMES,
  FEATURES,
  featureEnvName,
  featureOfPath,
  installationFeatures,
  mountPersonFeatureGate,
  personFeatures,
} from './features.ts';

describe('installation features', () => {
  test('left unset, every feature keeps today’s default: all on but multiplayer', () => {
    for (const env of [undefined, {}, loadEnv({})])
      expect(installationFeatures(env)).toEqual({
        multiplayer: false,
        voice: true,
        phone: true,
        sms: true,
        browser: true,
        computer: true,
        companies: true,
      });
  });

  test('MELETE_FEATURE_<NAME> turns each feature on or off, parsed or raw', () => {
    for (const name of FEATURE_NAMES) {
      const key = featureEnvName(name);
      expect(installationFeatures({ [key]: 'off' })[name]).toBe(false);
      expect(installationFeatures({ [key]: 'on' })[name]).toBe(true);
      expect(installationFeatures(loadEnv({ [key]: 'off' }))[name]).toBe(false);
      expect(installationFeatures(loadEnv({ [key]: 'on' }))[name]).toBe(true);
    }
  });

  test('the multiplayer preview switch keeps working, and the feature switch wins over it', () => {
    expect(installationFeatures(loadEnv({ MELETE_PREVIEW_MULTIPLAYER: 'true' })).multiplayer).toBe(
      true,
    );
    expect(
      installationFeatures(
        loadEnv({ MELETE_PREVIEW_MULTIPLAYER: 'true', MELETE_FEATURE_MULTIPLAYER: 'off' }),
      ).multiplayer,
    ).toBe(false);
    expect(
      installationFeatures(
        loadEnv({ MELETE_PREVIEW_MULTIPLAYER: 'false', MELETE_FEATURE_MULTIPLAYER: 'on' }),
      ).multiplayer,
    ).toBe(true);
  });
});

describe('a person’s own features', () => {
  const installation = installationFeatures(loadEnv({ MELETE_FEATURE_SMS: 'off' }));

  test('a person’s value turns a feature off for them', () => {
    expect(personFeatures(installation, { voice: false }).voice).toBe(false);
    expect(personFeatures(installation, {}).voice).toBe(true);
  });

  test('a person’s value never exceeds the installation’s', () => {
    // SMS is off for the installation, multiplayer is off by default: neither comes on.
    const mine = personFeatures(installation, { sms: true, multiplayer: true });
    expect(mine.sms).toBe(false);
    expect(mine.multiplayer).toBe(false);
  });

  test('multiplayer is switched for the whole installation only', () => {
    const on = installationFeatures({ MELETE_FEATURE_MULTIPLAYER: 'on' });
    expect(FEATURES.multiplayer.perPerson).toBe(false);
    expect(personFeatures(on, { multiplayer: false }).multiplayer).toBe(true);
  });
});

describe('routes', () => {
  test('each feature’s routes belong to it, and others to none', () => {
    expect(featureOfPath('GET', '/voice')).toBe('voice');
    expect(featureOfPath('POST', '/conversations/cnv_1/voice/aside')).toBe('voice');
    expect(featureOfPath('POST', '/reach/number')).toBe('phone');
    expect(featureOfPath('POST', '/sms/twilio/conn_1')).toBe('sms');
    expect(featureOfPath('GET', '/connections/conn_1/texts')).toBe('sms');
    expect(featureOfPath('GET', '/browser/sites')).toBe('browser');
    expect(featureOfPath('POST', '/sandbox/sessions/s_1/live')).toBe('computer');
    expect(featureOfPath('GET', '/spaces/spc_1/companies')).toBe('companies');
    expect(featureOfPath('GET', '/rooms')).toBe('multiplayer');
    for (const path of ['/conversations', '/voiceless', '/reached', '/spaces/spc_1', '/me'])
      expect([path, featureOfPath('GET', path)]).toEqual([path, null]);
  });

  test('a feature turned off for one person is refused for them alone', async () => {
    const installation = installationFeatures({});
    const app = new Hono();
    app.use('*', async (c, next) => {
      const id = c.req.header('x-person');
      if (id) (c.set as (key: string, value: unknown) => void)('owner', { id });
      return next();
    });
    mountPersonFeatureGate(app, installation, async (principalId) =>
      principalId === 'prn_without_voice' ? { voice: false } : {},
    );
    app.get('/voice', (c) => c.json({ voice: true }));
    const without = await app.request('/voice', { headers: { 'x-person': 'prn_without_voice' } });
    expect(without.status).toBe(404);
    expect(await without.json()).toEqual({
      error: { code: 'not_available', message: 'Voice is turned off for your account.' },
    });
    const other = await app.request('/voice', { headers: { 'x-person': 'prn_other' } });
    expect(other.status).toBe(200);
  });
});

test('Compose hands every switch to the service, and the example lists each one empty', async () => {
  const root = new URL('../../../', import.meta.url);
  const compose = await Bun.file(new URL('deploy/docker-compose.yml', root)).text();
  const example = (await Bun.file(new URL('deploy/.env.example', root)).text()).split(/\r?\n/);
  for (const name of FEATURE_NAMES) {
    const key = featureEnvName(name);
    expect(compose).toContain(`${key}: \${${key}:-}`);
    expect(example).toContain(`${key}=`);
  }
});
