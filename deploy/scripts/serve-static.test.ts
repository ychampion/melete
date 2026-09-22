/**
 * The file server is only allowed to read the bundle it was pointed at.
 *
 * Two layers, because either alone would prove less than it looks. The unit
 * tests exercise the guard directly, since `fetch` and `new URL` collapse dot
 * segments before a server ever sees them and would quietly pass a server that
 * had no guard at all. The HTTP tests write the request line onto a socket
 * themselves, which is the only way to send what an attacker actually sends.
 *
 * The invariant every hostile case asserts is the same one: a file outside the
 * bundle never reaches the response body.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CLIENT_ADDRESS_HEADER as API_CLIENT_ADDRESS_HEADER } from '../../apps/melete/src/api/listener.ts';
import { CLIENT_ADDRESS_HEADER, createStaticServer, resolveInside } from './serve-static.ts';

/** Appears only in files outside the bundle. Any response carrying it is a leak. */
const SENTINEL = 'melete-outside-the-bundle-4f9c2a';
const INDEX_HTML = '<!doctype html><title>Melete</title><div id="root"></div>';
const ASSET_JS = 'export const ok = true;\n';

let base = '';
let server: ReturnType<typeof createStaticServer> | null = null;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'melete-serve-'));
  // Two decoys beside the bundle, which is where a climb of one level lands.
  await writeFile(join(base, 'package.json'), `{"name":"${SENTINEL}"}`, 'utf8');
  await writeFile(join(base, 'secret.txt'), SENTINEL, 'utf8');
  await mkdir(join(base, 'dist', 'assets'), { recursive: true });
  await writeFile(join(base, 'dist', 'index.html'), INDEX_HTML, 'utf8');
  await writeFile(join(base, 'dist', 'assets', 'app.js'), ASSET_JS, 'utf8');

  server = createStaticServer({ root: join(base, 'dist'), port: 0, hostname: '127.0.0.1' });
});

afterAll(async () => {
  server?.stop(true);
  if (base) await rm(base, { recursive: true, force: true });
});

type RawResponse = { status: number; body: string };

/**
 * Send a request line verbatim. `fetch` would normalise `/../` and `%2e%2e`
 * out of the path first, so it cannot test what this server is guarding.
 */
const raw = (path: string): Promise<RawResponse> =>
  new Promise((settle, fail) => {
    const port = server?.port;
    if (!port) {
      fail(new Error('the server is not listening'));
      return;
    }
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let text = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      fail(new Error(`no answer for ${path}`));
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    socket.on('error', fail);
    socket.on('end', () => {
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const body = split === -1 ? '' : text.slice(split + 4);
      settle({ status: Number(head.split(' ')[1] ?? 0), body });
    });
  });

/** Resolved late, because the port is only known once the server is listening. */
const origin = () => `http://127.0.0.1:${server?.port}`;

/** Refused, or handed the client's own index. Never anything from outside. */
const expectConfined = (response: RawResponse, path: string) => {
  expect(response.body, `${path} leaked a file from outside the bundle`).not.toContain(SENTINEL);
  const refused = response.status === 404;
  const servedIndex = response.status === 200 && response.body.includes('id="root"');
  expect(
    refused || servedIndex,
    `${path} answered ${response.status} with unexpected content`,
  ).toBe(true);
};

describe('resolveInside', () => {
  const root = resolve(sep === '\\' ? 'C:\\app\\dist' : '/app/dist');
  const inside = (relative: string) => resolve(root, relative);

  test('accepts a file in the bundle', () => {
    expect(resolveInside(root, '/assets/app.js')).toBe(inside('assets/app.js'));
  });

  test('accepts the bundle root itself', () => {
    expect(resolveInside(root, '/')).toBe(root);
  });

  test('percent-encoded dot segments do not climb out', () => {
    for (const pathname of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/%2E%2E%2Fpackage.json',
      '/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/assets/../../package.json',
    ]) {
      expect(resolveInside(root, pathname), pathname).toBeNull();
    }
  });

  test('a backslash is a separator on Windows, so it is refused everywhere', () => {
    for (const pathname of ['/..%5cpackage.json', '/%2e%2e%5cpackage.json', '/a%5cb']) {
      expect(resolveInside(root, pathname), pathname).toBeNull();
    }
  });

  test('a colon opens a drive letter and a URL scheme, so it is refused', () => {
    for (const pathname of [
      '/C:/Windows/win.ini',
      '/file:///etc/passwd',
      '/http://example.com/x',
      '/%43%3a/Windows/win.ini',
    ]) {
      expect(resolveInside(root, pathname), pathname).toBeNull();
    }
  });

  test('an absolute-looking path is still resolved inside the bundle', () => {
    expect(resolveInside(root, '//etc/passwd')).toBe(inside('etc/passwd'));
    expect(resolveInside(root, '/etc/passwd')).toBe(inside('etc/passwd'));
  });

  test('a NUL byte is refused, because the kernel would read a shorter name', () => {
    expect(resolveInside(root, '/app.js%00.txt')).toBeNull();
  });

  test('a malformed percent sequence is refused rather than guessed at', () => {
    expect(resolveInside(root, '/%zz')).toBeNull();
    expect(resolveInside(root, '/%')).toBeNull();
  });

  test('a sibling directory sharing the prefix is not inside it', () => {
    // `dist-backup` starts with `dist`, which is why the check ends at a separator.
    expect(resolveInside(root, '/../dist-backup/secret.txt')).toBeNull();
  });
});

