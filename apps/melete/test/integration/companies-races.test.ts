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
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const root = await mkdtemp(join(tmpdir(), 'melete-companies-races-'));
const password = 'a-long-enough-password';

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

const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test', MELETE_SPACES_DIR: root }),
      sql: handle.sql,
      checkDatabase: async () => 'ok',
      companies: {
        store: new PostgresCompanyStore(handle.db),
        mailbox: () => fixtureMailbox(fixtureMessages()),
        extractor: scriptedExtractor(),
        schedule: (work) => work(),
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
    })
  : null;
const withDb = app ? describe : describe.skip;

async function call(cookie: string, path: string, method = 'GET') {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, { method, headers: { Cookie: cookie } });
}

let cookie = '';
let spaceId = '';

withDb('two presses at once', () => {
  afterAll(async () => {
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
});
