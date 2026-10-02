/**
 * The preview proxy against real servers on this machine: one standing in
 * for the process's declared port, one for a port it never declared. The
 * people and process records are a stand-in here; the database side is
 * proven in test/integration/sandbox-preview.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { loadEnv } from '../env.ts';
import { type AppDeps, createApp } from '../index.ts';
import { isIsolated, VIEW_POLICY } from '../viewer/headers.ts';
import {
  forwardPreview,
  keepInside,
  type PreviewAccess,
  relocate,
  rootFrom,
  SandboxPreviews,
  type WatchedProcess,
} from './preview.ts';
import { PREVIEW_PREFIX } from './preview-path.ts';
import type { ProcessComputer } from './process-helper.ts';
import type { ProcessRow } from './processes.ts';
import type { PreviewAddress, SandboxProvider } from './types.ts';

type Seen = { path: string; headers: Record<string, string> };

/** A script past the rewrite limit, with a root link that must pass through unchanged. */
const BIG_SCRIPT = `import "/src/a.js";
//${'x'.repeat(6 * 1024 * 1024)}
`;

let declared: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
const reached: Seen[] = [];
const strayed: Seen[] = [];

const record = (into: Seen[]) => (request: Request) => {
  const url = new URL(request.url);
  into.push({ path: `${url.pathname}${url.search}`, headers: Object.fromEntries(request.headers) });
  return undefined;
};

beforeAll(() => {
  const seen = record(reached);
  declared = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      seen(request);
      const url = new URL(request.url);
      const html = (body: string) =>
        new Response(body, {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'set-cookie': 'dev=1; Path=/',
            'clear-site-data': '"*"',
            'access-control-allow-origin': '*',
            'content-security-policy': 'default-src *; frame-ancestors *',
            etag: '"v1"',
          },
        });
      if (url.pathname === '/')
        return html(
          '<!doctype html><script type="module" src="/src/main.js"></script><a href="//elsewhere.test/x">x</a><img src="pic.png">',
        );
      if (url.pathname === '/src/main.js')
        return new Response('import { a } from "/src/a.js";\nimport("/src/b.js");\n', {
          headers: { 'content-type': 'text/javascript' },
        });
      if (url.pathname === '/old')
        return Response.redirect(`http://localhost:${declared.port}/new?q=1`, 302);
      if (url.pathname === '/away') return Response.redirect('https://elsewhere.test/', 302);
      if (url.pathname === '/huge')
        return new Response(new Uint8Array(51 * 1024 * 1024), {
          headers: { 'content-type': 'application/octet-stream' },
        });
      if (url.pathname === '/big.js')
        return new Response(BIG_SCRIPT, { headers: { 'content-type': 'text/javascript' } });
      if (url.pathname === '/big-streamed.js')
        return new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(BIG_SCRIPT);
              for (let at = 0; at < bytes.byteLength; at += 256 * 1024)
                controller.enqueue(bytes.slice(at, at + 256 * 1024));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/javascript' } },
        );
      if (url.pathname === '/stream') {
        let sent = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (sent > 52 * 1024 * 1024) return controller.close();
              sent += 1024 * 1024;
              controller.enqueue(new Uint8Array(1024 * 1024));
            },
          }),
          { headers: { 'content-type': 'application/octet-stream' } },
        );
      }
      return new Response('plain', { headers: { 'content-type': 'text/plain' } });
    },
  });
  const stray = record(strayed);
  other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      stray(request);
      return new Response('the port nobody declared');
    },
  });
});

afterAll(() => {
  declared?.stop(true);
  other?.stop(true);
});

const PERSON = 'prn_person';
const DIGEST = 'a'.repeat(64);

