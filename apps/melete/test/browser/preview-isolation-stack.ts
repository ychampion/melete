/**
 * A stack for proving, in a real browser, what a preview of a server in an
 * agent's computer can and cannot do.
 *
 * - The web server is the real one (deploy/scripts/serve-static.ts), with the
 *   real frame headers and the real `/api` proxy.
 * - Behind it, a stand-in API: a sign-in that sets a Lax session cookie, a
 *   `/me` that answers only to that cookie, and the real preview routes and
 *   proxy (src/sandbox/preview.ts) behind the real isolation middleware. Who
 *   may watch which process is a stand-in here; the database side is proven
 *   in src/sandbox/preview-access.test.ts.
 * - The "computer": a development server on the port its process declared,
 *   which records what each request carried, and serves an adversarial page
 *   that links its own files from the root, as development servers do.
 * - Another server in the same place on a port nobody declared, and another
 *   site; both count every request that reaches them.
 *
 * Run it on its own to look at it in a browser:
 *   bun run apps/melete/test/browser/preview-isolation-stack.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { createStaticServer } from '../../../../deploy/scripts/serve-static.ts';
import { ServiceError } from '../../src/api/errors.ts';
import { mountSandboxPreviews, SandboxPreviews } from '../../src/sandbox/preview.ts';
import { PREVIEW_PREFIX } from '../../src/sandbox/preview-path.ts';
import type { ProcessComputer } from '../../src/sandbox/process-helper.ts';
import type { ProcessRow } from '../../src/sandbox/processes.ts';
import type { SandboxProvider } from '../../src/sandbox/types.ts';
import { isolated } from '../../src/viewer/headers.ts';

const SESSION = 'melete_session';
const SESSION_VALUE = 's3ssion-the-preview-must-never-see';
const PERSON = 'prn_person';
const PROCESS = 'prc_01JPREVIEWPROBE00000000000';

/** Every attempt the previewed page makes, and the controls that show its own files load. */
const PROBE = (elsewhere: string, undeclared: string) => `
const results = {};
const leaked = (what) => 'LEAKED: ' + String(what).slice(0, 120);
const record = (name, value) => { results[name] = value; };
const attempt = async (name, run) => {
  try { record(name, await run()); } catch (error) { record(name, 'blocked: ' + (error && error.name || error)); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await attempt('cookie', () => (document.cookie.includes('${SESSION}') ? leaked(document.cookie) : 'blocked: empty'));
await attempt('localStorage', () => leaked(localStorage.getItem('melete-secret')));
await attempt('api', async () => leaked(await (await fetch('/api/me')).text()));
await attempt('api_credentials', async () => leaked(await (await fetch('/api/me', { credentials: 'include' })).text()));
await attempt('parentDocument', () => leaked(parent.document.cookie));
await attempt('origin', () => (self.origin === 'null' ? 'opaque' : leaked(self.origin)));
await attempt('undeclared', async () => leaked((await fetch('${undeclared}/fetch')).status));
await attempt('elsewhere', async () => leaked((await fetch('${elsewhere}/fetch')).status));
await attempt('websocket', () => new Promise((resolve, reject) => {
  const socket = new WebSocket('${undeclared.replace('http', 'ws')}/ws');
  socket.onopen = () => resolve(leaked('open'));
  socket.onerror = () => reject(new Error('closed'));
}));
await attempt('popup', () => { const opened = window.open('${elsewhere}/popup'); return opened ? leaked('opened') : 'blocked: null'; });
await attempt('topNavigation', () => { top.location.href = '${elsewhere}/top'; return 'attempted'; });
await wait(400);
record('moduleScript', 'ran');
record('ownStyle', getComputedStyle(document.getElementById('styled')).color);
record('ownImage', document.getElementById('own').naturalWidth > 0 ? 'loaded' : 'did not load');
record('undeclaredImage', document.getElementById('stray').naturalWidth > 0 ? leaked('loaded') : 'blocked');
document.getElementById('out').textContent = JSON.stringify(results);
parent.postMessage({ type: 'fixture.results', results }, '*');
`;

const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

const PARENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Melete</title></head>
<body><h1>Preview</h1><iframe id="preview" title="Preview" sandbox="allow-scripts allow-forms allow-downloads"
referrerpolicy="no-referrer" style="width:800px;height:400px"></iframe>
<pre id="results">waiting</pre><script type="module" src="/parent.js"></script></body></html>`;

const PARENT_JS = (path: string) => `
localStorage.setItem('melete-secret', 'parent-local-secret');
await fetch('/api/login', { method: 'POST' });
window.addEventListener('message', (event) => {
  const frame = document.getElementById('preview');
  if (event.source !== frame.contentWindow || !event.data || event.data.type !== 'fixture.results') return;
  window.__results = event.data.results;
  document.getElementById('results').textContent = JSON.stringify(event.data.results);
});
document.getElementById('preview').src = '/api${path}';
`;

/** One request as the development server received it. */
export type Reached = { path: string; cookie: string | null; authorization: string | null };

export type PreviewStack = {
  /** Where a browser opens Melete. */
  web: string;
  /** The preview path, below `/api`. */
  path: string;
  /** What reached the declared port. */
  reached: Reached[];
  /** Requests that reached the port nobody declared, and the other site. */
  strayed: string[];
  elsewhere: string[];
  stop: () => Promise<void>;
};

export async function startPreviewStack(): Promise<PreviewStack> {
  const reached: Reached[] = [];
  const strayed: string[] = [];
  const elsewhere: string[] = [];

  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      elsewhere.push(new URL(request.url).pathname);
      return new Response('elsewhere', { headers: { 'access-control-allow-origin': '*' } });
    },
  });
  const elsewhereOrigin = `http://localhost:${other.port}`;
  const undeclared = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      strayed.push(new URL(request.url).pathname);
      if (server.upgrade(request)) return undefined;
      return new Response(PIXEL, {
        headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
      });
    },
    websocket: { message() {} },
  });
  const undeclaredOrigin = `http://127.0.0.1:${undeclared.port}`;

  const files: Record<string, { body: string | Uint8Array; type: string }> = {
    '/': {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Dev server</title>
<link rel="stylesheet" href="/assets/style.css"></head><body>
<p id="styled">styled</p><img id="own" src="/assets/pixel.png" alt="">
<img id="stray" src="${undeclaredOrigin}/img" alt="">
<pre id="out">running</pre><script type="module" src="/src/main.js"></script></body></html>`,
    },
    '/assets/style.css': {
      type: 'text/css',
      body: '#styled { color: rgb(1, 2, 3); }\n',
    },
    '/assets/pixel.png': { type: 'image/png', body: PIXEL },
    '/src/main.js': { type: 'text/javascript', body: 'import "/src/probe.js";\n' },
    '/src/probe.js': { type: 'text/javascript', body: PROBE(elsewhereOrigin, undeclaredOrigin) },
  };
  const devServer = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      reached.push({
        path: url.pathname,
        cookie: request.headers.get('cookie'),
        authorization: request.headers.get('authorization'),
      });
      const file = files[url.pathname];
      if (!file) return new Response('not here', { status: 404 });
      return new Response(file.body, {
        headers: { 'content-type': file.type, 'set-cookie': 'dev=1; Path=/' },
      });
    },
  });

  // The real preview service, with a stand-in for who may watch what.
  const row = {
    id: PROCESS,
    spaceId: 'spc_1',
    agentId: 'agt_1',
    connectionId: 'con_1',
    jobId: 'job_1',
    port: devServer.port,
    state: 'running',
    lastLine: 'ready',
  } as unknown as ProcessRow;
  const provider = {
    capabilities: { ports: 'authenticated' },
    previewAddress: async (_handle: unknown, port: number) => ({ host: '127.0.0.1', port }),
  } as unknown as SandboxProvider;
  const helper = {
    status: async () => ({
      boot: 'b',
      missing: [],
      processes: [{ id: PROCESS, ports: [devServer.port] }],
    }),
  } as unknown as ProcessComputer;
  const previews = new SandboxPreviews(
    {
      watched: async (id, principalId) =>
        id === PROCESS && principalId === PERSON
          ? {
              row,
              computer: {
                provider,
                handle: { providerSandboxId: 'melete-sbx-p-1', imageDigest: null, region: null },
              },
            }
          : null,
      sessionLive: async (principalId) => principalId === PERSON,
    },
    { computerFor: () => helper },
  );
  const { path } = await previews.open(PROCESS, PERSON, 'd'.repeat(64));

  const signedIn = (cookie: string | null | undefined) =>
    (cookie ?? '').split(/;\s*/).includes(`${SESSION}=${SESSION_VALUE}`);
  const api = new Hono();
  api.use(`${PREVIEW_PREFIX}*`, isolated);
  api.onError((error, c) =>
    error instanceof ServiceError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status)
      : c.json({ error: { code: 'internal_error', message: 'failed' } }, 500),
  );
  api.post('/login', (c) => {
    c.header('set-cookie', `${SESSION}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`);
    return c.json({ ok: true });
  });
  api.get('/me', (c) =>
    signedIn(c.req.header('cookie'))
      ? c.json({ secret: SESSION_VALUE })
      : c.json({ error: 'no session' }, 401),
  );
  mountSandboxPreviews(api as never, previews);
  const apiServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: api.fetch });

  const root = await mkdtemp(join(tmpdir(), 'melete-preview-isolation-'));
  await writeFile(join(root, 'index.html'), PARENT_HTML);
  await writeFile(join(root, 'parent.js'), PARENT_JS(path));
  const port = await freePort();
  const web = `http://127.0.0.1:${port}`;
  const staticServer = createStaticServer({
    root,
    port,
    hostname: '127.0.0.1',
    apiOrigin: `http://127.0.0.1:${apiServer.port}`,
    publicOrigin: web,
  });

  return {
    web,
    path,
    reached,
    strayed,
    elsewhere,
    stop: async () => {
      staticServer.stop(true);
      apiServer.stop(true);
      devServer.stop(true);
      undeclared.stop(true);
      other.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port ?? 0;
  probe.stop(true);
  return port;
}

if (import.meta.main) {
  const stack = await startPreviewStack();
  process.stdout.write(
    [
      `Melete (framed preview):    ${stack.web}/`,
      `The preview opened directly: ${stack.web}/api${stack.path}`,
      '',
    ].join('\n'),
  );
}
