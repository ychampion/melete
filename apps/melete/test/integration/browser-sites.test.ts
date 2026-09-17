/**
 * The sites a space is signed in to, end to end: a person signs in by hand, the handback records
 * the site, and signing out clears the profile's cookies for it. Real Chromium, real Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { chromiumAvailable, chromiumMissingReason } from '../../src/workers/browser/available.ts';
import { type BrowserWorkerClient, BrowserWorkerPool } from '../../src/workers/browser/client.ts';
import type { BrowserCommandResult } from '../../src/workers/browser/controller.ts';
import type { LiveInput, LiveOpen } from '../../src/workers/browser/live-protocol.ts';
import { BrowserSessionService } from '../../src/workers/browser/routes.ts';
import { seedJob } from '../helpers/broker.ts';
import { SIGN_IN, SIGN_IN_POINTS, startSignInFixture } from '../helpers/browser-fixture.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const PASSWORD = 'a-long-enough-password';
/** The job's own site. The person's takeover reaches the identity provider through its scope. */
const FIXTURE_SITES = ['127.0.0.1'];

function handle() {
  if (!database) throw new Error('Postgres unavailable');
  return database;
}

const point = (part: { x: number; y: number }): LiveInput[] => [
  { k: 'down', ...part, button: 0, mods: 0, clicks: 1 },
  { k: 'up', ...part, button: 0, mods: 0, clicks: 1 },
];
const ENTER: LiveInput[] = [
  { k: 'key', down: true, key: 'Enter', code: 'Enter', vk: 13, mods: 0, text: '\r' },
  { k: 'key', down: false, key: 'Enter', code: 'Enter', vk: 13, mods: 0 },
];

if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
const suite = database && chromiumAvailable ? describe : describe.skip;

