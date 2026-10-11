/**
 * Runs inside the browser image, where signing out of a site is seen in a real profile rather
 * than asserted. Two sites sign in to one space's profile, setting cookies, local storage and an
 * IndexedDB database; the worker's own `forgetSite` then signs out of one of them, once while
 * the space's browser is running and once after it has stopped. The profile is then reopened
 * and read back from each site's own pages, and what each site still holds is reported.
 *
 * The worker is the image's own copy, so the code proved is the code shipped. Mounted into a
 * container by `browser-forget-site.test.ts`; never part of the image. It also runs on a host
 * with Chromium installed, from the repository root.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright';

const worker = (await import(
  `${process.cwd()}/apps/melete/src/workers/browser/sessions.ts`
)) as typeof import('../../src/workers/browser/sessions.ts');

/** The site signed out of is reached on a sub-host, so its storage origin is not its domain. */
const FORGOTTEN = { site: 'alpha.example', host: 'app.alpha.example' };
const KEPT = { site: 'beta.example', host: 'beta.example' };

const secret = (host: string) => `secret-${host.replace(/\W/g, '-')}`;

const SIGN_IN = (host: string) => `<!doctype html><title>signing in</title><script>
localStorage.setItem('who', 'local-${host}');
const opened = indexedDB.open('proof', 1);
opened.onupgradeneeded = () => opened.result.createObjectStore('kv');
opened.onsuccess = () => {
  const tx = opened.result.transaction('kv', 'readwrite');
  tx.objectStore('kv').put('indexed-${host}', 'who');
  tx.oncomplete = () => { opened.result.close(); document.title = 'stored'; };
};
</script>`;

const READ = `<!doctype html><title>reading</title><script>
window.state = new Promise((resolve) => {
  const local = localStorage.getItem('who');
  const opened = indexedDB.open('proof');
  opened.onupgradeneeded = () => opened.transaction.abort();
  opened.onerror = () => resolve({ local, indexed: null });
  opened.onsuccess = () => {
    const db = opened.result;
    if (!db.objectStoreNames.contains('kv')) { db.close(); return resolve({ local, indexed: null }); }
    const got = db.transaction('kv').objectStore('kv').get('who');
    got.onsuccess = () => { db.close(); resolve({ local, indexed: got.result ?? null }); };
    got.onerror = () => { db.close(); resolve({ local, indexed: null }); };
  };
});
</script>`;

// One server answers for every name; the host header says which site a request is for.
const server = createServer((request, response) => {
  const host = (request.headers.host ?? '').split(':')[0] ?? '';
  const site = host === FORGOTTEN.host ? FORGOTTEN.site : host;
  if (request.url === '/sign-in') {
    response.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': [
        // Persistent cookies, as a real sign-in sets; a session cookie would not outlive a restart.
        `session=${secret(host)}; Domain=${site}; Path=/; HttpOnly; Max-Age=86400`,
        `pref=on; Path=/; Max-Age=86400`,
      ],
    });
    response.end(SIGN_IN(host));
    return;
  }
  if (request.url === '/read') {
    response.writeHead(200, {
      'content-type': 'text/html',
      'x-cookie': request.headers.cookie ?? '',
    });
    response.end(READ);
    return;
  }
  response.writeHead(404).end();
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const port = (server.address() as AddressInfo).port;
const url = (host: string, path: string) => `http://${host}:${port}${path}`;

/**
 * The worker's own launch options, with the network the sites need: the worker reaches the web
 * through its egress relay, which a proof of the profile does not need, so both names resolve
 * to the local server instead.
 */
function openProfile(profile: string): Promise<BrowserContext> {
  const { proxy: _relay, args, ...options } = worker.browserLaunchOptions(true);
  return chromium.launchPersistentContext(join(profile, 'chromium'), {
    ...options,
    args: [...args, '--host-resolver-rules=MAP *.example 127.0.0.1'],
  });
}

async function signIn(page: Page, host: string) {
  await page.goto(url(host, '/sign-in'));
  await page.waitForFunction("document.title === 'stored'", undefined, { timeout: 10_000 });
}

type Held = { cookie_header: string; local: string | null; indexed: string | null };

async function held(page: Page, host: string): Promise<Held> {
  const response = await page.goto(url(host, '/read'));
  const state = (await page.evaluate('window.state')) as Omit<Held, 'cookie_header'>;
  return { cookie_header: response?.headers()['x-cookie'] ?? '', ...state };
}

/** What the profile holds for both sites, read by opening it again as a new process would. */
async function readBack(profile: string) {
  const context = await openProfile(profile);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cookies = (await context.cookies()).map((cookie) => `${cookie.domain} ${cookie.name}`);
    return {
      cookies: cookies.sort(),
      forgotten: await held(page, FORGOTTEN.host),
      kept: await held(page, KEPT.host),
    };
  } finally {
    await context.close();
  }
}

const POLICY = { public_compartment: false, allowed_domains: [FORGOTTEN.site, KEPT.site] };

async function prove(state: 'running' | 'stopped') {
  const space = await mkdtemp(join(tmpdir(), `forget-proof-${state}-`));
  const options = { spaceId: `sp_${state}`, spaceRoot: space, launch: openProfile };
  try {
    const sessions = new worker.BrowserSessions(options);
    await sessions.lease('job_proof', POLICY);
    const page = sessions.page;
    if (!page) throw new Error('the lease opened no page');
    await signIn(page, FORGOTTEN.host);
    await signIn(page, KEPT.host);
    const before = {
      forgotten: await held(page, FORGOTTEN.host),
      kept: await held(page, KEPT.host),
    };
    let forgetter = sessions;
    if (state === 'stopped') {
      // The space's browser stops, and a worker that starts later signs out with none running.
      await sessions.close();
      forgetter = new worker.BrowserSessions(options);
    }
    const was_running = forgetter.context !== undefined;
    const result = await forgetter.forgetSite(FORGOTTEN.site);
    const still_running = forgetter.context !== undefined;
    await forgetter.close();
    return {
      state,
      was_running,
      still_running,
      before,
      result,
      after: await readBack(join(space, 'browser')),
    };
  } finally {
    await rm(space, { recursive: true, force: true });
  }
}

try {
  const proofs = [await prove('running'), await prove('stopped')];
  process.stdout.write(
    JSON.stringify({
      forgotten: { ...FORGOTTEN, secret: secret(FORGOTTEN.host) },
      kept: { ...KEPT, secret: secret(KEPT.host) },
      port,
      proofs,
    }),
  );
} finally {
  server.close();
}
