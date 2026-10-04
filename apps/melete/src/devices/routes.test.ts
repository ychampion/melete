import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { type LimitStore, MemoryLimitStore } from '../ops/limiter.ts';
import { mountDevices } from './routes.ts';
import type { DeviceService } from './service.ts';

const capabilities = {
  commands: true,
  files: true,
  open_url: true,
  screenshot: true,
  browser: true,
};
const pairing = {
  code: 'ABCD2345',
  name: 'Laptop',
  platform: 'linux',
  companion_version: 'test',
  capabilities,
  folders: [],
};

/** Counts tries as usual, but cannot give one back. */
function storeThatCannotGiveBack(): LimitStore {
  const inner = new MemoryLimitStore();
  let calls = 0;
  return {
    update(scope, key, now, step) {
      calls += 1;
      // The first update reserves the try; the next is the give-back.
      if (calls > 1) return Promise.reject(new Error('database unavailable'));
      return inner.update(scope, key, now, step);
    },
    clear: (scope, key) => inner.clear(scope, key),
  };
}

test('a pairing that succeeded answers with its token even when its guess cannot be given back', async () => {
  const app = new Hono();
  const devices = {
    pair: async () => ({ device_id: 'dev_1', token: 'shown-once', name: 'Laptop', capabilities }),
  } as unknown as DeviceService;
  mountDevices(app, devices, storeThatCannotGiveBack());
  const response = await app.request('/device/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pairing),
  });
  expect(response.status).toBe(201);
  expect(((await response.json()) as { token: string }).token).toBe('shown-once');
});

test('a pairing that failed reports its own failure when its guess cannot be given back', async () => {
  const app = new Hono();
  app.onError((error, c) => c.json({ message: error.message }, 500));
  const devices = {
    pair: async () => {
      throw new Error('the pairing table is locked');
    },
  } as unknown as DeviceService;
  mountDevices(app, devices, storeThatCannotGiveBack());
  const response = await app.request('/device/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pairing),
  });
  expect(((await response.json()) as { message: string }).message).toBe(
    'the pairing table is locked',
  );
});
