/**
 * The seam the two lanes met at, over the real route.
 *
 * `companies-surface.test.ts` proves the route's scoping with a handler that
 * only records what it was asked. `companies-handle.test.ts` proves the handler
 * against the real job service with no HTTP in front of it. Neither proves the
 * join, and the join is where an integration goes wrong: a person presses
 * "Handle it" and the thing that comes back has to be a real job, running the
 * playbook that item deserves, with the item now saying so.
 *
 * So this one signs in, scans the demonstration mailbox, presses the button and
 * follows the id: the job exists, its objective names the playbook, and the item
 * has moved to `handling` carrying that job. Then it presses the button again,
 * because the second press must not start a second chase.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerItem as ledgerItemContract } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { fixtureMessages } from '../../src/companies/fixtures.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { job } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-handle-route-'));
const password = 'a-long-enough-password';

// No `companies.handler` override: the app builds the real one from the job
// service, which is the wiring under test. No mail connection is active in this
// installation, so the job is created without a deliverable and without a reply
// trigger — the route still has to produce one, and the item still has to move.
const app =
  handle && jobs
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
        sql: handle.sql,
        jobs,
        checkDatabase: async () => 'ok',
        companies: {
          store: new PostgresCompanyStore(handle.db),
          mailbox: () => fixtureMailbox(fixtureMessages()),
          extractor: scriptedExtractor(),
          schedule: (work) => work(),
        },
      })
    : null;
const withDb = app ? describe : describe.skip;

async function call(cookie: string, path: string, method = 'GET') {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, { method, headers: { Cookie: cookie } });
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

let cookie = '';
let spaceId = '';
let refundItem = '';

withDb('pressing “Handle it” on a real item', () => {
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('an account, a scan, and a refund the map found on its own', async () => {
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
    expect(cookie).not.toBe('');

    const spaces = await json<{ spaces: { id: string; kind: string }[] }>(
      await call(cookie, '/spaces'),
    );
    spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
    expect(spaceId).not.toBe('');

    expect((await call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST')).status).toBe(202);
    const map = await json<{ items: { id: string; kind: string; status: string }[] }>(
      await call(cookie, `/spaces/${spaceId}/companies`),
    );
    const found = map.items.find((item) => item.kind === 'refund_owed' && item.status === 'found');
    expect(found).toBeDefined();
    refundItem = found?.id ?? '';
  }, 120_000);

  test('stopping cancels the chase and hands the item back open', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const started = await call(cookie, `/ledger/${refundItem}/handle`, 'POST');
    const { job_id } = await json<{ job_id: string }>(started);
    const stopped = await call(cookie, `/ledger/${refundItem}/stop`, 'POST');
    expect(stopped.status).toBe(200);
    expect(ledgerItemContract.parse(await stopped.json())).toMatchObject({
      id: refundItem,
      job_id: null,
      status: 'found',
    });
    const [row] = await handle.db.select().from(job).where(eq(job.id, job_id));
    expect(row?.state).toBe('cancelled');
    // Stopping twice is the same answer, and nothing is cancelled again.
    expect((await call(cookie, `/ledger/${refundItem}/stop`, 'POST')).status).toBe(200);
    // Another person's session cannot stop it.
    const other = await app?.request(`/ledger/${refundItem}/stop`, { method: 'POST' });
    expect(other?.status).toBe(401);
  }, 60_000);

  test('the job it starts is the item’s own playbook, and the item says so', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const response = await call(cookie, `/ledger/${refundItem}/handle`, 'POST');
    expect(response.status).toBe(201);
    const { job_id } = await json<{ job_id: string }>(response);
    expect(job_id).toMatch(/^job_/);

    // The id points at a real job, and the objective is what mounts the skill:
    // selection is a string match over it, so the playbook has to be named there.
    const [row] = await handle.db.select().from(job).where(eq(job.id, job_id));
    expect(row).toBeDefined();
    expect(row?.spaceId).toBe(spaceId);
    expect(row?.objective).toContain('Playbook: refund-owed.');
    expect(row?.objective).toContain(`Ledger item: ${refundItem}`);
    // Only sentences the stored message still carries reach the objective.
    expect(row?.objective).toContain('re-checked against it');

    const reread = await json<{ item: unknown }>(await call(cookie, `/ledger/${refundItem}`));
    const item = ledgerItemContract.parse(reread.item);
    expect([item.status, item.job_id]).toEqual(['handling', job_id]);
  }, 120_000);

  test('pressing it twice does not start a second chase', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const first = await json<{ item: { job_id: string } }>(
      await call(cookie, `/ledger/${refundItem}`),
    );
    const before = await handle.db.select().from(job);
    const again = await call(cookie, `/ledger/${refundItem}/handle`, 'POST');
    // The route hands back the job already doing it rather than refusing, and
    // the count is what proves it: writing to a company twice is the failure
    // this whole product exists to avoid.
    expect(again.status).toBe(200);
    expect((await json<{ job_id: string }>(again)).job_id).toBe(first.item.job_id);
    expect((await handle.db.select().from(job)).length).toBe(before.length);
  }, 60_000);
});
