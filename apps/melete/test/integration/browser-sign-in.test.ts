/**
 * Saved sign-ins in a real browser: the worker types a username, password and one-time code
 * into the exact saved site and nowhere else, and what comes back, to the connector and to the
 * agent, says what came of it and never what was typed. Real Chromium, loopback sites.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, HandOffReason, SignInOutcome } from '@melete/contracts';
import { runSignIn, type SignInVaultPort } from '../../src/connectors/browser-sign-in.ts';
import type { VaultRecord } from '../../src/connectors/sign-in-vault.ts';
import { currentCode, parseTotpInput, verifyTotp } from '../../src/connectors/totp.ts';
import type { ConnectorContext } from '../../src/connectors/types.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { type BrowserWorkerClient, BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import type { BrowserSession } from '../../src/workers/browser/sessions.ts';

const USERNAME = 'jo.rivera@example.com';
const PASSWORD = 'Planted-pässword-7f3a91';
const CODE_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const TOTP = parseTotpInput(CODE_SECRET);

type Seen = { site: 'site' | 'lookalike'; method: string; path: string; body: string };

const form = (action: string, fields: string, button = 'Sign in', extra = '') =>
  `<form method="post" action="${action}" style="display:flex;flex-direction:column;gap:8px;width:320px">${fields}<button type="submit">${button}</button></form>${extra}`;
const USER_FIELD =
  '<label for="u">Email</label><input id="u" name="email" type="email" autocomplete="username">';
const PASSWORD_FIELD =
  '<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password">';
const CODE_FIELD =
  '<label for="c">Verification code</label><input id="c" name="code" inputmode="numeric" autocomplete="one-time-code">';
const BOXES = Array.from(
  { length: 6 },
  (_, index) =>
    `<input name="d${index}" maxlength="1" inputmode="numeric" aria-label="Digit ${index + 1}" style="width:32px">`,
).join('');

function html(title: string, body: string, headers: Record<string, string> = {}) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title></head><body style="margin:24px;font:16px sans-serif"><h1>${title}</h1>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', ...headers } },
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
    const body = request.method === 'GET' ? '' : await request.text();
    seen.push({ site, method: request.method, path: url.pathname, body });
    return { url, fields: new URLSearchParams(body) };
  };
  const lookalike = Bun.serve({
    hostname: '127.0.0.2',
    port: 0,
    async fetch(request) {
      const { url } = await note('lookalike', request);
      if (url.pathname === '/login')
        return html('Sign in', form('/login', USER_FIELD + PASSWORD_FIELD));
      return html('Taken', '<p>Received.</p>');
    },
  });
  const away = lookalike.url.origin;
  const site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const { url, fields } = await note('site', request);
      const post = request.method === 'POST';
      const rightPassword = fields.get('email') === USERNAME && fields.get('password') === PASSWORD;
      switch (url.pathname) {
        case '/':
          return html('Home', '<p><a href="/login">Sign in</a></p>');
        case '/login':
          if (post && rightPassword) return go('/account', 'sid=signed-in');
          return html(
            'Sign in',
            (post ? '<p role="alert">That password isn’t right.</p>' : '') +
              form('/login', USER_FIELD + PASSWORD_FIELD),
          );
        case '/login-mfa':
          if (post && rightPassword) return go('/mfa');
          return html('Sign in', form('/login-mfa', USER_FIELD + PASSWORD_FIELD));
        case '/mfa':
          if (post && verifyTotp(TOTP, fields.get('code') ?? ''))
            return go('/account', 'sid=signed-in');
          return html('Two-step verification', form('/mfa', CODE_FIELD, 'Verify'));
        case '/login-boxes':
          if (post && rightPassword) return go('/mfa-boxes');
          return html('Sign in', form('/login-boxes', USER_FIELD + PASSWORD_FIELD));
        case '/mfa-boxes': {
          const typed = Array.from({ length: 6 }, (_, index) => fields.get(`d${index}`) ?? '').join(
            '',
          );
          if (post && verifyTotp(TOTP, typed)) return go('/account', 'sid=signed-in');
          return html('Enter the code', form('/mfa-boxes', BOXES, 'Verify'));
        }
        case '/login-sms':
          if (post && rightPassword) return go('/sms');
          return html('Sign in', form('/login-sms', USER_FIELD + PASSWORD_FIELD));
        case '/sms':
          return html('We texted you a code', form('/sms', CODE_FIELD, 'Verify'));
        case '/two-step':
          if (post && fields.get('email') === USERNAME) return go('/two-step/password');
          return html('Sign in', form('/two-step', USER_FIELD, 'Next'));
        case '/two-step/password':
          if (post && fields.get('password') === PASSWORD) return go('/account', 'sid=signed-in');
          return html('Enter your password', form('/two-step/password', PASSWORD_FIELD));
        case '/account':
          return html('Your account', '<p>Welcome back.</p>');
        case '/to-lookalike':
          return go(`${away}/login`);
        case '/cross-post':
          return html('Sign in', form(`${away}/steal`, USER_FIELD + PASSWORD_FIELD));
        case '/captcha':
          return html(
            'Sign in',
            form(
              '/login',
              USER_FIELD + PASSWORD_FIELD,
              'Sign in',
              '<div class="g-recaptcha" style="width:304px;height:78px;background:#ddd"></div>',
            ),
          );
        case '/script-login':
          // A page that answers in place and leaves the password in its field. Its Report
          // button, outside the form, shows how long the field's value is.
          return html(
            'Sign in',
            `${form('/script-login', USER_FIELD + PASSWORD_FIELD)}<p id="said"></p>
            <button type="button" id="report">Report</button><script>
              document.querySelector('form').addEventListener('submit', (event) => {
                event.preventDefault();
                document.getElementById('said').textContent = 'That password isn’t right.';
              });
              document.getElementById('report').addEventListener('click', () => {
                document.getElementById('said').textContent =
                  'Length ' + document.getElementById('p').value.length;
              });
            </script>`,
          );
        default:
          return new Response('not found', { status: 404 });
      }
    },
  });
  return {
    site: site.url.origin,
    away,
    seen,
    close: async () => {
      site.stop(true);
      lookalike.stop(true);
    },
  };
}

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
(chromiumAvailable ? describe : describe.skip)('saved sign-ins in Chromium', () => {
  let sites: ReturnType<typeof startSites>;
  let pool: BrowserWorkerPool;
  let worker: BrowserWorkerClient;
  let session: BrowserSession;
  let root = '';
  const JOB = 'job_sign_in';

  beforeAll(async () => {
    sites = startSites();
    root = await mkdtemp(join(tmpdir(), 'melete-browser-sign-in-'));
    pool = new BrowserWorkerPool({
      spacesRoot: root,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [sites.site, sites.away],
    });
    worker = await pool.get('sp_sign_in');
    session = await worker.lease(JOB, {
      public_compartment: false,
      allowed_domains: ['127.0.0.1', '127.0.0.2'],
    });
    await call({ kind: 'observe' });
  }, 30_000);

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
  const signIn = (path: string, extra: Record<string, unknown> = {}) =>
    call({
      kind: 'sign_in',
      origin: sites.site,
      url: `${sites.site}${path}`,
      username: USERNAME,
      password: PASSWORD,
      ...extra,
    });
  const outcome = (result: BrowserCommandResult) =>
    (result.result as { sign_in?: string } | undefined)?.sign_in;
  const posted = (site: Seen['site'], path: string) =>
    sites.seen.filter(
      (entry) => entry.site === site && entry.method === 'POST' && entry.path === path,
    );
  /** Nothing the worker answered carries what was typed. */
  const clean = (result: unknown) => {
    const text = JSON.stringify(result);
    for (const secret of [PASSWORD, USERNAME, CODE_SECRET])
      expect([secret, text.includes(secret)]).toEqual([secret, false]);
  };

  test('a username and password go to the saved site, and the answer carries neither', async () => {
    const result = await signIn('/login');
    expect(outcome(result)).toBe('signed_in');
    expect(Object.keys(result).sort()).toEqual(['control_epoch', 'result', 'session_id']);
    clean(result);
    const sent = new URLSearchParams(posted('site', '/login').at(-1)?.body ?? '');
    expect(sent.get('email')).toBe(USERNAME);
    expect(sent.get('password')).toBe(PASSWORD);
    // The look after it is an ordinary one, and the password is nowhere on the page.
    const looked = await call({ kind: 'observe' });
    expect(looked.observation?.tree).toContain('Your account');
    clean(looked.observation?.tree);
  }, 40_000);

  test('a password the site refuses is said so', async () => {
    const result = await call({
      kind: 'sign_in',
      origin: sites.site,
      url: `${sites.site}/login`,
      username: USERNAME,
      password: 'not-the-password',
    });
    expect(outcome(result)).toBe('not_accepted');
  }, 40_000);

  test('a site that asks for the username first gets the password on its next page', async () => {
    const result = await signIn('/two-step');
    expect(outcome(result)).toBe('signed_in');
    expect(posted('site', '/two-step/password')).toHaveLength(1);
  }, 40_000);

  test('a one-time code goes in when the site asks for it, into one field or into digit boxes', async () => {
    const asked = await signIn('/login-mfa');
    expect(outcome(asked)).toBe('code_asked');
    const code = currentCode(TOTP).code;
    const done = await call({ kind: 'sign_in_code', origin: sites.site, code });
    expect(outcome(done)).toBe('signed_in');
    clean(done);
    expect(JSON.stringify(done)).not.toContain(code);

    expect(outcome(await signIn('/login-boxes'))).toBe('code_asked');
    const boxes = await call({
      kind: 'sign_in_code',
      origin: sites.site,
      code: currentCode(TOTP).code,
    });
    expect(outcome(boxes)).toBe('signed_in');
  }, 60_000);

  test('a redirect to a lookalike site is never typed into', async () => {
    const before = sites.seen.length;
    const result = await signIn('/to-lookalike');
    expect(outcome(result)).toBe('wrong_site');
    expect((result.result as { at?: string }).at).toBe(sites.away);
    const after = sites.seen.slice(before);
    expect(after.some((entry) => entry.site === 'lookalike' && entry.path === '/login')).toBe(true);
    expect(after.filter((entry) => entry.method === 'POST')).toEqual([]);
  }, 40_000);

  test('a sign-in page on another site is refused before anything is opened', async () => {
    const before = sites.seen.length;
    const result = await call({
      kind: 'sign_in',
      origin: sites.site,
      url: `${sites.away}/login`,
      username: USERNAME,
      password: PASSWORD,
    });
    expect(outcome(result)).toBe('wrong_site');
    expect(sites.seen.slice(before).filter((entry) => entry.site === 'lookalike')).toEqual([]);
  }, 40_000);

  test('a form that would send the password to another site is stopped', async () => {
    const before = sites.seen.length;
    const result = await signIn('/cross-post');
    expect(outcome(result)).toBe('wrong_site');
    const after = sites.seen.slice(before);
    expect(after.filter((entry) => entry.site === 'lookalike')).toEqual([]);
    for (const entry of after) expect(entry.body).not.toContain('Planted');
  }, 40_000);

  test('a page with a person check is left for the person, with nothing sent', async () => {
    const before = sites.seen.length;
    expect(outcome(await signIn('/captcha'))).toBe('captcha');
    expect(sites.seen.slice(before).filter((entry) => entry.method === 'POST')).toEqual([]);
  }, 40_000);

  test('plain http is refused for a site that is not a test fixture', async () => {
    const result = await call({
      kind: 'sign_in',
      origin: 'http://example.com',
      username: USERNAME,
      password: PASSWORD,
    });
    expect(outcome(result)).toBe('insecure_site');
  }, 20_000);

  test('a page with no sign-in form says so', async () => {
    await call({ kind: 'open', url: `${sites.site}/account` });
    expect(outcome(await signIn('/account'))).toBe('form_not_found');
  }, 40_000);

  test('a password left in a field the site did not clear is cleared', async () => {
    const result = await signIn('/script-login');
    expect(outcome(result)).toBe('not_accepted');
    // The site left the password in its field; the step emptied it before it answered.
    await call({ kind: 'observe' });
    await call({ kind: 'click', role: 'button', name: 'Report' });
    const said = await call({ kind: 'read', selector: '#said' });
    expect((said.result as { text?: string }).text).toBe('Length 0');
  }, 40_000);

  test('through the connector, the agent hears it signed in and nothing more', async () => {
    const uses: SignInOutcome[] = [];
    const handOffs: HandOffReason[] = [];
    const record: VaultRecord = {
      id: 'ssi_01JZ0000000000000000000000',
      spaceId: 'sp_sign_in',
      principalId: 'pr_01',
      origin: sites.site,
      label: 'Fixture site',
      username: USERNAME,
      secretRef: 'sec_01',
      keyId: 'k1:0',
      hasCode: true,
      policy: 'whenever_needed',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: null,
      lastOutcome: null,
    };
    const vault = {
      principalOf: async () => 'pr_01',
      get: async () => record,
      withCredential: async (_record, use) =>
        use({ username: USERNAME, password: PASSWORD, totp: TOTP }),
      recordUse: async (_record, use) => {
        uses.push(use.outcome);
      },
    } as Partial<SignInVaultPort> as SignInVaultPort;
    const action = {
      id: 'act_sign_in',
      kind: 'browser.sign_in',
      connection_id: 'conn_01',
      canonical_payload: {
        site: '127.0.0.1',
        url: `${sites.site}/login-mfa`,
        sign_in_id: record.id,
        saved: {
          origin: sites.site,
          label: record.label,
          account: 'j***@…',
          ask_first: false,
          has_code: true,
        },
      },
    } as unknown as Action;
    const ctx = {
      job_id: JOB,
      space_id: 'sp_sign_in',
      idempotency_key: 'sign-in',
      constraints: { public_compartment: false, allowed_domains: ['127.0.0.1'] },
    } as unknown as ConnectorContext;
    const logged: string[] = [];
    const originals = { log: console.log, warn: console.warn, error: console.error };
    for (const name of ['log', 'warn', 'error'] as const)
      console[name] = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    let result: Awaited<ReturnType<typeof runSignIn>>;
    try {
      result = await runSignIn({
        vault,
        action,
        ctx,
        lease: async () => ({ session, worker, opened: false }),
        handOff: async (_ctx, _session, reason) => {
          handOffs.push(reason);
        },
      });
    } finally {
      Object.assign(console, originals);
    }
    expect(result.outcome).toBe('succeeded');
    const detail = result.outcome === 'succeeded' ? result.receipt.detail : {};
    expect(detail).toMatchObject({ account: 'j***@…', outcome: 'signed_in' });
    expect(String(detail.note)).toBe(`Signed in as j***@… on ${new URL(sites.site).host}.`);
    expect(uses).toEqual(['signed_in']);
    expect(handOffs).toEqual([]);
    const surfaces = JSON.stringify({ result, logged });
    for (const secret of [PASSWORD, USERNAME, CODE_SECRET, currentCode(TOTP).code])
      expect([secret, surfaces.includes(secret)]).toEqual([secret, false]);
  }, 60_000);

  test('a code the vault does not have hands the browser to the person', async () => {
    const handOffs: HandOffReason[] = [];
    const record = {
      id: 'ssi_01JZ0000000000000000000001',
      spaceId: 'sp_sign_in',
      principalId: 'pr_01',
      origin: sites.site,
      label: 'Fixture site',
      username: USERNAME,
      secretRef: 'sec_02',
      keyId: 'k1:0',
      hasCode: false,
      policy: 'whenever_needed',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastUsedAt: null,
      lastOutcome: null,
    } satisfies VaultRecord;
    const vault = {
      principalOf: async () => 'pr_01',
      get: async () => record,
      withCredential: async (_record, use) =>
        use({ username: USERNAME, password: PASSWORD, totp: null }),
      recordUse: async () => {},
    } as Partial<SignInVaultPort> as SignInVaultPort;
    const result = await runSignIn({
      vault,
      action: {
        id: 'act_sms',
        kind: 'browser.sign_in',
        connection_id: 'conn_01',
        canonical_payload: {
          site: '127.0.0.1',
          url: `${sites.site}/login-sms`,
          sign_in_id: record.id,
          saved: {
            origin: sites.site,
            label: record.label,
            account: 'j***@…',
            ask_first: false,
            has_code: false,
          },
        },
      } as unknown as Action,
      ctx: { job_id: JOB, space_id: 'sp_sign_in' } as unknown as ConnectorContext,
      lease: async () => ({ session, worker, opened: false }),
      handOff: async (_ctx, _session, reason) => {
        handOffs.push(reason);
      },
    });
    expect(result.outcome).toBe('succeeded');
    expect(handOffs).toEqual(['two_factor']);
    const detail = result.outcome === 'succeeded' ? result.receipt.detail : {};
    expect(detail).toMatchObject({ outcome: 'needs_code', handed_to: 'person' });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  }, 60_000);
});
