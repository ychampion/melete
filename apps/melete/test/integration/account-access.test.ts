/**
 * Getting into an installation and ending access to it, against Postgres:
 * claiming a new installation with its setup code, sign-in and reset links
 * through the installation's own mail sender, the operator's account
 * commands, signing out everywhere, and the access guard answering before
 * the file and app routes.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAccount } from '../../src/account/cli.ts';
import { purgeExpiredAccess } from '../../src/api/account-access.ts';
import { issueSetupCode, newSetupCode, setupCodeHash } from '../../src/api/setup-code.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { loadEnv } from '../../src/env.ts';
import type { AccountMail } from '../../src/experience/account-mail.ts';
import { createApp } from '../../src/index.ts';
import { generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const describeWithDb = handle ? describe : describe.skip;
const OWNER = 'owner@example.test';
const PASSWORD = 'a-good-long-password';
const PUBLIC_URL = 'https://melete.example.test';

function database() {
  if (!handle) throw new Error('Postgres is unavailable');
  return handle;
}

const vapid = await generateVapidKeys();
// Spaces and work files go in a folder of this run's own, never the service's default.
const files = mkdtempSync(join(tmpdir(), 'melete-account-access-'));

function app(options: { env?: Record<string, string>; mail?: AccountMail[] } = {}) {
  const mail = options.mail;
  return createApp({
    env: loadEnv({
      NODE_ENV: 'test',
      MELETE_PUBLIC_URL: PUBLIC_URL,
      MELETE_SPACES_DIR: join(files, 'spaces'),
      MELETE_WORK_DIR: join(files, 'work'),
      MELETE_VAPID_PUBLIC_KEY: vapid.publicKey,
      MELETE_VAPID_PRIVATE_KEY: vapid.privateKey,
      MELETE_VAPID_SUBJECT: 'mailto:owner@example.test',
      ...options.env,
    }),
    db: database().db,
    sql: database().sql,
    registry: new ConnectorRegistry(),
    ...(mail
      ? {
          accountMail: {
            send: async (message: AccountMail) => {
              mail.push(message);
            },
          },
        }
      : {}),
    checkDatabase: async () => 'ok',
  });
}

type Api = ReturnType<typeof app>;

const send = (method: string, body?: object, cookie?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const json = (body: object, cookie?: string) => send('POST', body, cookie);
const as = (cookie: string, method = 'GET', body?: object) => send(method, body, cookie);
const cookieOf = (response: Response) => {
  const value = response.headers.get('set-cookie')?.split(';')[0];
  if (!value) throw new Error(`No session cookie was set (${response.status})`);
  return value;
};
const codeOf = async (response: Response) =>
  ((await response.json()) as { error?: { code?: string } }).error?.code;

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let tries = 0; tries < 150; tries++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error('Timed out waiting');
};

/** The link in a mail, and the token its fragment carries for the web app. */
const linkIn = (mail: AccountMail | undefined, route: 'welcome' | 'reset') => {
  const url = mail?.text.match(/https:\/\/\S+/)?.[0];
  if (!url) throw new Error('No link in the mail');
  const parsed = new URL(url);
  expect(parsed.origin).toBe(PUBLIC_URL);
  expect(parsed.hash).toMatch(new RegExp(`^#/${route}\\?token=[A-Za-z0-9_-]+$`));
  const token = new URLSearchParams(parsed.hash.split('?')[1]).get('token');
  if (!token) throw new Error('No token in the link');
  return token;
};

async function claim(api: Api, extra: object = {}) {
  const setup = await api.request('/setup', json({ email: OWNER, password: PASSWORD, ...extra }));
  expect(setup.status).toBe(201);
  return cookieOf(setup);
}

const login = async (api: Api, email: string, password: string) =>
  cookieOf(await api.request('/login', json({ email, password })));

