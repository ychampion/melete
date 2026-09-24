/**
 * Two presses that arrive together.
 *
 * `companies-surface.test.ts` presses "Handle it" twice in a row and starts a
 * scan after the last one finished. A person double-clicking, or a page that
 * retries, sends the second request while the first is still working, and that
 * is the case these tests hold: the second press has to see the first, not the
 * state from before it.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyMap } from '@melete/contracts';
import { fixtureMessages } from '../../src/companies/fixtures.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-companies-races-'));
const password = 'a-long-enough-password';

/** Scans run to completion unless a test holds them, the way a detached scan would be. */
let holdScans = false;
const heldScans: (() => Promise<void>)[] = [];
let handlerCalls = 0;

/**
 * Waits for a second arrival, or gives up after a while. Two requests that are
 * both inside the same step meet here and go on together, which is exactly the
 * interleaving a doubled click produces; a request that is alone in the step
 * waits out the timeout and goes on by itself.
 */
function meeting(ms = 1500) {
  let waiting: (() => void) | null = null;
  return () =>
    new Promise<void>((resolve) => {
      if (waiting) {
        waiting();
        waiting = null;
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        waiting = null;
        resolve();
      }, ms);
      waiting = () => {
        clearTimeout(timer);
        resolve();
      };
    });
}
const insideHandler = meeting();
const betweenCheckAndOpen = meeting();

/**
 * The same service twice over one database, each with its own connection pool:
 * what two processes of the service look like to Postgres. What keeps two
 * presses apart has to hold between these as well as within one.
 */
const serviceOver = (db: DatabaseHandle) =>
  createApp({
    db: db.db,
    env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
    sql: db.sql,
    checkDatabase: async () => 'ok',
    companies: {
      store: new PostgresCompanyStore(db.db),
      // In the service this is a query for the space's mail connection, so it
      // takes a moment, between the check for a running scan and the new one.
      mailbox: async () => {
        if (holdScans) await betweenCheckAndOpen();
        return fixtureMailbox(fixtureMessages());
      },
      extractor: scriptedExtractor(),
      schedule: async (work) => {
        if (holdScans) heldScans.push(work);
        else await work();
      },
      handler: {
        // Creating a job takes a few round trips; a second press that reaches
        // this step while the first is still in it would start a second chase.
        async handleLedgerItem() {
          handlerCalls += 1;
          await insideHandler();
          return { job_id: newId('job') };
        },
      },
    },
  });
const app = handle ? serviceOver(handle) : null;
const otherPool = handle ? openDatabase(handle.url) : null;
const other = otherPool ? serviceOver(otherPool) : null;
const withDb = app ? describe : describe.skip;

async function call(cookie: string, path: string, method = 'GET', through = app) {
  if (!through) throw new Error('Postgres unavailable');
  return through.request(path, { method, headers: { Cookie: cookie } });
}

let cookie = '';
let spaceId = '';

withDb('two presses at once', () => {
  afterAll(async () => {
    await otherPool?.close();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('an account with a scanned map', async () => {
    if (!app) throw new Error('Postgres unavailable');
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'studio@example.test', password }),
    });
    expect(setup.status).toBe(201);
    cookie =
      setup.headers
        .getSetCookie()
        .map((entry) => entry.split(';')[0] ?? '')
        .find((entry) => entry.startsWith('melete_session=')) ?? '';
    const spaces = (await (await call(cookie, '/spaces')).json()) as {
      spaces: { id: string; kind: string }[];
    };
    spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
    expect((await call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST')).status).toBe(202);
  }, 120_000);

  test('handling one item from two presses at once starts one chase', async () => {
    const map = companyMap.parse(await (await call(cookie, `/spaces/${spaceId}/companies`)).json());
    const item = map.items.find((entry) => entry.status === 'found' && entry.job_id === null);
    expect(item).toBeDefined();
    if (!item) return;
    const before = handlerCalls;
    const responses = await Promise.all([
      call(cookie, `/ledger/${item.id}/handle`, 'POST'),
      call(cookie, `/ledger/${item.id}/handle`, 'POST'),
    ]);
    const answers = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        job: ((await response.json()) as { job_id: string }).job_id,
      })),
    );
    // The playbook was asked once, and both presses name the job it started:
    // two jobs would be two messages to the same company.
    expect(handlerCalls - before).toBe(1);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    expect(answers[0]?.job).toBe(answers[1]?.job as string);
  }, 60_000);

  test('starting a scan from two presses at once starts one scan', async () => {
    holdScans = true;
    try {
      const responses = await Promise.all([
        call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST'),
        call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST'),
      ]);
      const answers = await Promise.all(
        responses.map(async (response) => ({
          status: response.status,
          scan: ((await response.json()) as { scan_id: string }).scan_id,
        })),
      );
      // The second press is handed the scan the first one opened, so the
      // mailbox is read once.
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 202]);
      expect(answers[0]?.scan).toBe(answers[1]?.scan as string);
      expect(heldScans.length).toBe(1);
    } finally {
      holdScans = false;
      for (const work of heldScans.splice(0)) await work();
    }
  }, 60_000);

  test('two processes pressing “Handle it” on one item start one chase', async () => {
    const map = companyMap.parse(await (await call(cookie, `/spaces/${spaceId}/companies`)).json());
    const item = map.items.find((entry) => entry.status === 'found' && entry.job_id === null);
    expect(item).toBeDefined();
    if (!item) return;
    const before = handlerCalls;
    const responses = await Promise.all([
      call(cookie, `/ledger/${item.id}/handle`, 'POST', app),
      call(cookie, `/ledger/${item.id}/handle`, 'POST', other),
    ]);
    const jobs = await Promise.all(
      responses.map(async (response) => ((await response.json()) as { job_id: string }).job_id),
    );
    expect(handlerCalls - before).toBe(1);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(jobs[0]).toBe(jobs[1] as string);
  }, 60_000);

  test('two processes starting a scan at once start one scan', async () => {
    holdScans = true;
    try {
      const responses = await Promise.all([
        call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST', app),
        call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST', other),
      ]);
      const scans = await Promise.all(
        responses.map(async (response) => ((await response.json()) as { scan_id: string }).scan_id),
      );
      expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
      expect(scans[0]).toBe(scans[1] as string);
      expect(heldScans.length).toBe(1);
    } finally {
      holdScans = false;
      for (const work of heldScans.splice(0)) await work();
    }
  }, 60_000);

  test('a section held elsewhere for too long is given up on, not waited for', async () => {
    if (!handle || !otherPool) throw new Error('Postgres unavailable');
    // Another process holds the section and does not let go.
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = otherPool.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'companies:ledger:stuck'}))`;
      held();
      await released;
    });
    await holding;
    const started = Date.now();
    try {
      await expect(
        new PostgresCompanyStore(handle.db).exclusive('ledger:stuck', async () => 'ran'),
      ).rejects.toBeDefined();
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(14_000);
      expect(waited).toBeLessThan(30_000);
    } finally {
      release();
      await holder;
    }
  }, 60_000);
});