describe('the server over a socket', () => {
  test('serves the index at the root', async () => {
    const response = await raw('/');
    expect(response.status).toBe(200);
    expect(response.body).toContain('id="root"');
  });

  test('serves an asset out of the bundle', async () => {
    const response = await raw('/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.body).toContain('export const ok = true;');
  });

  test('falls back to the index for a deep link with no file behind it', async () => {
    const response = await raw('/jobs/job_01J');
    expect(response.status).toBe(200);
    expect(response.body).toContain('id="root"');
  });

  test('one connection serves several requests in turn, then closes when asked', async () => {
    // The web container sits behind a browser that reuses connections. A server
    // that answered only the first request per socket, or never closed one it
    // was asked to close, would look fine in a single fetch and fail in production.
    const port = server?.port;
    if (!port) throw new Error('the server is not listening');
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((ready) => socket.once('connect', ready));
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
    });
    const ended = new Promise<void>((settle, fail) => {
      socket.on('end', settle);
      socket.on('error', fail);
      socket.setTimeout(5000, () => fail(new Error('the server did not close the connection')));
    });
    const CRLF = '\r\n';
    const request = (path: string, close = false) =>
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          'Host: 127.0.0.1',
          ...(close ? ['Connection: close'] : []),
          '',
          '',
        ].join(CRLF),
      );
    const responses = () => text.split('HTTP/1.1 ').length - 1;
    const until = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (responses() < count && Date.now() < deadline) await Bun.sleep(10);
      expect(responses(), `after ${count} request(s)`).toBe(count);
    };
    request('/assets/app.js');
    await until(1);
    request('/jobs/job_01J');
    await until(2);
    request('/missing/%2e%2e/secret.txt', true);
    await ended;
    expect(responses()).toBe(3);
    expect(text).toContain('export const ok = true;');
    expect(text).toContain('id="root"');
    expect(text).not.toContain(SENTINEL);
  });

  test('reads an asset with HEAD, headers only', async () => {
    const response = await fetch(`${origin()}/assets/app.js`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  test('answers a write verb with 405 and says what it allows', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${origin()}/assets/app.js`, { method });
      expect(response.status, `${method} on an asset`).toBe(405);
      expect(response.headers.get('allow'), `${method} allow header`).toBe('GET, HEAD');
      expect(await response.text()).not.toContain('export const ok = true;');
    }
  });

  test('a write verb cannot reach outside the bundle either', async () => {
    const response = await fetch(`${origin()}/../secret.txt`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(await response.text()).not.toContain(SENTINEL);
  });

  test('never answers a traversal with a file from outside the bundle', async () => {
    for (const path of [
      '/../package.json',
      '/../secret.txt',
      '/%2e%2e/package.json',
      '/%2E%2E%2Fpackage.json',
      '/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/C:/Windows/win.ini',
      '/file:///etc/passwd',
      '//etc/passwd',
      '/..%5cpackage.json',
      '/%2e%2e%5cpackage.json',
      '/assets/../../secret.txt',
      '/app.js%00.txt',
      '/%00',
      '/%zz',
    ]) {
      expectConfined(await raw(path), path);
    }
  });
});

describe('same-origin API proxy', () => {
  let api: ReturnType<typeof Bun.serve>;
  let web: ReturnType<typeof createStaticServer>;
  let external: ReturnType<typeof Bun.serve>;
  let apiRequests = 0;
  let externalRequests = 0;
  const webOrigin = () => `http://127.0.0.1:${web.port}`;
  const apiOrigin = () => `http://127.0.0.1:${api.port}`;

  beforeAll(() => {
    external = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        externalRequests++;
        return new Response('external peer');
      },
    });
    api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(request) {
        apiRequests++;
        const url = new URL(request.url);
        if (url.pathname === '/redirect') {
          return Response.redirect(`http://127.0.0.1:${external.port}/secret`, 302);
        }
        if (url.pathname === '/events') {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"seq":1}\n\n'));
                // Deliberately left open: a buffered proxy would never return this event.
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        return Response.json(
          {
            method: request.method,
            path: url.pathname,
            query: url.search,
            origin: request.headers.get('origin'),
            cookie: request.headers.get('cookie'),
            forwarded: request.headers.get('forwarded'),
            forwardedHost: request.headers.get('x-forwarded-host'),
            clientAddress: request.headers.get('x-melete-client-address'),
            body: await request.text(),
          },
          {
            status: 201,
            headers: [
              [
                'set-cookie',
                'melete_session=session-value; Path=/; HttpOnly; Secure; SameSite=Lax',
              ],
              ['set-cookie', 'other=value; Path=/; HttpOnly'],
              ['cache-control', 'no-store'],
            ],
          },
        );
      },
    });
    web = createStaticServer({
      root: join(base, 'dist'),
      port: 0,
      hostname: '127.0.0.1',
      apiOrigin: apiOrigin(),
    });
  });

  afterAll(() => {
    web.stop(true);
    api.stop(true);
    external.stop(true);
  });

  test('forwards authenticated writes with the internal origin and intact cookies', async () => {
    const response = await fetch(`${webOrigin()}/api/setup?trace=1`, {
      method: 'POST',
      headers: {
        origin: webOrigin(),
        cookie: 'melete_session=incoming-session',
        'content-type': 'application/json',
        forwarded: 'host=untrusted.example;proto=https',
        'x-forwarded-host': 'untrusted.example',
      },
      body: '{"email":"owner@example.test"}',
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      method: 'POST',
      path: '/setup',
      query: '?trace=1',
      origin: apiOrigin(),
      cookie: 'melete_session=incoming-session',
      forwarded: null,
      forwardedHost: null,
      clientAddress: '127.0.0.1',
      body: '{"email":"owner@example.test"}',
    });
    expect(response.headers.getSetCookie()).toEqual([
      'melete_session=session-value; Path=/; HttpOnly; Secure; SameSite=Lax',
      'other=value; Path=/; HttpOnly',
    ]);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('states the browser socket as the client address and discards any the browser sent', async () => {
    for (const claimed of ['203.0.113.9', '203.0.113.9, 198.51.100.4', '']) {
      const response = await fetch(`${webOrigin()}/api/login`, {
        method: 'POST',
        headers: {
          origin: webOrigin(),
          'content-type': 'application/json',
          'x-melete-client-address': claimed,
          'x-forwarded-for': '203.0.113.10',
          'x-real-ip': '203.0.113.11',
        },
        body: '{}',
      });
      const seen = (await response.json()) as { clientAddress: string | null };
      expect(seen.clientAddress).toBe('127.0.0.1');
    }
    expect(CLIENT_ADDRESS_HEADER).toBe(API_CLIENT_ADDRESS_HEADER);
  });

  test('rejects foreign, opaque, and cross-site browser requests before contacting the API', async () => {
    const count = apiRequests;
    const rejectedHeaders: Record<string, string>[] = [
      { origin: 'https://untrusted.example' },
      { origin: 'null' },
      { origin: webOrigin(), 'sec-fetch-site': 'cross-site' },
      { origin: 'https://untrusted.example', 'x-forwarded-host': 'untrusted.example' },
    ];
    for (const headers of rejectedHeaders) {
      const response = await fetch(`${webOrigin()}/api/setup`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(response.status).toBe(403);
    }
    expect(apiRequests).toBe(count);
  });

  test('supports clients that omit Origin', async () => {
    const response = await fetch(`${webOrigin()}/api/me`);
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ path: '/me' });
  });

  test('request paths and query parameters cannot choose another upstream', async () => {
    for (const path of [
      `/api//127.0.0.1:${external.port}/secret`,
      `/api/http://127.0.0.1:${external.port}/secret`,
      `/api/health?url=http://127.0.0.1:${external.port}/secret`,
    ]) {
      const response = await fetch(`${webOrigin()}${path}`);
      expect(response.status).toBe(201);
    }
    expect(externalRequests).toBe(0);
  });

  test('never follows an upstream redirect with a session cookie', async () => {
    const response = await fetch(`${webOrigin()}/api/redirect`, {
      redirect: 'manual',
      headers: { cookie: 'melete_session=private' },
    });
    expect(response.status).toBe(302);
    expect(externalRequests).toBe(0);
  });

  test('streams the first SSE event before the upstream closes', async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2000);
    try {
      const response = await fetch(`${webOrigin()}/api/events`, { signal: abort.signal });
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toBe('data: {"seq":1}\n\n');
      await reader?.cancel();
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });

  test('a forwarded address is ignored when no upstream is configured', async () => {
    const response = await fetch(`${webOrigin()}/api/login`, {
      headers: {
        origin: webOrigin(),
        'x-forwarded-for': '100.100.0.5',
        'tailscale-user-login': 'stranger@example.test',
      },
    });
    const seen = (await response.json()) as { clientAddress: string | null };
    expect(seen.clientAddress).toBe('127.0.0.1');
  });

  test('uses an explicitly configured TLS origin without trusting forwarded headers', async () => {
    const tlsWeb = createStaticServer({
      root: join(base, 'dist'),
      port: 0,
      hostname: '127.0.0.1',
      apiOrigin: apiOrigin(),
      publicOrigin: 'https://melete.example.test',
    });
    try {
      const response = await fetch(`http://127.0.0.1:${tlsWeb.port}/api/setup`, {
        method: 'POST',
        headers: { origin: 'https://melete.example.test' },
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ origin: apiOrigin() });
    } finally {
      tlsWeb.stop(true);
    }
  });
});

