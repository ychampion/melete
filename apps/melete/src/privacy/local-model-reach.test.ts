import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ServiceError } from '../api/errors.ts';
import { isLocalUrl, type LocalModel, pinLocalModel } from './local.ts';
import { PrivacyRouter } from './router.ts';
import { mountPrivacy } from './routes.ts';
import { MemoryPrivacyStore } from './store.ts';

const SPACE = 'sp_01J00000000000000000000000';
const PERSON = 'own_01J0000000000000000000000P';

/** What the test's names answer, so no lookup leaves the machine. */
const NAMES: Record<string, { address: string }[]> = {
  'models.inside.test': [{ address: '10.0.0.7' }],
  'metadata.inside.test': [{ address: '169.254.169.254' }],
  'mapped.inside.test': [{ address: '::ffff:a9fe:a9fe' }],
  'mixed.inside.test': [{ address: '10.0.0.7' }, { address: '169.254.169.254' }],
  'public.example.test': [{ address: '93.184.216.34' }],
};
const resolve = async (host: string) => {
  const found = NAMES[host];
  if (!found) throw new Error(`ENOTFOUND ${host}`);
  return found;
};

/** Every spelling of an address inside the server's network a person might try. */
const INSIDE = [
  'http://169.254.169.254/v1',
  'http://2852039166/v1',
  'http://0251.0376.0251.0376/v1',
  'http://0xa9fea9fe/v1',
  'http://169.254.169.254./v1',
  'http://[::ffff:169.254.169.254]/v1',
  'http://[::ffff:a9fe:a9fe]/v1',
  'http://[fd00:ec2::254]/v1',
  'http://100.100.100.200/v1',
  'http://127.0.0.1:11434/v1',
  'http://017700000001:11434/v1',
  'http://127.1:11434/v1',
  'http://localhost:11434/v1',
  'http://[::1]:11434/v1',
  'http://[::ffff:127.0.0.1]:11434/v1',
  'http://10.0.0.5:8000/v1',
  'http://172.16.0.3/v1',
  'http://192.168.1.10/v1',
  'http://169.254.10.10/v1',
  'http://[fe80::1]/v1',
  'http://[fd12:3456::1]/v1',
  'http://models.inside.test/v1',
  'http://metadata.inside.test/v1',
  'http://mapped.inside.test/v1',
  'http://mixed.inside.test/v1',
];

/** Cloud metadata in every spelling: refused even to the installation's owner. */
const METADATA = [
  'http://169.254.169.254/v1',
  'http://2852039166/v1',
  'http://0251.0376.0251.0376/v1',
  'http://0xa9fea9fe/v1',
  'http://[::ffff:169.254.169.254]/v1',
  'http://[::ffff:a9fe:a9fe]/v1',
  'http://[fd00:ec2::254]/v1',
  'http://metadata.inside.test/v1',
  'http://mapped.inside.test/v1',
  'http://mixed.inside.test/v1',
];

const OPERATOR: LocalModel = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'operator-llama' };

/**
 * Settings → Privacy for someone who owns their own space. `installation` says
 * whether that space is the installation owner's, which is what decides whether
 * a free-form address inside the server's network is theirs to name.
 */
function harness(installation: boolean, fallbackLocal: LocalModel | null = null) {
  const store = new MemoryPrivacyStore({ installation });
  const sent: string[] = [];
  const router = new PrivacyRouter({
    store,
    fallbackLocal,
    resolve,
    cacheMs: 0,
    fetch: async (request) => {
      sent.push(request.url);
      return Response.json({ data: [{ id: 'llama' }, { id: 'operator-llama' }] });
    },
  });
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'internal_error', message: String(error) } }, 500),
  );
  app.use(async (c, next) => {
    c.set('experienceSpaceId', SPACE);
    c.set('sessionSpace', { spaceId: SPACE, kind: 'personal', role: 'owner' } as never);
    c.set('owner', { id: PERSON, email: 'person@example.test', created_at: '' });
    await next();
  });
  mountPrivacy(app, { router: () => router });
  const send = (method: string, path: string, body: unknown) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    app,
    store,
    router,
    sent,
    save: (base_url: string) =>
      send('PUT', '/privacy/settings', { local_model: { base_url, model: 'llama' } }),
    check: (body: Record<string, unknown>) => send('POST', '/privacy/local-model/check', body),
  };
}

