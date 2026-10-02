/**
 * A stack for proving, in a real browser, what the app isolation headers do.
 *
 * - The web server is the real one (deploy/scripts/serve-static.ts), with the
 *   real frame headers and the real `/api` proxy.
 * - Behind it, a stand-in API: a sign-in that sets a Lax session cookie, a
 *   `/me` that answers only to that cookie, a data route for the bridge, and
 *   the app view path served through the real isolation middleware and
 *   headers (src/viewer/headers.ts). Its token check is a fixed string; the
 *   real token, grant and version checks are proven against a database in
 *   test/integration/app-views.test.ts.
 * - In front of the web server, a recorder that notes what each browser
 *   request carried (Origin, Sec-Fetch-*, whether the session cookie came
 *   along), before the web server strips anything.
 * - Another site, which counts every request that reaches it, and serves a
 *   page that tries to frame Melete.
 *
 * The parent page bundles the real bridge (apps/web/src/apps/bridge.ts) and
 * frames an adversarial app. The app tries everything it should not be able
 * to do, checks the things it should, and writes what happened into its page
 * and to its parent.
 *
 * Run it on its own to look at it in a browser:
 *   bun run apps/melete/test/browser/app-isolation-stack.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { createStaticServer } from '../../../../deploy/scripts/serve-static.ts';
import { framedRequest, isolated, VIEW_PREFIX, viewHeaders } from '../../src/viewer/headers.ts';

const SESSION = 'melete_session';
const SESSION_VALUE = 's3ssion-the-app-must-never-see';
export const DATA = [{ company: 'Acme', value: 1200 }];

/** One request as the browser sent it, before anything was stripped. */
export type Observed = {
  path: string;
  method: string;
  origin: string | null;
  site: string | null;
  mode: string | null;
  dest: string | null;
  session: boolean;
};

/** The bridge client an app bundles; the same protocol the build-an-app skill states. */
const CLIENT = `const melete = (() => {
  let next = 0;
  const waiting = new Map();
  addEventListener('message', (event) => {
    const reply = event.data;
    if (event.source !== parent || !reply || reply.type !== 'melete.reply') return;
    const settle = waiting.get(reply.id);
    if (!settle) return;
    waiting.delete(reply.id);
    reply.ok ? settle[0](reply.value) : settle[1](new Error(reply.error));
  });
  const ask = (message) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, [resolve, reject]);
    parent.postMessage({ ...message, id }, '*');
  });
  return {
    data: (name) => ask({ type: 'melete.data', name }),
    link: (url) => parent.postMessage({ type: 'melete.link', url }, '*'),
    size: (height) => parent.postMessage({ type: 'melete.size', height }, '*'),
  };
})();
`;

/** Every attempt the app makes, and the controls that show its own files do load. */
const PROBE = (elsewhere: string) => `
const results = {};
const leaked = (what) => 'LEAKED: ' + String(what).slice(0, 120);
const record = (name, value) => { results[name] = value; };
const attempt = async (name, run) => {
  try { record(name, await run()); } catch (error) { record(name, 'blocked: ' + (error && error.name || error)); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const top_ = window === window.top;

// Melete's cookies, storage and API.
await attempt('cookie', () => (document.cookie.includes('${SESSION}') ? leaked(document.cookie) : 'blocked: empty'));
await attempt('localStorage', () => leaked(localStorage.getItem('melete-secret')));
await attempt('sessionStorage', () => leaked(sessionStorage.length));
await attempt('indexedDB', () => new Promise((resolve, reject) => {
  const open = indexedDB.open('probe');
  open.onsuccess = () => resolve(leaked('opened'));
  open.onerror = () => reject(open.error);
}));
await attempt('api', async () => leaked(await (await fetch('/api/me')).text()));
await attempt('api_credentials', async () => leaked(await (await fetch('/api/me', { credentials: 'include' })).text()));
await attempt('parentDocument', () => leaked(parent.document.cookie));
await attempt('parentStorage', () => leaked(parent.localStorage.getItem('melete-secret')));
await attempt('origin', () => (self.origin === 'null' ? 'opaque' : leaked(self.origin)));

// Anywhere outside its bundle.
await attempt('fetch', async () => leaked((await fetch('${elsewhere}/fetch')).status));
await attempt('beacon', () => (navigator.sendBeacon('${elsewhere}/beacon', 'x') ? 'queued' : 'blocked: refused'));
await attempt('websocket', () => new Promise((resolve, reject) => {
  const socket = new WebSocket('${elsewhere.replace('http', 'ws')}/ws');
  socket.onopen = () => resolve(leaked('open'));
  socket.onerror = () => reject(new Error('closed'));
}));
await attempt('popup', () => { const opened = window.open('${elsewhere}/popup'); return opened ? leaked('opened') : 'blocked: null'; });
// Opened on its own, the page is the top: moving it anywhere is allowed, which
// is why the service refuses to serve one that way. Framed, it is refused.
if (!top_) await attempt('topNavigation', () => { top.location.href = '${elsewhere}/top'; return 'attempted'; });

// Its own files: each of these has to work, or the policy is too tight to use.
await wait(400);
record('classicScript', window.classicRan === true ? 'ran' : 'did not run');
record('moduleScript', 'ran');
record('ownImage', document.getElementById('own').naturalWidth > 0 ? 'loaded' : 'did not load');
record('externalImage', document.getElementById('external').naturalWidth > 0 ? leaked('loaded') : 'blocked');
record('ownStyle', getComputedStyle(document.getElementById('styled')).color);
await attempt('bridgeData', async () => (top_ ? 'no parent' : JSON.stringify(await Promise.race([melete.data('deals'), wait(3000).then(() => 'no answer')]))));
if (!top_) melete.size(640);
if (!top_) melete.link('https://example.com/from-the-app');

document.getElementById('out').textContent = JSON.stringify(results);
parent.postMessage({ type: 'fixture.results', results }, '*');
// Last, because each can end the page: a form posted elsewhere, then the
// app moving its own frame somewhere else.
const leave = new URLSearchParams(location.search).get('leave');
if (leave === 'form') setTimeout(() => document.getElementById('form').submit(), 200);
if (leave === 'nav') setTimeout(() => { location.href = '${elsewhere}/nav'; }, 200);
`;

