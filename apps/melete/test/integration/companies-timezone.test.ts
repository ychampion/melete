/**
 * The company map counts a due date with no time as a day in the person's own
 * time zone, which the space's profile keeps. The route is what reads it.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { companyMap } from '@melete/contracts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { experienceProfile } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-companies-tz-'));
// 22:00 on 25 September in New York, and already the 26th in UTC.
const NOW = new Date('2026-09-26T02:00:00.000Z');
const store = handle ? new PostgresCompanyStore(handle.db) : null;
const app =
  handle && store
    ? createApp({
        db: handle.db,
        env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
        sql: handle.sql,
        checkDatabase: async () => 'ok',
        companies: {
          store,
          mailbox: () => fixtureMailbox([]),
          extractor: scriptedExtractor(),
          now: () => NOW,
        },
      })
    : null;
const withDb = app ? test : test.skip;

afterAll(async () => {
  await handle?.close();
  await rm(root, { recursive: true, force: true });
}, 30_000);

withDb('a promise due today where the person lives is still in force', async () => {
  if (!app || !handle || !store) return;
  const setup = await app.request('/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'tz@example.test', password: 'a-long-enough-password' }),
  });
  expect(setup.status).toBe(201);
  const cookie =
    setup.headers
      .getSetCookie()
      .map((entry) => entry.split(';')[0] ?? '')
      .find((entry) => entry.startsWith('melete_session=')) ?? '';
  const spaces = (await (await app.request('/spaces', { headers: { Cookie: cookie } })).json()) as {
    spaces: { id: string; kind: string }[];
  };
  const spaceId = spaces.spaces.find((entry) => entry.kind === 'personal')?.id ?? '';
  const [principal] = await handle.sql`select id from principal limit 1`;
  const owner = { spaceId, principalId: String(principal?.id) };
  // A company is written by a scan that is still open, as a real scan writes it.
  const scan = await store.openScan(owner);
  const companyId = await store.saveCompany(owner, scan.id, {
    name: 'Acme',
    domain: 'acme.test',
    monthly_spend_minor: null,
    currency: null,
    first_seen_at: '2026-09-20T09:00:00.000Z',
    last_seen_at: '2026-09-20T09:00:00.000Z',
    message_count: 1,
  });
  await store.saveItems(owner, scan.id, [
    {
      id: newId('li'),
      space_id: spaceId,
      principal_id: owner.principalId,
      company_id: companyId,
      kind: 'promise',
      direction: 'info',
      amount_minor: null,
      currency: null,
      due_at: '2026-09-25T00:00:00.000Z',
      // Stored and read back: the flag, not the hour, says it is a date.
      due_date_only: true,
      status: 'found',
      confidence: 'high',
      evidence: [{ message_id: '<p1@acme.test>', quote: 'by 25 September', start: 0, end: 15 }],
      suggested_playbook: null,
      job_id: null,
      summary: 'Refund by 25 September',
    },
  ]);
  await handle.db
    .insert(experienceProfile)
    .values({ spaceId, name: 'Sam', timeZone: 'America/New_York' });

  const response = await app.request(`/spaces/${spaceId}/companies`, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  const map = companyMap.parse(await response.json());
  expect(map.totals.promises_in_force).toBe(1);
  expect(map.totals.promises_lapsed).toBe(0);
});