function processRow(overrides: Partial<ProcessRow> = {}): ProcessRow {
  return {
    id: 'prc_01JABCDEFGHJKMNPQRSTVWXYZ0',
    spaceId: 'spc_1',
    agentId: 'agt_1',
    connectionId: 'con_1',
    sessionId: 'sbs_1',
    jobId: 'job_1',
    actionId: 'act_1',
    command: 'npm run dev',
    commandDigest: 'd',
    cwd: '/work',
    name: 'dev server',
    port: declared.port ?? 0,
    state: 'running',
    exitCode: null,
    signal: null,
    bootId: 'b',
    startedAt: new Date(),
    endedAt: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    outputCursor: 0,
    outputBytes: 0,
    lastLine: 'ready',
    lastOutputAt: null,
    endReason: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A computer on this machine: its address is 127.0.0.1, and only the asked port. */
function provider(address: (port: number) => PreviewAddress | null): SandboxProvider {
  return {
    capabilities: { ports: 'authenticated' },
    previewAddress: async (_handle: unknown, port: number) => address(port),
  } as unknown as SandboxProvider;
}

type World = {
  row: ProcessRow;
  watcher: string;
  sessionLive: boolean;
  listening: number[];
  computer: WatchedProcess['computer'];
};

let world: World;

beforeEach(() => {
  reached.length = 0;
  strayed.length = 0;
  world = {
    row: processRow(),
    watcher: PERSON,
    sessionLive: true,
    listening: [declared.port ?? 0],
    computer: {
      provider: provider((port) => ({ host: '127.0.0.1', port })),
      handle: { providerSandboxId: 'melete-sbx-p-1', imageDigest: null, region: null },
    },
  };
});

const access: PreviewAccess = {
  watched: async (id, principalId) =>
    id === world.row.id && principalId === world.watcher
      ? { row: world.row, computer: world.computer }
      : null,
  sessionLive: async (principalId, tag) =>
    world.sessionLive && principalId === PERSON && tag.length === 32,
};

const helper = {
  status: async () => ({
    boot: 'b',
    missing: [],
    processes: [{ id: world.row.id, ports: world.listening }],
  }),
} as unknown as ProcessComputer;

const previews = () => new SandboxPreviews(access, { computerFor: () => helper });

/** The real service app, with every other dependency a stub. */
function serviceWith(service: SandboxPreviews) {
  const stub = new Proxy({}, { get: () => () => undefined }) as never;
  const deps: AppDeps = {
    env: loadEnv({}),
    checkDatabase: async () => 'ok',
    db: stub,
    sql: stub,
    registry: stub,
    jobs: stub,
    sandboxPreviews: service,
  };
  return createApp(deps);
}

const framed = { 'sec-fetch-dest': 'iframe' };

describe('a preview of a server in an agent computer', () => {
  test('a preview never forwards the Melete cookie, and the page runs in an opaque origin', async () => {
    const service = previews();
    const opened = await service.open(world.row.id, PERSON, DIGEST);
    expect(opened.path).toStartWith(PREVIEW_PREFIX);
    const app = serviceWith(service);
    // No session on this request: the token in the path is what lets it in.
    const page = await app.request(opened.path, {
      headers: {
        ...framed,
        cookie: 'melete_session=the-session-the-page-must-never-see',
        authorization: 'Bearer melete-token',
        origin: 'null',
        'x-melete-space': 'spc_other',
        'proxy-authorization': 'Basic x',
        forwarded: 'for=1.2.3.4',
        accept: 'text/html',
      },
    });
    expect(page.status).toBe(200);
    // The sandbox policy: an opaque origin, wherever it is opened.
    expect(page.headers.get('content-security-policy')).toBe(VIEW_POLICY);
    expect(VIEW_POLICY).toStartWith('sandbox allow-scripts');
    expect(page.headers.has('set-cookie')).toBe(false);
    expect(page.headers.has('clear-site-data')).toBe(false);
    expect(page.headers.has('access-control-allow-origin')).toBe(false);
    expect(page.headers.get('etag')).toBe('"v1"');
    const body = await page.text();
    // Its own root-relative links load through the preview, not from Melete.
    expect(body).toContain('src="./src/main.js"');
    expect(body).toContain('href="//elsewhere.test/x"');
    expect(reached).toHaveLength(1);
    const sent = reached[0]?.headers ?? {};
    for (const name of [
      'cookie',
      'authorization',
      'origin',
      'x-melete-space',
      'proxy-authorization',
      'forwarded',
    ])
      expect(sent[name], name).toBeUndefined();
    expect(sent.host).toBe(`localhost:${declared.port}`);
    expect(sent.accept).toBe('text/html');

    const script = await app.request(`${opened.path}src/main.js`, {
      headers: { 'sec-fetch-dest': 'script' },
    });
    expect(await script.text()).toBe('import { a } from "../src/a.js";\nimport("../src/b.js");\n');
  });

  test('a preview cannot reach a port the process did not declare', async () => {
    const service = previews();
    const { path } = await service.open(world.row.id, PERSON, DIGEST);
    const app = serviceWith(service);
    const token = path.slice(PREVIEW_PREFIX.length, -1);
    const tries = [
      `//127.0.0.1:${other.port}/`,
      `/http://127.0.0.1:${other.port}/`,
      `/%2F%2F127.0.0.1:${other.port}/`,
      `/..%2F..%2F:${other.port}/`,
      `/@127.0.0.1:${other.port}/`,
      `/\\\\127.0.0.1:${other.port}/`,
    ];
    for (const rest of tries)
      await app.request(`${PREVIEW_PREFIX}${token}${rest}`, { headers: framed });
    expect(strayed).toEqual([]);
    // Every one of them went to the declared port, as a path there.
    expect(reached.length).toBe(tries.length);

    // A token opened for one port does not follow the process to another.
    world.row = { ...world.row, port: other.port ?? 0 };
    const moved = await app.request(path, { headers: framed });
    expect(moved.status).toBe(404);
    expect(await moved.text()).toContain('The process or its computer changed.');
    expect(strayed).toEqual([]);

    // A computer the service shares no network with is never previewed.
    world.row = processRow();
    world.computer = { ...(world.computer ?? ({} as never)), provider: provider(() => null) };
    await expect(service.open(world.row.id, PERSON, DIGEST)).rejects.toThrow(/no network/);
  });

  test('a preview link stops working when its process stops or the viewer loses access', async () => {
    const service = previews();
    const { path } = await service.open(world.row.id, PERSON, DIGEST);
    const app = serviceWith(service);
    expect((await app.request(path, { headers: framed })).status).toBe(200);

    world.row = processRow({ state: 'stopped' });
    const stopped = await app.request(path, { headers: framed });
    expect(stopped.status).toBe(404);
    expect(isIsolated(stopped.headers)).toBe(true);
    expect(await stopped.text()).toContain('That process is not running.');

    world.row = processRow();
    world.watcher = 'prn_someone_else';
    expect((await app.request(path, { headers: framed })).status).toBe(404);

    world.watcher = PERSON;
    world.sessionLive = false;
    const signedOut = await app.request(path, { headers: framed });
    expect(signedOut.status).toBe(404);
    expect(await signedOut.text()).toContain('signed out');

    world.sessionLive = true;
    expect((await app.request(path, { headers: framed })).status).toBe(200);
    expect(reached).toHaveLength(2);
  });

  test('a preview opened as a page of its own, or asked for a live connection, is refused', async () => {
    const service = previews();
    const { path } = await service.open(world.row.id, PERSON, DIGEST);
    const app = serviceWith(service);
    for (const dest of ['document', 'embed', 'object', null]) {
      const response = await app.request(path, { headers: dest ? { 'sec-fetch-dest': dest } : {} });
      expect(response.status).toBe(403);
      expect(isIsolated(response.headers)).toBe(true);
    }
    const upgrade = await app.request(path, {
      headers: { ...framed, upgrade: 'websocket', connection: 'Upgrade' },
    });
    expect(upgrade.status).toBe(400);
    // Only reads: any other method needs a session, and has none here.
    const posted = await app.request(path, { method: 'POST', headers: framed });
    expect(posted.ok).toBe(false);
    expect(isIsolated(posted.headers)).toBe(true);
    expect(reached).toEqual([]);
  });

  test('a preview opens only for a running process that listens on its port, from a browser session', async () => {
    const service = previews();
    await expect(service.open(world.row.id, PERSON, undefined)).rejects.toThrow(/browser/);
    await expect(service.open(world.row.id, 'prn_someone_else', DIGEST)).rejects.toThrow(
      /No such process/,
    );
    world.listening = [];
    await expect(service.open(world.row.id, PERSON, DIGEST)).rejects.toThrow(/listening on port/);
    world.listening = [declared.port ?? 0];
    world.row = processRow({ port: null });
    await expect(service.open(world.row.id, PERSON, DIGEST)).rejects.toThrow(/serves no port/);
    world.row = processRow({ state: 'exited' });
    await expect(service.open(world.row.id, PERSON, DIGEST)).rejects.toThrow(/not running/);
    world.row = processRow();
    world.computer = null;
    await expect(service.open(world.row.id, PERSON, DIGEST)).rejects.toThrow(
      /not running right now/,
    );
  });

  test('redirects stay inside the preview, and an answer past the limit is cut off', async () => {
    const service = previews();
    const { path } = await service.open(world.row.id, PERSON, DIGEST);
    const app = serviceWith(service);
    const moved = await app.request(`${path}old`, { headers: framed });
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('./new?q=1');
    const away = await app.request(`${path}away`, { headers: framed });
    expect(away.status).toBe(502);
    expect(away.headers.has('location')).toBe(false);
    const huge = await app.request(`${path}huge`, { headers: framed });
    // Said up front, it is refused before a byte is passed on.
    expect(huge.status).toBe(502);
    // Streamed without a length, it is cut off at the limit.
    const streamed = await app.request(`${path}stream`, { headers: framed });
    expect(streamed.status).toBe(200);
    await expect(streamed.arrayBuffer()).rejects.toThrow();
  });
});

describe('keeping links inside a preview', () => {
  test('a page below the root names the root relatively', () => {
    expect(rootFrom('/')).toBe('./');
    expect(rootFrom('/index.html')).toBe('./');
    expect(rootFrom('/src/main.js')).toBe('../');
    expect(rootFrom('/a/b/')).toBe('../../');
  });

  test('root links become relative, and links to other sites are left as they are', () => {
    const root = '../';
    expect(keepInside('<link href="/a.css"><img src=/b.png><a href="//x.test/">', root)).toBe(
      '<link href="../a.css"><img src=../b.png><a href="//x.test/">',
    );
    expect(keepInside("import x from '/x.js'; import '/y.css'; import('/z.js')", root)).toBe(
      "import x from '../x.js'; import '../y.css'; import('../z.js')",
    );
    expect(keepInside('a{background:url(/i.png)} @import "/t.css";', root)).toBe(
      'a{background:url(../i.png)} @import "../t.css";',
    );
    expect(keepInside('<a href="https://x.test/">', root)).toBe('<a href="https://x.test/">');
  });

  test('a redirect is kept only when it points at the server itself', () => {
    const address = { host: '172.30.0.2', port: 5173 };
    expect(relocate('/login', address, '/a/b')).toBe('../login');
    expect(relocate('next', address, '/a/b')).toBe('../a/next');
    expect(relocate('http://localhost:5173/x', address, '/')).toBe('./x');
    expect(relocate('http://172.30.0.2:5173/x', address, '/')).toBe('./x');
    expect(relocate('http://localhost:5174/x', address, '/')).toBeNull();
    expect(relocate('https://localhost:5173/x', address, '/')).toBeNull();
    expect(relocate('//elsewhere.test/x', address, '/')).toBeNull();
    expect(relocate('http://elsewhere.test:5173/x', address, '/')).toBeNull();
  });
});

test('the only routes under the preview path are the two reads that check their own token', () => {
  const app = serviceWith(previews());
  const routes = app.routes
    .filter((route) => route.method !== 'ALL' && route.path.startsWith(PREVIEW_PREFIX))
    .map((route) => `${route.method} ${route.path}`);
  expect(routes).toEqual([`GET ${PREVIEW_PREFIX}:token/`, `GET ${PREVIEW_PREFIX}:token/:path{.+}`]);
});

test('the proxy itself passes on none of the server cookies or its own policy, before the seal', async () => {
  const answer = await forwardPreview({
    address: { host: '127.0.0.1', port: declared.port ?? 0 },
    method: 'GET',
    rest: '/',
    search: '',
    headers: new Headers({ cookie: 'melete_session=x' }),
  });
  expect(answer.headers.has('set-cookie')).toBe(false);
  expect(answer.headers.has('clear-site-data')).toBe(false);
  expect(answer.headers.get('content-security-policy')).toBe(VIEW_POLICY);
  expect(reached.at(-1)?.headers.cookie).toBeUndefined();
});

test('a page, script or style past the rewrite limit is passed on unchanged as it arrives, not held whole', async () => {
  const service = previews();
  const { path } = await service.open(world.row.id, PERSON, DIGEST);
  const app = serviceWith(service);
  for (const file of ['big.js', 'big-streamed.js']) {
    const answer = await app.request(`${path}${file}`, { headers: { 'sec-fetch-dest': 'script' } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-security-policy')).toBe(VIEW_POLICY);
    const text = await answer.text();
    expect(text.length).toBe(BIG_SCRIPT.length);
    expect(text.startsWith('import "/src/a.js";')).toBe(true);
  }
});

test('a preview lasts half an hour from when it was opened, and is refused after', async () => {
  let clock = Date.parse('2026-10-03T10:00:00Z');
  const service = new SandboxPreviews(access, { computerFor: () => helper, now: () => clock });
  const opened = await service.open(world.row.id, PERSON, DIGEST);
  expect(Date.parse(opened.expires_at) - clock).toBe(30 * 60_000);
  const app = serviceWith(service);
  clock += 29 * 60_000;
  expect((await app.request(opened.path, { headers: framed })).status).toBe(200);
  clock += 2 * 60_000;
  const late = await app.request(opened.path, { headers: framed });
  expect(late.status).toBe(404);
  expect(await late.text()).toContain('It expired.');
});