describe('a local model named by someone who does not run the installation', () => {
  test('is refused at every inside address, however it is written, and nothing is sent', async () => {
    const h = harness(false);
    for (const address of INSIDE) {
      const saved = await h.save(address);
      expect([address, saved.status]).toEqual([address, 403]);
      expect(await saved.json()).toMatchObject({
        error: {
          code: 'address_not_reachable',
          message: expect.stringContaining('This address isn’t reachable from Melete’s servers'),
        },
      });
      const checked = await h.check({ base_url: address, model: 'llama' });
      expect([address, checked.status]).toEqual([address, 403]);
    }
    expect(h.sent).toEqual([]);
    expect((await h.store.settings(SPACE)).plain.local_model).toBeUndefined();
  });

  test('a public address is refused too: a local model is the operator’s to configure', async () => {
    const h = harness(false);
    expect((await h.save('http://public.example.test/v1')).status).toBe(403);
    expect(h.sent).toEqual([]);
  });

  test('a row saved before this rule is never used; the operator’s local model is', async () => {
    const h = harness(false, OPERATOR);
    await h.store.saveSettings(
      SPACE,
      { local_model: { base_url: 'http://169.254.169.254/v1', model: 'planted' } },
      { known: [], local_api_key: 'planted-key' },
    );
    const settings = await h.router.settingsFor(SPACE);
    expect(settings.local).toEqual(OPERATOR);
    // The check reaches the operator's model, never the planted address.
    const checked = await h.check({});
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ ok: true });
    expect(h.sent).toEqual(['http://127.0.0.1:11434/v1/models']);
  });

  test('may still turn the local model off, which names no address', async () => {
    const h = harness(false, OPERATOR);
    const response = await h.app.request('/privacy/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ local_model: null }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ local_model: null });
    expect(h.sent).toEqual([]);
  });
});

describe('the installation owner’s own local model', () => {
  test('may sit on this machine or the owner’s network, and is reached there', async () => {
    const h = harness(true);
    for (const address of [
      'http://127.0.0.1:11434/v1',
      'http://localhost:11434/v1',
      'http://[::1]:11434/v1',
      'http://10.0.0.5:8000/v1',
      'http://169.254.10.10/v1',
      'http://models.inside.test/v1',
    ]) {
      const saved = await h.save(address);
      expect([address, saved.status]).toEqual([address, 200]);
      expect(await saved.json()).toMatchObject({
        local_model: { base_url: address, model: 'llama' },
      });
    }
    const checked = await h.check({});
    expect(await checked.json()).toMatchObject({ ok: true });
    expect(h.sent).toEqual(['http://models.inside.test/v1/models']);
    // The model is pinned to the checked address for each request.
    const saved = (await h.router.settingsFor(SPACE)).local;
    if (!saved) throw new Error('expected the saved local model');
    const local = await pinLocalModel(saved, resolve);
    expect(local).toMatchObject({ baseUrl: 'http://10.0.0.7/v1', host: 'models.inside.test' });
  });

  test('is still refused cloud metadata, in every spelling', async () => {
    const h = harness(true);
    for (const address of METADATA) {
      const saved = await h.save(address);
      expect([address, saved.status]).toEqual([address, 400]);
      expect(await saved.json()).toMatchObject({
        error: {
          code: 'address_not_reachable',
          message: expect.stringContaining('This address isn’t reachable from Melete’s servers'),
        },
      });
      const checked = await h.check({ base_url: address, model: 'llama' });
      expect(await checked.json()).toMatchObject({ ok: false });
    }
    expect(h.sent).toEqual([]);
  });
});

describe('the local-address check itself', () => {
  test('never counts cloud metadata as local, unless the operator allows it', async () => {
    for (const address of METADATA) {
      expect([address, await isLocalUrl(address, resolve)]).toEqual([address, false]);
      expect(await pinLocalModel({ baseUrl: address, model: 'm' }, resolve)).toBeNull();
    }
    expect(await isLocalUrl('http://169.254.169.254/v1', resolve, { allowMetadata: true })).toBe(
      true,
    );
    expect(
      await pinLocalModel({ baseUrl: 'http://metadata.inside.test/v1', model: 'm' }, resolve, {
        allowMetadata: true,
      }),
    ).toMatchObject({ baseUrl: 'http://169.254.169.254/v1' });
  });
});
