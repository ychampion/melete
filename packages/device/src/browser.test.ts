import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserBridge,
  EXTENSION_ID,
  encodeMessage,
  HOST_NAME,
  hostManifest,
  MessageReader,
} from './browser.ts';
import type { DeviceConfig } from './config.ts';

describe('native messaging framing', () => {
  test('messages survive being split and joined', () => {
    const one = encodeMessage({ type: 'answer', id: 'a', answer: { ok: true, result: {} } });
    const two = encodeMessage({ type: 'stop' });
    const both = Buffer.concat([one, two]);
    const reader = new MessageReader();
    expect(reader.push(both.subarray(0, 3))).toEqual([]);
    expect(reader.push(both.subarray(3, one.byteLength + 5))).toEqual([
      { type: 'answer', id: 'a', answer: { ok: true, result: {} } },
    ]);
    expect(reader.push(both.subarray(one.byteLength + 5))).toEqual([{ type: 'stop' }]);
  });

  test('an oversized length is refused rather than buffered', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(0xffffffff, 0);
    expect(() => new MessageReader().push(head)).toThrow();
  });

  test('the host manifest lets only the Melete extension start the bridge', () => {
    const manifest = hostManifest('/x/browser-host.sh');
    expect(manifest.name).toBe(HOST_NAME);
    expect(manifest.type).toBe('stdio');
    expect(manifest.allowed_origins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
  });

  test('the pinned key in the extension gives the pinned id', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'),
    ) as { key: string; permissions: string[] };
    const digest = new Bun.CryptoHasher('sha256')
      .update(Buffer.from(manifest.key, 'base64'))
      .digest('hex');
    const id = [...digest.slice(0, 32)]
      .map((c) => String.fromCharCode(97 + Number.parseInt(c, 16)))
      .join('');
    expect(id).toBe(EXTENSION_ID);
    // It may not read cookies at all.
    expect(manifest.permissions).not.toContain('cookies');
    expect(manifest.permissions).not.toContain('debugger');
  });
});

type Sent = { url: string; method: string; body: unknown };

function fakeMelete(requests: unknown[][]) {
  const sent: Sent[] = [];
  let polls = 0;
  const fetcher = async (url: string, init?: RequestInit) => {
    sent.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.includes('/device/requests?channel=browser')) {
      const batch = requests[polls++];
      if (!batch) {
        await new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('stop', 'AbortError')),
          );
          setTimeout(resolve, 5_000);
        });
        return Response.json({ requests: [] });
      }
      return Response.json({ requests: batch });
    }
    return Response.json({ status: 'ok' });
  };
  return { sent, fetcher };
}

const config = (browser: boolean): DeviceConfig => ({
  api: 'https://melete.test/api',
  device_id: 'dev_1',
  token: `mdt_${'a'.repeat(43)}`,
  name: 'Laptop',
  capabilities: { commands: false, files: true, open_url: true, screenshot: false, browser },
  folders: [],
});