suite('the sites a space is signed in to', () => {
  let fixture: ReturnType<typeof startSignInFixture>;
  let root = '';
  let pool: BrowserWorkerPool;
  let sessions: BrowserSessionService;
  let app: ReturnType<typeof createApp>;
  let cookie = '';
  let memberCookie = '';
  let spaceId = '';
  let jobId = '';
  let sessionId = '';
  let epoch = 0;
  let worker: BrowserWorkerClient;

  const sessionCookie = (response: Response) => {
    const value = response.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session='));
    if (!value) throw new Error(`expected a session cookie (${response.status})`);
    return value;
  };
  const call = (
    path: string,
    options: { method?: string; body?: unknown; cookie?: string } = {},
  ): Promise<Response> =>
    Promise.resolve(
      app.request(path, {
        method: options.method ?? 'GET',
        headers: {
          Cookie: options.cookie ?? cookie,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
    );
  const command = (operation: unknown) =>
    worker.request<BrowserCommandResult>('/command', {
      session_id: sessionId,
      job_id: jobId,
      control_epoch: epoch,
      operation,
    });
  const control = async (operation: 'takeover' | 'handback') => {
    const response = await call(`/browser/sessions/${sessionId}/${operation}`, { method: 'POST' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { control_epoch: number };
    epoch = body.control_epoch;
  };
  const asked = (path: string) =>
    fixture.requests.filter((request) => request.site === 'app' && request.path === path);
  /** What the quiet page says about this browser, which is what its cookie decides. */
  const whoami = async () => {
    await command({ kind: 'observe' });
    const looked = await command({ kind: 'open', url: `${fixture.app}/whoami` });
    return {
      tree: looked.observation?.tree ?? '',
      cookie: asked('/whoami').at(-1)?.cookie ?? '',
    };
  };

  beforeAll(async () => {
    const { sql, db } = handle();
    fixture = startSignInFixture();
    root = await mkdtemp(join(tmpdir(), 'melete-browser-sites-'));
    pool = new BrowserWorkerPool({
      spacesRoot: root,
      allowLocalProcess: true,
      workerEntry: new URL('../helpers/browser-child.ts', import.meta.url),
      workerArguments: [fixture.app, fixture.idp, fixture.other],
    });
    sessions = new BrowserSessionService(sql, pool);
    app = createApp({
      db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      sql,
      browserSessions: sessions,
      checkDatabase: async () => 'ok',
    });
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.test', password: PASSWORD }),
    });
    expect(setup.status).toBe(201);
    cookie = sessionCookie(setup);
    const ownerId = ((await (await call('/me')).json()) as { owner: { id: string } }).owner.id;
    expect(
      (
        await call('/principals', {
          method: 'POST',
          body: { email: 'member@example.test', password: PASSWORD },
        })
      ).status,
    ).toBe(201);
    const signedIn = await app.request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.test', password: PASSWORD }),
    });
    memberCookie = sessionCookie(signedIn);
    const memberId = (
      (await (await call('/me', { cookie: memberCookie })).json()) as { owner: { id: string } }
    ).owner.id;

    const seeded = await seedJob(sql, {
      provider: 'web',
      constraints: { allowed_domains: FIXTURE_SITES },
    });
    spaceId = seeded.claims.space_id;
    jobId = seeded.claims.job_id;
    // A shared space the owner owns and the other person works in.
    await sql`update space set kind = 'shared', owner_principal_id = ${ownerId}
      where id = ${spaceId}`;
    await sql`update job set principal_id = ${ownerId} where id = ${jobId}`;
    await sql`insert into space_membership (principal_id, space_id, role, generation)
      values (${ownerId}, ${spaceId}, 'owner', 1), (${memberId}, ${spaceId}, 'member', 1)`;
    // Both sessions speak for the shared space, as a selected space does.
    for (const token of [cookie, memberCookie]) {
      const digest = createHash('sha256')
        .update(token.split('=')[1] ?? '')
        .digest('hex');
      await sql`update session set space_id = ${spaceId}, membership_generation = 1
        where token_hash = ${digest}`;
    }

    const leased = await sessions.lease({
      job_id: jobId,
      space_id: spaceId,
      idempotency_key: 'browser-sites',
      constraints: {
        public_compartment: false,
        allowed_domains: FIXTURE_SITES,
        deliverable: { kind: 'none' },
      },
    });
    sessionId = leased.session.id;
    epoch = leased.session.control_epoch;
    worker = leased.worker;
    await command({ kind: 'observe' });
    await command({ kind: 'open', url: `${fixture.app}/whoami` });
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
    await fixture?.close();
    await handle().close();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  test('a takeover that ends where nothing is signed in records nothing', async () => {
    await control('takeover');
    await control('handback');
    const rows = await handle()
      .sql`select domain from browser_site_profile where space_id = ${spaceId}`;
    expect(rows.map((row) => row.domain)).toEqual([]);
    expect(await (await call('/browser/sites')).json()).toEqual({ sites: [] });
  }, 60_000);

  test('a takeover that ends signed in records the site', async () => {
    await command({ kind: 'observe' });
    await command({ kind: 'open', url: `${fixture.app}/signin` }).catch(() => {});
    await control('takeover');
    const opened = (await (
      await call(`/browser/sessions/${sessionId}/live`, { method: 'POST' })
    ).json()) as LiveOpen;
    const live = opened.live_id;
    const stream = await call(`/browser/sessions/${sessionId}/live/frames?live_id=${live}`);
    const reader = stream.body?.getReader();
    let seen = '';
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const chunk = await reader?.read().catch(() => ({ done: true, value: undefined }));
        if (!chunk || chunk.done) break;
        seen += decoder.decode(chunk.value, { stream: true });
      }
    })();
    const send = (events: LiveInput[]) =>
      call(`/browser/sessions/${sessionId}/live/input`, {
        method: 'POST',
        body: { live_id: live, ack_through: 0, events },
      });
    const until = async (predicate: () => boolean, ms = 20_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !predicate()) await Bun.sleep(25);
      return predicate();
    };
    try {
      expect(await until(() => seen.includes('"type":"frame"'))).toBe(true);
      await send(point(SIGN_IN_POINTS.first_field));
      await send([{ k: 'text', text: SIGN_IN.password }]);
      await send(ENTER);
      expect(await until(() => fixture.requests.some((request) => request.path === '/otp'))).toBe(
        true,
      );
      await send(point(SIGN_IN_POINTS.first_field));
      await send([{ k: 'text', text: SIGN_IN.code }]);
      await send(ENTER);
      expect(await until(() => asked('/account').length > 0)).toBe(true);
    } finally {
      await reader?.cancel().catch(() => {});
      await pump;
    }
    // The person hands back on the account page, whose cookie the profile now holds.
    await control('handback');
    const listed = await call('/browser/sites');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      sites: [{ domain: '127.0.0.1', label: '127.0.0.1' }],
    });
  }, 120_000);

  test("a member of the space cannot list or remove the owner's signed-in sites", async () => {
    const { sql } = handle();
    for (const [path, method] of [
      ['/browser/sites', 'GET'],
      ['/browser/sites/127.0.0.1', 'DELETE'],
    ] as const) {
      const response = await call(path, { method, cookie: memberCookie });
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).not.toContain('127.0.0.1');
    }
    const rows = await sql`select domain from browser_site_profile where space_id = ${spaceId}`;
    expect(rows.map((row) => row.domain)).toEqual(['127.0.0.1']);
  }, 60_000);

  test('forgetting a site removes its cookies and the profile row', async () => {
    const { sql } = handle();
    // The agent looks at the site the person signed in to: the profile still carries the cookie.
    const before = await whoami();
    expect(before.cookie).toContain('session=signed-in');
    expect(before.tree).toContain('signed in');
    expect(before.tree).toContain('is remembered');
    // A second site is recorded, to show that signing out of one leaves the others alone.
    await sessions.sites.record(spaceId, 'other.example');

    const forgotten = await call('/browser/sites/127.0.0.1', { method: 'DELETE' });
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toEqual({ domain: '127.0.0.1', forgotten: true });
    const kept = await sql`select domain from browser_site_profile where space_id = ${spaceId}`;
    expect(kept.map((row) => row.domain)).toEqual(['other.example']);

    // The browser was closed to clear the profile, so the agent leases it again and looks: the
    // page no longer knows this browser, and the sign-in page is refused as it was at the start.
    const leased = await sessions.lease({
      job_id: jobId,
      space_id: spaceId,
      idempotency_key: 'browser-sites-after-forget',
      constraints: {
        public_compartment: false,
        allowed_domains: FIXTURE_SITES,
        deliverable: { kind: 'none' },
      },
    });
    sessionId = leased.session.id;
    epoch = leased.session.control_epoch;
    worker = leased.worker;
    const after = await whoami();
    expect(after.cookie).not.toContain('session=signed-in');
    expect(after.tree).toContain('signed out');
    expect(after.tree).toContain('not remembered');
    // The site the person had signed in to asks for a password again.
    const account = await command({ kind: 'open', url: `${fixture.app}/account` }).then(
      () => 'observed',
      (error: Error) => (error as Error & { reason?: string }).reason ?? error.message,
    );
    expect(account).toBe('sensitive_input_require_takeover');
    const refused = await call('/browser/sites/Not%20A%20Domain', { method: 'DELETE' });
    expect(refused.status).toBe(400);
  }, 120_000);

  test('forgetting a space removes its browser profile', async () => {
    const { sql } = handle();
    const profile = join(root, spaceId, 'browser');
    expect(existsSync(join(profile, 'chromium'))).toBe(true);
    await sessions.sites.record(spaceId, 'still.example');
    const held = await sql`select domain from browser_site_profile where space_id = ${spaceId}`;
    expect(held.map((row) => row.domain)).toContain('still.example');
    // Forgetting a space stops its worker and deletes the space root, the profile with it.
    await pool.close();
    await rm(join(root, spaceId), { recursive: true, force: true });
    await sql`delete from job where space_id = ${spaceId}`;
    await sql`delete from space where id = ${spaceId}`;
    expect(existsSync(profile)).toBe(false);
    const gone = await sql`select domain from browser_site_profile where space_id = ${spaceId}`;
    expect(gone.map((row) => row.domain)).toEqual([]);
  }, 60_000);
});
