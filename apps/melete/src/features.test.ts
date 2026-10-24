/**
 * The feature registry: an operator's `MELETE_FEATURE_<NAME>` switch, a
 * person's own value that can only narrow it, and the gate that refuses a
 * feature's routes for one person.
 */
import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { builtinEnvironment } from './connectors/builtin.ts';
import { ConnectorFactory } from './connectors/configured.ts';
import { loadEnv } from './env.ts';
import {
  FEATURE_NAMES,
  FEATURES,
  featureEnvName,
  featureOfConnectionKind,
  featureOfPath,
  installationFeatures,
  mountFeatureGate,
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
    expect(featureOfPath('GET', '/sign-ins')).toBe('browser');
    expect(featureOfPath('POST', '/sign-ins/ssi_1/code')).toBe('browser');
    expect(featureOfPath('POST', '/sandbox/sessions/s_1/live')).toBe('computer');
    expect(featureOfPath('POST', '/sandbox/processes/prc_1/stop')).toBe('computer');
    expect(featureOfPath('GET', '/previews/tok_1/index.html')).toBe('computer');
    expect(featureOfPath('GET', '/conversations/cnv_1/computer')).toBe('computer');
    // A call, as its routes are named once it lands.
    expect(featureOfPath('POST', '/conversations/cnv_1/call')).toBe('voice');
    expect(featureOfPath('GET', '/voice/call/upstream')).toBe('voice');
    expect(featureOfPath('GET', '/spaces/spc_1/companies')).toBe('companies');
    expect(featureOfPath('GET', '/rooms')).toBe('multiplayer');
    for (const path of [
      '/conversations',
      '/voiceless',
      '/reached',
      '/spaces/spc_1',
      '/me',
      '/sandboxes',
      '/sign-ins-extra',
      '/conversations/cnv_1/callers',
      '/conversations/cnv_1/computers',
    ])
      expect([path, featureOfPath('GET', path)]).toEqual([path, null]);
  });

  test('saved sign-ins refuse browser-off requests before reaching their handlers', async () => {
    for (const perPerson of [false, true]) {
      const installation = installationFeatures(perPerson ? {} : { MELETE_FEATURE_BROWSER: 'off' });
      const app = new Hono();
      mountFeatureGate(app, installation);
      app.use('*', async (c, next) => {
        (c.set as (key: string, value: unknown) => void)('owner', {
          id: c.req.header('x-person') ?? 'prn_without_browser',
        });
        return next();
      });
      mountPersonFeatureGate(app, installation, async (id) =>
        id === 'prn_without_browser' ? { browser: false } : {},
      );
      let reached = 0;
      app.all('*', (c) => {
        reached += 1;
        return c.json({ reached: true });
      });
      for (const [method, path] of [
        ['GET', '/sign-ins'],
        ['POST', '/sign-ins'],
        ['PATCH', '/sign-ins/ssi_1'],
        ['DELETE', '/sign-ins/ssi_1'],
        ['POST', '/sign-ins/ssi_1/code'],
        ['POST', '/sign-ins/ssi_1/check'],
      ] as const) {
        const response = await app.request(path, { method });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({
          error: {
            code: 'not_available',
            message: perPerson ? FEATURES.browser.offForYou : FEATURES.browser.off,
          },
        });
      }
      expect(reached).toBe(0);
      const other = await app.request('/sign-ins', { headers: { 'x-person': 'prn_other' } });
      expect(other.status).toBe(perPerson ? 200 : 404);
    }
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

describe('the agent’s tools follow the switches', () => {
  const browserRow = {
    id: 'conn_01M2000000000000000000000B',
    spaceId: 'spc_01M2000000000000000000000A',
    provider: 'web',
    secretRef: null,
    configuration: null,
  };
  const smsRow = {
    id: 'conn_01M2000000000000000000000S',
    spaceId: 'spc_01M2000000000000000000000A',
    provider: 'twilio',
    secretRef: 'sec_01M2000000000000000000000S',
    configuration: { kind: 'sms', sms: { allowed_numbers: [] } },
  };
  const sandboxRow = {
    id: 'conn_01M2000000000000000000000X',
    spaceId: 'spc_01M2000000000000000000000A',
    provider: 'sandbox',
    secretRef: 'sec_01M2000000000000000000000X',
    configuration: {
      kind: 'sandbox',
      sandbox: {
        adapter: 'e2b',
        image: 'base',
        egress: 'deny_all',
        persistence: 'ephemeral',
        lifetime_seconds: 600,
      },
    },
  };
  const factory = (env: Record<string, string>) =>
    new ConnectorFactory({
      sql: {} as Sql,
      workRoot: '/tmp/work',
      spacesRoot: '/tmp/spaces',
      env,
      // The operator's own file names the browser connection.
      connections: [{ kind: 'browser', id: browserRow.id }],
      sandbox: {
        sessions: {} as never,
        project: 'test',
        e2bPlan: 'hobby',
        snapshotTtlSeconds: 3600,
        maxConcurrent: 1,
        maxPerConnection: 1,
        modalRefusal: null,
      },
    });
  const tools = async (made: ConnectorFactory, row: Parameters<ConnectorFactory['open']>[0]) =>
    (await made.open(row))?.manifest.tools.map((tool) => tool.name) ?? [];

  test('browser off: the operator’s browser connection opens to nothing instead of stopping the start', async () => {
    // Started with the browser off, the service has no browser sessions at all.
    expect(await factory({ MELETE_FEATURE_BROWSER: 'off' }).open(browserRow)).toBeUndefined();
  });

  test('texting off: a texting connection offers no tool, so the agent sends no text', async () => {
    expect(await tools(factory({}), smsRow)).toContain('sms.send');
    expect(await factory({ MELETE_FEATURE_SMS: 'off' }).open(smsRow)).toBeUndefined();
  });

  test('computer off: the agent has no computer, and its sandboxes can still be stopped', async () => {
    expect(await tools(factory({}), sandboxRow)).toContain('terminal.run');
    const off = factory({ MELETE_FEATURE_COMPUTER: 'off' });
    expect(await off.open(sandboxRow)).toBeUndefined();
    // The sweep and a removal still reach the provider to stop what is running.
    expect(off.sandboxProviders.has(sandboxRow.id)).toBe(true);
  });

  test('computer off: no space is given the default computer', () => {
    const env = {
      MELETE_RUNTIME_ADAPTER: 'docker',
      MELETE_RUNTIME_SUPERVISOR: 'none',
      MELETE_SANDBOX_PROVIDER: 'docker',
      MELETE_SANDBOX_PROJECT: 'test',
    };
    expect(builtinEnvironment(env as never).sandbox).not.toBeNull();
    expect(
      builtinEnvironment({ ...env, MELETE_FEATURE_COMPUTER: 'off' } as never).sandbox,
    ).toBeNull();
  });
});

describe('connection kinds follow the switches', () => {
  test('texting and the computer are the features of their kinds; others belong to none', () => {
    expect(featureOfConnectionKind('sms')).toBe('sms');
    expect(featureOfConnectionKind('sandbox')).toBe('computer');
    for (const kind of ['mail', 'caldav', 'ics', 'mcp', 'mcp_stdio', 'command_line'])
      expect([kind, featureOfConnectionKind(kind)]).toEqual([kind, null]);
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
