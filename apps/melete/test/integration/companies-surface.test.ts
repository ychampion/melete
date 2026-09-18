/**
 * The company map over the real HTTP surface, against a real Postgres.
 *
 * The unit tests prove the scan admits only what it can open back to a
 * sentence. This one proves the other half: that the rows it wrote are the
 * caller's own, that a second account on the same installation reads nothing of
 * them, and that every route answers the shapes the contract names.
 *
 * Two accounts, two personal spaces. Everything the first account owns is
 * reached twice, once by the account that owns it and once by the account that
 * does not, and the second must be told the rows are not there rather than that
 * it may not have them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyMap, ledgerItem as ledgerItemContract } from '@melete/contracts';
import { fixtureMessages } from '../../src/companies/fixtures.ts';
import type { HandleRequest } from '../../src/companies/handler.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { loadEnv } from '../../src/env.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-companies-'));
const password = 'a-long-enough-password';
const handled: HandleRequest[] = [];

const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      sql: handle.sql,
      checkDatabase: async () => 'ok',
      companies: {
        store: new PostgresCompanyStore(handle.db),
        // Every space gets the demonstration mailbox, so both accounts can scan.
        mailbox: () => fixtureMailbox(fixtureMessages()),
        extractor: scriptedExtractor(),
        // The scan runs to completion before the route answers, so the test
        // never has to wait on a detached promise.
        schedule: (work) => work(),
        handler: {
          async handleLedgerItem(request) {
            handled.push(request);
            return { job_id: 'job_01J0000000000000000000000H' };
          },
        },
      },
    })
  : null;
const withDb = app ? describe : describe.skip;

async function call(cookie: string, path: string, method = 'GET', body?: unknown) {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, {
    method,
    headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
function sessionCookie(response: Response): string {
  const value = response.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .find((entry) => entry.startsWith('melete_session='));
  if (!value) throw new Error(`Expected a session cookie (${response.status})`);
  return value;
}
async function personalSpace(cookie: string): Promise<string> {
  const spaces = (
    await json<{ spaces: { id: string; kind: string }[] }>(await call(cookie, '/spaces'))
  ).spaces;
  const id = spaces.find((entry) => entry.kind === 'personal')?.id;
  if (!id) throw new Error('no personal space');
  return id;
}

let firstCookie = '';
let secondCookie = '';
let firstSpace = '';
let secondSpace = '';
let firstScan = '';
let anItem = '';

withDb('the company map over HTTP', () => {
  test('two accounts, each with a personal space of its own', async () => {
    if (!app) throw new Error('Postgres unavailable');
    const setup = await app.request('/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'studio@example.test', password }),
    });
    expect(setup.status).toBe(201);
    firstCookie = sessionCookie(setup);
    expect(
      (await call(firstCookie, '/principals', 'POST', { email: 'other@example.test', password }))
        .status,
    ).toBe(201);
    secondCookie = sessionCookie(
      await app.request('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'other@example.test', password }),
      }),
    );
    firstSpace = await personalSpace(firstCookie);
    secondSpace = await personalSpace(secondCookie);
    expect(firstSpace).not.toBe(secondSpace);
  }, 60_000);

  test('a scan reads the mailbox and reports what it found', async () => {
    const started = await call(firstCookie, `/spaces/${firstSpace}/companies/scan`, 'POST');
    expect(started.status).toBe(202);
    const body = await json<{ scan_id: string; status: string }>(started);
    expect(body.status).toBe('running');
    firstScan = body.scan_id;

    const progress = await call(firstCookie, `/spaces/${firstSpace}/companies/scan/${firstScan}`);
    expect(progress.status).toBe(200);
    const record = await json<{ status: string; messages_seen: number; items_found: number }>(
      progress,
    );
    expect(record.status).toBe('done');
    expect(record.messages_seen).toBe(40);
    expect(record.items_found).toBeGreaterThan(20);
  }, 60_000);

  test('the map parses as the contract says a map parses', async () => {
    const response = await call(firstCookie, `/spaces/${firstSpace}/companies`);
    expect(response.status).toBe(200);
    const map = companyMap.parse(await response.json());
    expect(map.companies.length).toBeGreaterThan(20);
    expect(map.totals.owed_to_you_minor).toBeGreaterThan(0);
    expect(map.currency).toBe('GBP');
    // Every row carries the space it belongs to, as the contract requires.
    for (const entry of map.companies) expect(entry.space_id).toBe(firstSpace);
    for (const item of map.items) expect(item.space_id).toBe(firstSpace);
    anItem = map.items[0]?.id ?? '';
    expect(anItem).not.toBe('');
  }, 60_000);

  test('an item opens back to the stored message its quote indexes into', async () => {
    const response = await call(firstCookie, `/ledger/${anItem}`);
    expect(response.status).toBe(200);
    const body = await json<{
      item: unknown;
      company: { domain: string };
      message: { id: string; text: string } | null;
    }>(response);
    const item = ledgerItemContract.parse(body.item);
    expect(body.company.domain).toMatch(/\.example$/);
    expect(body.message).not.toBe(null);
    const evidence = item.evidence[0];
    expect(evidence).toBeDefined();
    if (!evidence || !body.message) return;
    expect(body.message.id).toBe(evidence.message_id);
    // The route's own answer is enough to re-derive the quote.
    expect(body.message.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
  }, 60_000);

  test('a second scan while one is not running starts a new one', async () => {
    const again = await call(firstCookie, `/spaces/${firstSpace}/companies/scan`, 'POST');
    expect(again.status).toBe(202);
    const body = await json<{ scan_id: string }>(again);
    expect(body.scan_id).not.toBe(firstScan);
    // The same mailbox read twice adds nothing: every claim is already held.
    const map = companyMap.parse(
      await (await call(firstCookie, `/spaces/${firstSpace}/companies`)).json(),
    );
    const second = await json<{ items_found: number }>(
      await call(firstCookie, `/spaces/${firstSpace}/companies/scan/${body.scan_id}`),
    );
    expect(second.items_found).toBe(0);
    expect(map.items.length).toBeGreaterThan(20);
  }, 60_000);

  test('an item can be dropped, and the totals stop counting it', async () => {
    const before = companyMap.parse(
      await (await call(firstCookie, `/spaces/${firstSpace}/companies`)).json(),
    );
    const owed = before.items.find(
      (item) => item.direction === 'owed_to_you' && item.currency === 'GBP' && item.amount_minor,
    );
    expect(owed).toBeDefined();
    if (!owed) return;
    const patched = await call(firstCookie, `/ledger/${owed.id}`, 'PATCH', { status: 'dropped' });
    expect(patched.status).toBe(200);
    expect(ledgerItemContract.parse(await patched.json()).status).toBe('dropped');
    const after = companyMap.parse(
      await (await call(firstCookie, `/spaces/${firstSpace}/companies`)).json(),
    );
    expect(after.totals.owed_to_you_minor).toBe(
      before.totals.owed_to_you_minor - (owed.amount_minor ?? 0),
    );
  }, 60_000);

  test('handling an item hands the playbook everything it needs and records the job', async () => {
    const response = await call(firstCookie, `/ledger/${anItem}/handle`, 'POST');
    expect(response.status).toBe(201);
    expect((await json<{ job_id: string }>(response)).job_id).toBe(
      'job_01J0000000000000000000000H',
    );
    const request = handled.at(-1);
    expect(request).toBeDefined();
    if (!request) return;
    expect(request.item.id).toBe(anItem);
    expect(request.company.id).toBe(request.item.company_id);
    // The playbook is handed the text, so it can quote the company's own words.
    expect(request.messageText).toContain('Subject:');
    const reread = await json<{ item: unknown }>(await call(firstCookie, `/ledger/${anItem}`));
    const item = ledgerItemContract.parse(reread.item);
    expect([item.status, item.job_id]).toEqual(['handling', 'job_01J0000000000000000000000H']);
  }, 60_000);
});

withDb('a second account on the same installation', () => {
  // The database outlives both groups, so it is closed once, here, after the
  // last assertion that needs it.
  afterAll(async () => {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  // Every `/spaces/:id/...` surface in this service is guarded by one rule, in
  // `mountPrincipals`, which refuses a space the caller cannot see with 403
  // before any route runs. The company map is guarded by that same rule rather
  // than by one of its own, so it answers the way the rest of the API answers.
  test('cannot read the first account’s map', async () => {
    const response = await call(secondCookie, `/spaces/${firstSpace}/companies`);
    expect(response.status).toBe(403);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe('scope_denied');
  }, 60_000);

  test('cannot start a scan in a space that is not its own', async () => {
    expect((await call(secondCookie, `/spaces/${firstSpace}/companies/scan`, 'POST')).status).toBe(
      403,
    );
  }, 60_000);

  test('cannot watch the first account’s scan', async () => {
    expect(
      (await call(secondCookie, `/spaces/${firstSpace}/companies/scan/${firstScan}`)).status,
    ).toBe(403);
  }, 60_000);

  test('cannot read, change or handle an item it does not own', async () => {
    expect((await call(secondCookie, `/ledger/${anItem}`)).status).toBe(404);
    expect(
      (await call(secondCookie, `/ledger/${anItem}`, 'PATCH', { status: 'settled' })).status,
    ).toBe(404);
    expect((await call(secondCookie, `/ledger/${anItem}/handle`, 'POST')).status).toBe(404);
  }, 60_000);

  test('a refusal changes nothing the first account owns', async () => {
    const reread = await json<{ item: unknown }>(await call(firstCookie, `/ledger/${anItem}`));
    expect(ledgerItemContract.parse(reread.item).status).toBe('handling');
  }, 60_000);

  test('its own space starts empty, and fills only from its own scan', async () => {
    const before = companyMap.parse(
      await (await call(secondCookie, `/spaces/${secondSpace}/companies`)).json(),
    );
    expect(before.items).toEqual([]);
    expect(before.companies).toEqual([]);
    expect((await call(secondCookie, `/spaces/${secondSpace}/companies/scan`, 'POST')).status).toBe(
      202,
    );
    const after = companyMap.parse(
      await (await call(secondCookie, `/spaces/${secondSpace}/companies`)).json(),
    );
    expect(after.items.length).toBeGreaterThan(20);
    // The same mailbox, read by another person, is another person's map.
    for (const item of after.items) expect(item.space_id).toBe(secondSpace);
    expect(after.items.some((item) => item.id === anItem)).toBe(false);
  }, 60_000);

  test('a space nobody has is refused the same way', async () => {
    expect(
      (await call(firstCookie, '/spaces/sp_01J000000000000000000000ZZ/companies')).status,
    ).toBe(403);
  }, 60_000);

  test('a ledger id is not found rather than forbidden, so it confirms nothing', async () => {
    // An item is addressed by its own id, outside `/spaces`, so the shared guard
    // does not see it and the route's own rule applies: an id that is not yours
    // simply does not match, and the answer never says whether it exists.
    const missing = await call(secondCookie, '/ledger/li_01J000000000000000000000ZZ');
    expect(missing.status).toBe(404);
    const theirs = await call(secondCookie, `/ledger/${anItem}`);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toBe(await missing.text());
  }, 60_000);

  test('an unauthenticated caller reaches none of it', async () => {
    if (!app) throw new Error('Postgres unavailable');
    expect((await app.request(`/spaces/${firstSpace}/companies`)).status).toBeGreaterThanOrEqual(
      401,
    );
    expect((await app.request(`/ledger/${anItem}`)).status).toBeGreaterThanOrEqual(401);
  }, 60_000);
});