/**
 * With the tailnet overlay the browser is no longer the web server's socket
 * peer: every device arrives through the Tailscale node, so without this every
 * phone and laptop on the tailnet would share one sign-in limiter. The node
 * states the device's tailnet address in `X-Forwarded-For`; a browser can send
 * the same header, so the deciding question is which socket the request came
 * from, and nothing else.
 */
describe('a trusted upstream in front of the web server', () => {
  let api: ReturnType<typeof Bun.serve>;
  let seen: {
    clientAddress: string | null;
    identity: string | null;
    invented: string | null;
    forwarded: string | null;
  };
  const apiOrigin = () => `http://127.0.0.1:${api.port}`;
  /** Two events three seconds apart, then held open, as a job stream is. */
  const EVENT_GAP_MS = 3000;

  const serverWith = (trustedUpstream?: string) =>
    createStaticServer({
      root: join(base, 'dist'),
      port: 0,
      hostname: '127.0.0.1',
      apiOrigin: apiOrigin(),
      trustedUpstream,
    });

  beforeAll(() => {
    api = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        seen = {
          clientAddress: request.headers.get('x-melete-client-address'),
          identity: request.headers.get('tailscale-user-login'),
          // A name Serve does not rewrite, so a browser could have written it.
          invented: request.headers.get('tailscale-account'),
          forwarded: request.headers.get('x-forwarded-for'),
        };
        if (new URL(request.url).pathname !== '/events') return Response.json(seen);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"seq":1}\n\n'));
              setTimeout(() => {
                controller.enqueue(encoder.encode('data: {"seq":2}\n\n'));
                // Held open afterwards, as a quiet conversation is.
              }, EVENT_GAP_MS);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
  });

  afterAll(() => {
    api.stop(true);
  });

  const ask = async (
    web: ReturnType<typeof createStaticServer>,
    headers: Record<string, string>,
  ) => {
    // The header handling under test does not depend on the method, and a
    // read keeps each case to one exchange on the connection.
    const response = await fetch(`http://127.0.0.1:${web.port}/api/login`, { headers });
    expect(response.status).toBe(200);
    return seen;
  };

  test('the upstream states the address the API limits, in place of its own socket', async () => {
    const web = serverWith('127.0.0.1');
    try {
      // A tailnet peer is a CGNAT address; a tailnet IPv6 peer is unique-local.
      for (const address of ['100.64.0.1', '100.100.0.5', 'fd7a:115c:a1e0::4501']) {
        const result = await ask(web, { 'x-forwarded-for': address });
        expect(result.clientAddress, address).toBe(address);
      }
    } finally {
      web.stop(true);
    }
  });

  test('a forged address from a peer that is not the upstream mints no fresh bucket', async () => {
    // The upstream is named as some other machine, so this socket is not it.
    for (const upstream of ['203.0.113.7', undefined]) {
      const web = serverWith(upstream);
      try {
        const result = await ask(web, { 'x-forwarded-for': '100.100.0.5' });
        expect(result.clientAddress, String(upstream)).toBe('127.0.0.1');
      } finally {
        web.stop(true);
      }
    }
  });

  test('only one well-formed address is believed, and never a list', async () => {
    const web = serverWith('127.0.0.1');
    try {
      for (const value of [
        '100.100.0.5, 203.0.113.9',
        '203.0.113.9, 100.100.0.5',
        'not-an-address',
        '100.100.0.5:443',
        '',
        '  ',
        'localhost',
      ]) {
        const result = await ask(web, { 'x-forwarded-for': value });
        expect(result.clientAddress, JSON.stringify(value)).toBe('127.0.0.1');
      }
    } finally {
      web.stop(true);
    }
  });

  test('the API never receives a forwarding header, believed or not', async () => {
    for (const upstream of ['127.0.0.1', undefined]) {
      const web = serverWith(upstream);
      try {
        const result = await ask(web, {
          'x-forwarded-for': '100.100.0.5',
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'melete.example.ts.net',
        });
        expect(result.forwarded, String(upstream)).toBeNull();
      } finally {
        web.stop(true);
      }
    }
  });

  test('an identity header from a browser never reaches the API', async () => {
    // No sign-in here reads these; stripping them keeps a later one honest.
    for (const upstream of ['203.0.113.7', undefined]) {
      const web = serverWith(upstream);
      try {
        const result = await ask(web, { 'tailscale-user-login': 'stranger@example.test' });
        expect(result.identity, String(upstream)).toBeNull();
      } finally {
        web.stop(true);
      }
    }
  });

  test('an identity header from the upstream does not reach the API either', async () => {
    // Serve rewrites the five names it owns and leaves every other
    // `Tailscale-` header a browser invents in place, so a name from that
    // connection is not evidence that the node wrote it. Nothing here reads
    // one, so nothing here forwards one.
    const web = serverWith('127.0.0.1');
    try {
      const result = await ask(web, {
        'tailscale-user-login': 'owner@example.test',
        'tailscale-account': 'owner',
      });
      expect(result.identity).toBeNull();
      expect(result.invented).toBeNull();
    } finally {
      web.stop(true);
    }
  });

  test.each(['127.0.0.1', undefined])(
    'an event stream through the upstream %s delivers events as they happen and stays open',
    async (upstream) => {
      const web = serverWith(upstream);
      const abort = new AbortController();
      try {
        const started = Date.now();
        const response = await fetch(`http://127.0.0.1:${web.port}/api/events`, {
          headers: { 'x-forwarded-for': '100.100.0.5' },
          signal: abort.signal,
        });
        expect(response.headers.get('content-type')).toBe('text/event-stream');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('the stream had no body');
        const decoder = new TextDecoder();

        const first = await reader.read();
        // Long before the second event exists: nothing is being accumulated.
        expect(Date.now() - started).toBeLessThan(EVENT_GAP_MS - 500);
        expect(decoder.decode(first.value)).toBe('data: {"seq":1}\n\n');

        const second = await reader.read();
        expect(Date.now() - started).toBeGreaterThanOrEqual(EVENT_GAP_MS - 500);
        expect(decoder.decode(second.value)).toBe('data: {"seq":2}\n\n');
        // The upstream address still reached the API on the streaming request.
        expect(seen.clientAddress).toBe(upstream ? '100.100.0.5' : '127.0.0.1');

        // Quiet, not finished: an idle stream is still a stream.
        const idle = await Promise.race([
          reader.read().then(() => 'closed' as const),
          Bun.sleep(750).then(() => 'open' as const),
        ]);
        expect(idle).toBe('open');
        await reader.cancel();
      } finally {
        abort.abort();
        web.stop(true);
      }
    },
  );
});

describe('the configured public origin', () => {
  test('one that is not an origin stops the server naming MELETE_WEB_ORIGIN', () => {
    for (const publicOrigin of [
      'assistant.example.net',
      'localhost:3101',
      'https://assistant.example.net/melete',
      'ftp://assistant.example.net',
    ])
      expect(() => createStaticServer({ root: base, port: 0, publicOrigin })).toThrow(
        'MELETE_WEB_ORIGIN must be an http:// or https:// origin',
      );
  });

  test('a trailing slash is the same origin', () => {
    const web = createStaticServer({
      root: base,
      port: 0,
      publicOrigin: 'https://assistant.example.net/',
    });
    web.stop(true);
  });
});