describe('the browser bridge', () => {
  test('hands a request to the extension and posts its answer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'melete-bridge-'));
    const melete = fakeMelete([
      [
        {
          id: 'act_1',
          tool: 'browser_open',
          arguments: { url: 'https://example.com' },
          deadline: Date.now() + 10_000,
        },
      ],
    ]);
    const toExtension: { type: string; id?: string }[] = [];
    const bridge: BrowserBridge = new BrowserBridge({
      config: config(true),
      configDir: dir,
      fetch: melete.fetcher,
      resolve: async () => ['93.184.215.14'],
      send: (message) => {
        const value = message as { type: string; id?: string };
        toExtension.push(value);
        if (value.type === 'request')
          queueMicrotask(() =>
            bridge.receive({
              type: 'answer',
              id: value.id,
              answer: {
                ok: true,
                result: { tab_id: 7, url: 'https://example.com/', title: 'Example' },
              },
            }),
          );
      },
    });
    const running = bridge.run();
    for (let tries = 0; tries < 50 && !melete.sent.some((s) => s.url.includes('/result')); tries++)
      await Bun.sleep(20);
    bridge.stop();
    expect(await running).toBe('stopped');
    expect(toExtension[0]).toMatchObject({ type: 'status', state: 'connected' });
    expect(toExtension.find((m) => m.type === 'request')?.id).toBe('act_1');
    const posted = melete.sent.find((s) => s.url.endsWith('/device/requests/act_1/result'));
    expect(posted?.body).toEqual({
      ok: true,
      result: { tab_id: 7, url: 'https://example.com/', title: 'Example' },
    });
    // Leaving tells Melete at once, so nothing more waits on this browser.
    expect(melete.sent.at(-1)?.url).toEndWith('/device/browser/leave');
    expect(await readFile(join(dir, 'activity.log'), 'utf8')).toContain(
      '→ browser_open https://example.com',
    );
  });

  test('does nothing while the browser is off on this computer', async () => {
    const melete = fakeMelete([]);
    const toExtension: unknown[] = [];
    const bridge = new BrowserBridge({
      config: config(false),
      configDir: await mkdtemp(join(tmpdir(), 'melete-bridge-')),
      fetch: melete.fetcher,
      send: (message) => toExtension.push(message),
    });
    expect(await bridge.run()).toBe('off');
    expect(toExtension).toEqual([{ type: 'status', state: 'off', device: 'Laptop' }]);
    expect(melete.sent).toEqual([]);
  });

  test('refuses anything that is not browser work without asking the extension', async () => {
    const melete = fakeMelete([
      [
        {
          id: 'act_2',
          tool: 'run',
          arguments: { command: 'whoami' },
          deadline: Date.now() + 10_000,
        },
      ],
    ]);
    const toExtension: { type: string }[] = [];
    const bridge = new BrowserBridge({
      config: config(true),
      configDir: await mkdtemp(join(tmpdir(), 'melete-bridge-')),
      fetch: melete.fetcher,
      send: (message) => toExtension.push(message as { type: string }),
    });
    const running = bridge.run();
    for (let tries = 0; tries < 50 && !melete.sent.some((s) => s.url.includes('/result')); tries++)
      await Bun.sleep(20);
    bridge.stop();
    await running;
    expect(toExtension.some((m) => m.type === 'request')).toBe(false);
    expect(melete.sent.find((s) => s.url.includes('/act_2/result'))?.body).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
  });

  test('a page on this computer or its network reaches the browser only once approved', async () => {
    const request = (id: string, url: string, approved = false) => ({
      id,
      tool: 'browser_open',
      arguments: { url, ...(approved ? { local_approved: true } : {}) },
      deadline: Date.now() + 10_000,
    });
    const melete = fakeMelete([
      [
        request('act_3', 'http://192.168.1.1/'),
        request('act_4', 'https://rebind.example/'),
        request('act_5', 'http://192.168.1.1/', true),
      ],
    ]);
    const toExtension: { type: string; id?: string }[] = [];
    const bridge: BrowserBridge = new BrowserBridge({
      config: config(true),
      configDir: await mkdtemp(join(tmpdir(), 'melete-bridge-')),
      fetch: melete.fetcher,
      resolve: async (host) => (host === 'rebind.example' ? ['10.0.0.7'] : []),
      send: (message) => {
        const value = message as { type: string; id?: string };
        toExtension.push(value);
        if (value.type === 'request')
          queueMicrotask(() =>
            bridge.receive({
              type: 'answer',
              id: value.id,
              answer: {
                ok: true,
                result: { tab_id: 8, url: 'http://192.168.1.1/', title: 'Router' },
              },
            }),
          );
      },
    });
    const running = bridge.run();
    for (
      let tries = 0;
      tries < 100 && melete.sent.filter((s) => s.url.includes('/result')).length < 3;
      tries++
    )
      await Bun.sleep(20);
    bridge.stop();
    await running;
    expect(toExtension.filter((m) => m.type === 'request').map((m) => m.id)).toEqual(['act_5']);
    for (const id of ['act_3', 'act_4'])
      expect(melete.sent.find((s) => s.url.includes(`/${id}/result`))?.body).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
  });

  test('refuses to reach Melete on another computer over plain http', async () => {
    const melete = fakeMelete([]);
    const bridge = new BrowserBridge({
      config: { ...config(true), api: 'http://melete.example/api' },
      configDir: await mkdtemp(join(tmpdir(), 'melete-bridge-')),
      fetch: melete.fetcher,
      send: () => {},
    });
    expect(
      await bridge.run().then(
        () => 'ran',
        () => 'refused',
      ),
    ).toBe('refused');
    expect(melete.sent).toEqual([]);
  });
});
