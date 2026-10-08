/**
 * The bridge answers only the app's own frame, and only requests it can
 * check: a binding name, a declared-looking collection with a small record,
 * an https link, a clamped height. Everything else is ignored.
 */
import { describe, expect, test } from 'bun:test';
import {
  type BridgeHost,
  type BridgeReply,
  connectBridge,
  MAX_HEIGHT,
  MIN_HEIGHT,
  parseRequest,
} from './bridge.ts';

describe('a request from an app', () => {
  test('is read field by field, and anything else is not a request', () => {
    expect(parseRequest({ type: 'melete.data', id: 1, name: 'deals' })).toEqual({
      type: 'melete.data',
      id: 1,
      name: 'deals',
    });
    for (const bad of [
      null,
      'melete.data',
      [],
      { type: 'melete.data', id: 1, name: '../deals' },
      { type: 'melete.data', id: {}, name: 'deals' },
      { type: 'melete.data', name: 'deals' },
      { type: 'melete.fetch', id: 1, url: '/api/me' },
      { type: 'melete.submit', id: 1, collection: 'feedback', record: [1] },
      { type: 'melete.submit', id: 1, collection: 'feedback', record: { a: 'x'.repeat(17_000) } },
    ])
      expect(parseRequest(bad)).toBeNull();
  });

  test('opens only https links, and only those with no credentials in them', () => {
    expect(parseRequest({ type: 'melete.link', url: 'https://example.com/a' })).toEqual({
      type: 'melete.link',
      url: 'https://example.com/a',
    });
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'https://user:pw@example.com',
      '/api/me',
      `https://example.com/${'a'.repeat(3000)}`,
    ])
      expect(parseRequest({ type: 'melete.link', url })).toBeNull();
  });

  test('asks for a height between the bounds', () => {
    expect(parseRequest({ type: 'melete.size', height: 1e9 })).toEqual({
      type: 'melete.size',
      height: MAX_HEIGHT,
    });
    expect(parseRequest({ type: 'melete.size', height: -5 })).toEqual({
      type: 'melete.size',
      height: MIN_HEIGHT,
    });
    expect(parseRequest({ type: 'melete.size', height: Number.NaN })).toBeNull();
  });
});

describe('the bridge', () => {
  function harness() {
    const replies: BridgeReply[] = [];
    const appWindow = { postMessage: (message: BridgeReply) => replies.push(message) };
    const frame = { contentWindow: appWindow } as unknown as HTMLIFrameElement;
    const target = new EventTarget() as unknown as Window;
    const asked: string[] = [];
    const saved = new Map<string, Record<string, unknown>>();
    const host: BridgeHost = {
      data: async (name) => {
        asked.push(name);
        return name === 'deals'
          ? { ok: true, value: [{ name: 'Acme' }] }
          : { ok: false, error: 'No such data.' };
      },
      submit: async () => ({ ok: true, value: null }),
      save: async (collection, record) => {
        saved.set(collection, record);
        return { ok: true, value: null };
      },
      load: async (collection) => ({ ok: true, value: saved.get(collection) ?? null }),
      confirmLink: async () => false,
      resize: () => undefined,
    };
    const stop = connectBridge(() => frame, host, target);
    const send = (data: unknown, source: unknown = appWindow, origin = 'null') =>
      target.dispatchEvent(
        Object.assign(new Event('message'), { data, source, origin }) as unknown as Event,
      );
    return { replies, asked, send, stop };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("answers the app's frame with what the page fetched for this viewer", async () => {
    const { replies, send } = harness();
    send({ type: 'melete.data', id: 7, name: 'deals' });
    send({ type: 'melete.data', id: 8, name: 'missing' });
    await settle();
    expect(replies).toEqual([
      { type: 'melete.reply', id: 7, ok: true, value: [{ name: 'Acme' }] },
      { type: 'melete.reply', id: 8, ok: false, error: 'No such data.' },
    ]);
  });

  test('ignores a message from any other window, or from a page with an origin', async () => {
    const { replies, asked, send } = harness();
    send({ type: 'melete.data', id: 1, name: 'deals' }, {});
    send({ type: 'melete.data', id: 2, name: 'deals' }, undefined, 'http://localhost:3101');
    send({ type: 'melete.data', id: 3, name: 'deals' }, null);
    await settle();
    expect(asked).toEqual([]);
    expect(replies).toEqual([]);
  });

  test('what an app saves for its viewer comes back when it asks again', async () => {
    const { replies, send } = harness();
    send({ type: 'melete.load', id: 1, collection: 'state' });
    send({ type: 'melete.save', id: 2, collection: 'state', record: { water: [true, false] } });
    await settle();
    send({ type: 'melete.load', id: 3, collection: 'state' });
    // A malformed one is not answered at all.
    send({ type: 'melete.load', id: 4, collection: '../state' });
    send({ type: 'melete.save', id: 5, collection: 'state', record: [1, 2] });
    await settle();
    expect(replies).toEqual([
      { type: 'melete.reply', id: 1, ok: true, value: null },
      { type: 'melete.reply', id: 2, ok: true, value: null },
      { type: 'melete.reply', id: 3, ok: true, value: { water: [true, false] } },
    ]);
  });

  test('stops listening when it is closed', async () => {
    const { replies, send, stop } = harness();
    stop();
    send({ type: 'melete.data', id: 1, name: 'deals' });
    await settle();
    expect(replies).toEqual([]);
  });
});
