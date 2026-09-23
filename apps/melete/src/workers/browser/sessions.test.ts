import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromiumAvailable, chromiumMissingReason } from './available.ts';
import { BrowserWorkerPool, browserWorkerEnvironment } from './client.ts';
import { startBrowserServer } from './server.ts';
import { BrowserSessions, browserLaunchOptions } from './sessions.ts';

test('worker receives OS essentials without database, vault or provider credentials', () => {
  expect(
    browserWorkerEnvironment({
      PATH: 'bin',
      DATABASE_URL: 'secret',
      MELETE_MASTER_KEY: 'vault',
      FIREWORKS_API_KEY: 'key',
      MELETE_CAPABILITY_KEY: 'cap',
    }),
  ).toEqual({ PATH: 'bin' });
});

test('going back never brings a document out of a back-forward cache', async () => {
  // A handed-back page stays filtered until automation loads a new document. Going back must
  // fetch again, through the network guard, rather than restore a cached one. Playwright turns
  // the back-forward cache off in the switches it launches Chromium with, and the worker keeps
  // those defaults.
  expect('ignoreDefaultArgs' in browserLaunchOptions()).toBe(false);
  expect(browserLaunchOptions().args.join(' ')).not.toContain('back-forward-cache');
  const core = dirname(
    Bun.resolveSync(
      'playwright-core/package.json',
      dirname(Bun.resolveSync('playwright', import.meta.dir)),
    ),
  );
  expect(await readFile(join(core, 'lib', 'coreBundle.js'), 'utf8')).toContain(
    '"--disable-back-forward-cache"',
  );
});

const suite = chromiumAvailable ? describe : describe.skip;
if (!chromiumAvailable) test.todo(chromiumMissingReason, () => {});
suite('browser session lease', () => {
  const rootPromise = mkdtemp(join(tmpdir(), 'melete-browser-session-'));
  const sessions: BrowserSessions[] = [];
  afterAll(async () => {
    await Promise.all(sessions.map((session) => session.close()));
  });
  test('a warm Chromium and confined profile survive repeated leases and retire after idle', async () => {
    const pool = new BrowserWorkerPool({
      spacesRoot: await rootPromise,
      allowLocalProcess: true,
      idleMs: 1000,
    });
    try {
      const client = await pool.get('sp_fixture');
      const policy = { public_compartment: false, allowed_domains: ['example.com'] };
      const first = await client.lease('job_fixture', policy);
      expect((await client.lease('job_fixture', policy)).id).toBe(first.id);
      expect(first.profile_dir).toBe(join(await rootPromise, 'sp_fixture', 'browser'));
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const second = await client.lease('job_next', policy);
      expect(second.id).not.toBe(first.id);
      expect(second.control_epoch).toBeGreaterThan(first.control_epoch);
      expect(
        JSON.parse(await readFile(join(first.profile_dir, 'session.json'), 'utf8')).job_id,
      ).toBe('job_next');
    } finally {
      await pool.close();
    }
  }, 20_000);
  test("a development child is given the person's idle window", async () => {
    const pool = new BrowserWorkerPool({
      spacesRoot: await rootPromise,
      allowLocalProcess: true,
      idleMs: 1000,
      humanIdleMs: 1500,
    });
    try {
      const client = await pool.get('sp_human_idle');
      const policy = { public_compartment: false, allowed_domains: ['example.com'] };
      const first = await client.lease('job_signing_in', policy);
      await client.takeover(first.id);
      // With the fifteen-minute default the idle person's takeover would still hold the lease.
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const next = await client.lease('job_after', policy);
      expect(next.id).not.toBe(first.id);
    } finally {
      await pool.close();
    }
  }, 20_000);

  test('private worker HTTP refuses missing token and arbitrary routes', async () => {
    const manager = new BrowserSessions({ spaceId: 'sp_http', spaceRoot: await rootPromise });
    sessions.push(manager);
    const server = await startBrowserServer({ sessions: manager, token: 't'.repeat(40) });
    try {
      expect((await fetch(new URL('/health', server.url))).status).toBe(401);
      expect(
        (
          await fetch(new URL('/anything', server.url), {
            headers: { authorization: `Bearer ${'t'.repeat(40)}` },
          })
        ).status,
      ).toBe(405);
    } finally {
      await server.stop(true);
    }
  });
  test('service starts a separate worker process and stops it', async () => {
    const pool = new BrowserWorkerPool({ spacesRoot: await rootPromise, allowLocalProcess: true });
    try {
      const client = await pool.get('sp_child');
      expect(await client.request<{ status: string }>('/health')).toEqual({ status: 'ok' });
    } finally {
      await pool.close();
    }
  }, 15_000);
});