describeWithDb('account access', () => {
  beforeEach(async () => {
    await resetTestRows(database().sql);
    await database().sql`delete from setup_code`;
  }, 15_000);
  afterAll(async () => {
    await handle?.close();
    rmSync(files, { recursive: true, force: true });
  });

  describe('claiming a new installation', () => {
    test('an installation made with a setup code takes the first account only with it', async () => {
      const code = newSetupCode();
      const api = app({ env: { MELETE_SETUP_CODE_HASH: setupCodeHash(code) } });
      const status = (await (await api.request('/setup')).json()) as Record<string, unknown>;
      expect(status).toMatchObject({ needed: true, code_required: true });

      const without = await api.request('/setup', json({ email: OWNER, password: PASSWORD }));
      expect(without.status).toBe(403);
      expect(await codeOf(without)).toBe('setup_code_required');
      const wrong = await api.request(
        '/setup',
        json({ email: OWNER, password: PASSWORD, setup_code: newSetupCode() }),
      );
      expect(wrong.status).toBe(403);
      expect(await codeOf(wrong)).toBe('invalid_setup_code');
      // A weak password is refused before the code is looked at, so it costs nothing.
      const weak = await api.request(
        '/setup',
        json({ email: OWNER, password: 'password123', setup_code: code }),
      );
      expect(weak.status).toBe(400);
      expect(await codeOf(weak)).toBe('weak_password');
      expect(await database().sql`select 1 from owner`).toHaveLength(0);

      // Typed loosely: lower case, without its dashes.
      const cookie = await claim(api, { setup_code: code.toLowerCase().replaceAll('-', '') });
      expect((await api.request('/me', as(cookie))).status).toBe(200);
      expect(await (await api.request('/setup')).json()).toMatchObject({
        needed: false,
        code_required: false,
      });
    });

    test('without a code configured, a local install is claimed as before', async () => {
      const api = app();
      expect(await (await api.request('/setup')).json()).toMatchObject({
        needed: true,
        code_required: false,
      });
      await claim(api);
    });

    test('a code the operator issued works once, and replaces the one before it', async () => {
      const api = app();
      const first = await issueSetupCode(database().sql);
      const second = await issueSetupCode(database().sql);
      if (!first || !second) throw new Error('No setup code was issued');
      expect(await (await api.request('/setup')).json()).toMatchObject({ code_required: true });
      const stale = await api.request(
        '/setup',
        json({ email: OWNER, password: PASSWORD, setup_code: first.code }),
      );
      expect(await codeOf(stale)).toBe('invalid_setup_code');
      await claim(api, { setup_code: second.code });
      // Once the owner exists there is nothing left to claim.
      expect(await issueSetupCode(database().sql)).toBeNull();
    });
  });

  describe('mail from the installation', () => {
    test('a sign-in link opens the sign-in screen with its token, and signs in once', async () => {
      const mail: AccountMail[] = [];
      const api = app({ mail });
      await claim(api);
      expect(await (await api.request('/setup')).json()).toMatchObject({ email_sign_in: true });
      expect((await api.request('/signin/magic-link', json({ email: OWNER }))).status).toBe(200);
      await until(() => mail.length === 1);
      expect(mail[0]?.to).toBe(OWNER);
      const token = linkIn(mail[0], 'welcome');
      const used = await api.request('/signin/magic-link/consume', json({ token }));
      expect(used.status).toBe(200);
      expect((await api.request('/me', as(cookieOf(used)))).status).toBe(200);
      expect((await api.request('/signin/magic-link/consume', json({ token }))).status).toBe(400);
      // An address with no account gets the same answer, and no mail.
      expect(
        (await api.request('/signin/magic-link', json({ email: 'nobody@example.test' }))).status,
      ).toBe(200);
      await Bun.sleep(100);
      expect(mail).toHaveLength(1);
    });

    test('a person with no mailbox connected resets their password by mail', async () => {
      const mail: AccountMail[] = [];
      const api = app({ mail });
      const owner = await claim(api);
      const person = 'person@example.test';
      const made = await runAccount(database().sql, ['create', person, '--json'], PUBLIC_URL);
      expect(made.code).toBe(0);
      const invite = JSON.parse(made.out) as { link: string; owner: boolean };
      expect(invite.owner).toBe(false);
      expect(new URL(invite.link).hash).toMatch(/^#\/reset\?token=/);
      const inviteToken = new URLSearchParams(new URL(invite.link).hash.split('?')[1]).get('token');
      expect(
        (await api.request('/password-reset/check', json({ token: inviteToken ?? '' }))).status,
      ).toBe(200);
      expect(
        (
          await api.request(
            '/password-reset/consume',
            json({ token: inviteToken, new_password: 'first-person-password' }),
          )
        ).status,
      ).toBe(200);
      const before = await login(api, person, 'first-person-password');

      expect((await api.request('/password-reset', json({ email: person }))).status).toBe(200);
      await until(() => mail.length === 1);
      expect(mail[0]?.to).toBe(person);
      const token = linkIn(mail[0], 'reset');
      // A mistyped code is caught when it is checked, before a password is chosen.
      const typo = await api.request(
        '/password-reset/check',
        json({ token: `${token.slice(0, -2)}xx` }),
      );
      expect(typo.status).toBe(400);
      expect(await codeOf(typo)).toBe('invalid_reset_link');
      expect((await api.request('/password-reset/check', json({ token }))).status).toBe(200);
      expect(
        (
          await api.request(
            '/password-reset/consume',
            json({ token, new_password: 'second-person-password' }),
          )
        ).status,
      ).toBe(200);
      expect((await api.request('/me', as(before))).status).toBe(401);
      await login(api, person, 'second-person-password');
      // The owner's own sign-in is untouched.
      expect((await api.request('/me', as(owner))).status).toBe(200);
    });
  });

  describe('signing out everywhere', () => {
    /** A browser subscribed to the account's notifications, through the route a browser uses. */
    async function subscribe(api: Api, cookie: string) {
      const keys = await generateVapidKeys();
      const response = await api.request(
        '/push/subscriptions',
        as(cookie, 'POST', {
          endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
          keys: {
            p256dh: keys.publicKey,
            auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
          },
          device_label: 'Phone · Chrome',
        }),
      );
      expect(response.status).toBe(201);
    }

    /** A connected assistant's token and an unused code, as the MCP sign-in leaves them. */
    async function assistant(principalId: string) {
      const { sql } = database();
      const [space] = await sql`select id from space where owner_principal_id = ${principalId}
        and kind = 'personal' limit 1`;
      const client = `mcpc_${crypto.randomUUID()}`;
      await sql`insert into mcp_client (id, name, redirect_uris)
        values (${client}, 'Desk assistant', '["http://127.0.0.1:9/cb"]'::jsonb)`;
      await sql`insert into mcp_token (token_hash, kind, family, client_id, principal_id, space_id,
          resource, scope, expires_at)
        values (${crypto.randomUUID()}, 'access', ${crypto.randomUUID()}, ${client}, ${principalId}, ${space?.id},
          ${`${PUBLIC_URL}/mcp`}, 'melete', now() + interval '1 hour')`;
    }

    async function access(api: Api, cookie: string) {
      const response = await api.request('/account/sessions', as(cookie));
      expect(response.status).toBe(200);
      return (await response.json()) as {
        sessions: { id: string; current: boolean; label: string }[];
        notifications: unknown[];
        assistants: { client: string }[];
        computers: unknown[];
      };
    }

    test('ends every other browser, assistant, notification and pairing code, and keeps this one', async () => {
      const api = app();
      const here = await claim(api);
      const { sql } = database();
      const [me] = await sql`select id from principal where email = ${OWNER}`;
      const principalId = String(me?.id);
      const phone = await login(api, OWNER, PASSWORD);
      await subscribe(api, phone);
      await assistant(principalId);
      const pairing = await api.request(
        '/devices/pairings',
        as(here, 'POST', {
          capabilities: {
            commands: false,
            files: true,
            open_url: true,
            screenshot: false,
          },
        }),
      );

      const listed = await access(api, here);
      expect(listed.sessions).toHaveLength(2);
      expect(listed.sessions.filter((session) => session.current)).toHaveLength(1);
      expect(listed.notifications).toHaveLength(1);
      expect(listed.assistants.map((entry) => entry.client)).toEqual(['Desk assistant']);

      const ended = await api.request('/account/sessions/revoke-others', as(here, 'POST'));
      expect(ended.status).toBe(200);
      expect((await api.request('/me', as(here))).status).toBe(200);
      expect((await api.request('/me', as(phone))).status).toBe(401);
      expect(await sql`select 1 from push_subscription`).toHaveLength(0);
      expect(
        await sql`select 1 from mcp_token where principal_id = ${principalId} and revoked_at is null`,
      ).toHaveLength(0);
      expect(pairing.status).toBe(201);
      expect(
        await sql`select 1 from device_pairing where principal_id = ${principalId}
          and used_at is null`,
      ).toHaveLength(0);
      const after = await access(api, here);
      expect(after.sessions.map((session) => session.current)).toEqual([true]);
      expect(after.notifications).toHaveLength(0);
      expect(after.assistants).toHaveLength(0);
    });

    test('one browser is signed out from another, and the list shows where', async () => {
      const api = app();
      const here = await claim(api);
      const laptop = cookieOf(
        await api.request('/login', {
          ...json({ email: OWNER, password: PASSWORD }),
          headers: {
            'Content-Type': 'application/json',
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
          },
        }),
      );
      const listed = await access(api, here);
      const other = listed.sessions.find((session) => !session.current);
      expect(other?.label).toBe('Safari on Mac');
      expect((await api.request(`/account/sessions/${other?.id}`, as(here, 'DELETE'))).status).toBe(
        200,
      );
      expect((await api.request('/me', as(laptop))).status).toBe(401);
      expect((await api.request(`/account/sessions/${other?.id}`, as(here, 'DELETE'))).status).toBe(
        404,
      );
    });

    test('a new password ends the notifications and assistants too, apart from this browser', async () => {
      const api = app();
      const here = await claim(api);
      const [me] = await database().sql`select id from principal where email = ${OWNER}`;
      await subscribe(api, here);
      await assistant(String(me?.id));
      const changed = await api.request(
        '/account/password',
        as(here, 'POST', { current_password: PASSWORD, new_password: 'another-long-password' }),
      );
      expect(changed.status).toBe(200);
      expect((await api.request('/me', as(here))).status).toBe(200);
      const after = await access(api, here);
      expect(after.notifications).toHaveLength(0);
      expect(after.assistants).toHaveLength(0);
      const weak = await api.request(
        '/account/password',
        as(here, 'POST', {
          current_password: 'another-long-password',
          new_password: 'qwertyuiop',
        }),
      );
      expect(weak.status).toBe(400);
      expect(await codeOf(weak)).toBe('weak_password');
    });

    test('a disabled account cannot sign in or use a session, and can be enabled again', async () => {
      const api = app();
      await claim(api);
      const person = 'leaving@example.test';
      const made = JSON.parse(
        (await runAccount(database().sql, ['create', person, '--json'], PUBLIC_URL)).out,
      ) as { code: string };
      await api.request(
        '/password-reset/consume',
        json({ token: made.code, new_password: 'leaving-person-password' }),
      );
      const session = await login(api, person, 'leaving-person-password');
      expect((await api.request('/me', as(session))).status).toBe(200);

      expect((await runAccount(database().sql, ['disable', person], PUBLIC_URL)).code).toBe(0);
      expect((await api.request('/me', as(session))).status).toBe(401);
      expect(
        (await api.request('/login', json({ email: person, password: 'leaving-person-password' })))
          .status,
      ).toBe(401);
      const listed = JSON.parse(
        (await runAccount(database().sql, ['list', '--json'], PUBLIC_URL)).out,
      ) as { accounts: { email: string; kind: string; disabled: boolean }[] };
      expect(listed.accounts.map((a) => [a.email, a.kind, a.disabled])).toEqual([
        [OWNER, 'owner', false],
        [person, 'person', true],
      ]);

      expect((await runAccount(database().sql, ['enable', person], PUBLIC_URL)).code).toBe(0);
      await login(api, person, 'leaving-person-password');
      expect((await runAccount(database().sql, ['create', person], PUBLIC_URL)).code).toBe(1);
    });

    test('the sweep removes what has expired and keeps what still works', async () => {
      const api = app();
      const here = await claim(api);
      const { sql } = database();
      const stale = await login(api, OWNER, PASSWORD);
      await sql`update session set expires_at = now() - interval '1 minute'
        where token_hash = ${new Bun.CryptoHasher('sha256').update(stale.split('=')[1] ?? '').digest('hex')}`;
      expect(await purgeExpiredAccess(sql)).toBeGreaterThanOrEqual(1);
      expect(await sql`select 1 from session`).toHaveLength(1);
      expect((await api.request('/me', as(here))).status).toBe(200);
    });
  });

  describe('the access guard', () => {
    test('answers before the file and app routes, for a space or job that is not the caller’s', async () => {
      const api = app();
      const owner = await claim(api);
      // Something of the owner's to ask for: their personal space.
      expect((await api.request('/me', as(owner))).status).toBe(200);
      const { sql } = database();
      const [ownersSpace] = await sql`select s.id from space s join principal p
        on p.id = s.owner_principal_id where p.email = ${OWNER} and s.kind = 'personal'`;
      const spaceId = String(ownersSpace?.id);
      const person = 'other@example.test';
      const made = JSON.parse(
        (await runAccount(sql, ['create', person, '--json'], PUBLIC_URL)).out,
      ) as { code: string };
      await api.request(
        '/password-reset/consume',
        json({ token: made.code, new_password: 'other-person-password' }),
      );
      const other = await login(api, person, 'other-person-password');
      const foreign = (path: string) =>
        api.request(path, {
          headers: { Cookie: other, 'x-melete-space': spaceId },
        });
      for (const path of [
        '/apps',
        '/artifacts/art_00000000000000000000000000/content',
        '/screenshots/shot_00000000000000000000000000',
      ]) {
        const response = await foreign(path);
        expect([path, response.status]).toEqual([path, 403]);
      }
      const byQuery = await api.request(`/apps?space_id=${spaceId}`, as(other));
      expect(byQuery.status).toBe(403);
      // Their own requests still answer.
      expect((await api.request('/apps', as(other))).status).toBe(200);
    });

    test('knowledge and skills default to the caller’s own space once there are two accounts', async () => {
      const api = app();
      const owner = await claim(api);
      expect((await api.request('/me', as(owner))).status).toBe(200);
      const made = JSON.parse(
        (await runAccount(database().sql, ['create', 'second@example.test', '--json'], PUBLIC_URL))
          .out,
      ) as { code: string };
      await api.request(
        '/password-reset/consume',
        json({ token: made.code, new_password: 'second-person-password' }),
      );
      const second = await login(api, 'second@example.test', 'second-person-password');
      for (const cookie of [owner, second])
        for (const path of ['/skills', '/knowledge'])
          expect([path, (await api.request(path, as(cookie))).status]).toEqual([path, 200]);
    });

    test('a space is described without where it is kept on disk', async () => {
      const api = app();
      const owner = await claim(api);
      const listed = (await (await api.request('/spaces', as(owner))).json()) as {
        spaces: Record<string, unknown>[];
      };
      expect(listed.spaces.length).toBeGreaterThan(0);
      for (const space of listed.spaces) expect(space).not.toHaveProperty('git_path');
    });
  });
});