const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

function bundle(elsewhere: string): Record<string, { body: string | Uint8Array; type: string }> {
  return {
    'index.html': {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title>
<link rel="stylesheet" href="style.css">
<link rel="prefetch" href="${elsewhere}/prefetch">
<script src="classic.js"></script>
<script src="${elsewhere}/script.js"></script>
<script src="melete-app.js"></script>
</head><body>
<p id="styled">styled</p>
<img id="own" src="pixel.png" alt="">
<img id="external" src="${elsewhere}/img" alt="">
<form id="form" method="post" action="${elsewhere}/form"><input name="x" value="1"></form>
<iframe src="${elsewhere}/frame" title="elsewhere"></iframe>
<pre id="out">running</pre>
<script type="module" src="probe.js"></script>
</body></html>`,
    },
    'style.css': {
      type: 'text/css; charset=utf-8',
      body: `#styled { color: rgb(1, 2, 3); }\nbody { background-image: url(${elsewhere}/css); }\n`,
    },
    'classic.js': { type: 'text/javascript; charset=utf-8', body: 'window.classicRan = true;\n' },
    'melete-app.js': { type: 'text/javascript; charset=utf-8', body: CLIENT },
    'probe.js': { type: 'text/javascript; charset=utf-8', body: PROBE(elsewhere) },
    'pixel.png': { type: 'image/png', body: PIXEL },
  };
}

const PARENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Melete</title></head>
<body><h1>Apps</h1><iframe id="app" title="Probe" sandbox="allow-scripts allow-forms allow-downloads"
referrerpolicy="no-referrer" style="width:800px;height:400px"></iframe>
<iframe id="form-frame" title="Probe, posting a form" sandbox="allow-scripts allow-forms allow-downloads"
referrerpolicy="no-referrer" style="width:200px;height:100px"></iframe>
<pre id="results">waiting</pre><pre id="bridge"></pre><script type="module" src="/parent.js"></script></body></html>`;

/** The parent page: sign in, frame the app, run the real bridge, and keep what the app reports. */
const BRIDGE = fileURLToPath(new URL('../../../web/src/apps/bridge.ts', import.meta.url))
  .split(sep)
  .join('/');
const PARENT_ENTRY = `
import { connectBridge } from '${BRIDGE}';
const shown = { asked: [], size: null };
const show = () => { document.getElementById('bridge').textContent = JSON.stringify(shown); };
localStorage.setItem('melete-secret', 'parent-local-secret');
await fetch('/api/login', { method: 'POST' });
const frame = document.getElementById('app');
connectBridge(() => frame, {
  data: async (name) => {
    shown.asked.push(name);
    const response = await fetch('/api/apps/app_probe/data/' + name);
    return response.ok ? { ok: true, value: await response.json() } : { ok: false, error: String(response.status) };
  },
  submit: async () => ({ ok: false, error: 'none' }),
  confirmLink: async (url) => { shown.link = url; show(); return false; },
  resize: (height) => { shown.size = height; show(); },
});
window.addEventListener('message', (event) => {
  if (event.source !== frame.contentWindow || !event.data || event.data.type !== 'fixture.results') return;
  window.__results = event.data.results;
  document.getElementById('results').textContent = JSON.stringify(event.data.results);
});
frame.src = '/api${VIEW_PREFIX}tok/index.html?leave=nav';
document.getElementById('form-frame').src = '/api${VIEW_PREFIX}tok/index.html?leave=form';
`;

export type IsolationStack = {
  /** Where a browser opens Melete: the recorder in front of the web server. */
  web: string;
  /** The other site. */
  elsewhere: string;
  /** Every request the other site received, by path. */
  hits: string[];
  /** Every request a browser made to Melete, as it arrived. */
  observed: Observed[];
  stop: () => Promise<void>;
};

export async function startIsolationStack(): Promise<IsolationStack> {
  const hits: string[] = [];
  const observed: Observed[] = [];
  // The recorder's port is chosen first, so every page can name Melete's origin.
  const recorderPort = await freePort();
  const web = `http://127.0.0.1:${recorderPort}`;

  const other = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/frames-melete.html')
        return new Response(
          `<!doctype html><title>Another site</title><iframe id="melete" src="${web}/" title="Melete"></iframe>`,
          { headers: { 'content-type': 'text/html' } },
        );
      hits.push(url.pathname);
      if (url.pathname === '/ws' && server.upgrade(request)) return undefined;
      return new Response('elsewhere', {
        headers: { 'access-control-allow-origin': '*', 'content-type': 'text/plain' },
      });
    },
    websocket: { message() {} },
  });
  const elsewhere = `http://127.0.0.1:${other.port}`;
  const files = bundle(elsewhere);

  // The stand-in API, with the view path behind the real isolation.
  const api = new Hono();
  api.use(`${VIEW_PREFIX}*`, isolated);
  api.post('/login', (c) => {
    c.header('set-cookie', `${SESSION}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Lax`);
    return c.json({ ok: true });
  });
  const signedIn = (cookie: string | undefined) =>
    (cookie ?? '').split(/;\s*/).includes(`${SESSION}=${SESSION_VALUE}`);
  api.get('/me', (c) =>
    signedIn(c.req.header('cookie'))
      ? c.json({ secret: SESSION_VALUE })
      : c.json({ error: 'no session' }, 401),
  );
  api.get('/apps/app_probe/data/:name', (c) =>
    signedIn(c.req.header('cookie')) && c.req.param('name') === 'deals'
      ? c.json(DATA)
      : c.json({ error: 'no' }, 404),
  );
  api.get(`${VIEW_PREFIX}:token/:path{.+}`, (c) => {
    // `direct` stands for a view whose page-of-its-own refusal failed, so the
    // policy alone can be watched holding in a page opened on its own.
    const token = c.req.param('token');
    if (token !== 'tok' && token !== 'direct') return c.json({ error: 'ended' }, 404);
    if (token === 'tok' && !framedRequest(c.req.header('sec-fetch-dest')))
      return c.json({ error: { code: 'forbidden', message: 'Open this app from Melete.' } }, 403);
    const file = files[c.req.param('path')];
    if (!file) return c.json({ error: 'no file' }, 404);
    return new Response(file.body, { headers: viewHeaders(file.type) });
  });
  const apiServer = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: api.fetch });

  const root = await mkdtemp(join(tmpdir(), 'melete-isolation-'));
  await writeFile(join(root, 'index.html'), PARENT_HTML);
  const entry = join(root, 'parent-entry.ts');
  await writeFile(entry, PARENT_ENTRY);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  if (!built.success) throw new Error(`the parent page did not build: ${built.logs.join('\n')}`);
  const [output] = built.outputs;
  if (!output) throw new Error('the parent page built to nothing');
  await writeFile(join(root, 'parent.js'), await output.text());

  // The recorder, in front of the web server, whose public origin is the
  // recorder's, as a reverse proxy's would be.
  const staticServer = createStaticServer({
    root,
    port: 0,
    hostname: '127.0.0.1',
    apiOrigin: `http://127.0.0.1:${apiServer.port}`,
    publicOrigin: web,
  });
  const recorder = Bun.serve({
    port: recorderPort,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/__report')
        return Response.json({ hits, observed }, { headers: { 'cache-control': 'no-store' } });
      observed.push({
        path: url.pathname,
        method: request.method,
        origin: request.headers.get('origin'),
        site: request.headers.get('sec-fetch-site'),
        mode: request.headers.get('sec-fetch-mode'),
        dest: request.headers.get('sec-fetch-dest'),
        session: signedIn(request.headers.get('cookie') ?? undefined),
      });
      const headers = new Headers(request.headers);
      headers.delete('host');
      const answered = await fetch(
        `http://127.0.0.1:${staticServer.port}${url.pathname}${url.search}`,
        {
          method: request.method,
          headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
          redirect: 'manual',
          decompress: false,
        },
      );
      return new Response(answered.body, { status: answered.status, headers: answered.headers });
    },
  });

  return {
    web,
    elsewhere,
    hits,
    observed,
    stop: async () => {
      recorder.stop(true);
      staticServer.stop(true);
      apiServer.stop(true);
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
  const stack = await startIsolationStack();
  process.stdout.write(
    [
      `Melete (framed app):      ${stack.web}/`,
      `The app opened directly:  ${stack.web}/api${VIEW_PREFIX}tok/index.html`,
      `Policy alone, top level:  ${stack.web}/api${VIEW_PREFIX}direct/index.html`,
      `Another site framing it:  ${stack.elsewhere}/frames-melete.html`,
      `What arrived where:       ${stack.web}/__report`,
      '',
    ].join('\n'),
  );
}
