/**
 * The "Waiting on" first run, end to end over the real routes: a person with a
 * connected mailbox sees what they are owed and which of their messages are
 * still waiting on a reply, presses "Chase this" on one, approves the exact
 * follow-up once, and one message goes out.
 *
 * Everything is the shipping code except where there is nothing to ship
 * against: the mailbox is the demonstration inbox and Sent folder, the
 * extractor is the scripted one, and where an attempt would decide to write,
 * the test proposes what it would propose. The way out is the broker with its
 * approval path, through the test destination.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WaitingOn, waitingOn } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from '../../src/companies/fixtures.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import { PostgresCompanyStore } from '../../src/companies/repository.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { fixtureSentMessages } from '../../src/companies/sent-fixtures.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { connection, job } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const root = await mkdtemp(join(tmpdir(), 'melete-waiting-on-'));
const password = 'a-long-enough-password';
const key = 'waiting-on-journey-integration-key-32-bytes';
const scopes = ['test.send', 'test.read', 'job.wait'];
const connectionId = newId('conn');

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
          // A connected mailbox: the demonstration inbox, and what the person sent.
          mailbox: () => fixtureMailbox(fixtureMessages(), fixtureSentMessages()),
          extractor: scriptedExtractor(),
          sendConnection: () => connectionId,
          schedule: (work) => work(),
          now: () => new Date(FIXTURE_REFERENCE),
        },
      })
    : null;
const withDb = app && handle && jobs ? describe : describe.skip;

async function call(cookie: string, path: string, method = 'GET') {
  if (!app) throw new Error('Postgres unavailable');
  return app.request(path, { method, headers: { Cookie: cookie } });
}
const waiting = async (cookie: string): Promise<WaitingOn> =>
  waitingOn.parse(await (await call(cookie, '/waiting-on')).json());

let cookie = '';
let spaceId = '';

withDb('the "Waiting on" first run', () => {
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }, 30_000);

  test('connected, nothing scanned yet: it says so and shows nothing', async () => {
    if (!app || !handle) throw new Error('Postgres unavailable');
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
    expect(spaceId).not.toBe('');
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Studio mailbox', scopes });

    const before = await waiting(cookie);
    expect(before.scan).toMatchObject({ connected: true, status: 'none' });
    expect(before.top).toEqual([]);
    // Nobody else can read it.
    expect((await app.request('/waiting-on')).status).toBe(401);
  }, 60_000);

  test('after one scan: what is owed, and the replies still awaited', async () => {
    expect((await call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST')).status).toBe(202);
    const view = await waiting(cookie);
    expect(view.scan.status).toBe('done');
    // The owed figure is the company map's own.
    const map = (await (await call(cookie, `/spaces/${spaceId}/companies`)).json()) as {
      totals: { owed_to_you_minor: number };
    };
    expect(view.owed_minor).toBe(map.totals.owed_to_you_minor);
    expect(view.owed_minor).toBeGreaterThan(0);
    expect(view.replies.map((entry) => entry.who).sort()).toEqual([
      'Ashgrove Studios',
      'Deverill IT',
      'Tomas Brennan',
    ]);
    expect(view.top).toHaveLength(3);
    expect(view.top.map((entry) => entry.kind)).toContain('reply');
  }, 120_000);

  test('"Chase this" starts one chase, and its first follow-up is approved once and sent once', async () => {
    if (!app || !handle || !jobs) throw new Error('Postgres unavailable');
    const view = await waiting(cookie);
    const reply = view.replies.find((entry) => entry.who === 'Deverill IT');
    if (!reply) throw new Error('Expected the awaited reply');

    const started = await call(cookie, `/waiting-on/replies/${reply.id}/chase`, 'POST');
    expect(started.status).toBe(201);
    const { job_id } = (await started.json()) as { job_id: string };
    // A second press is the same chase.
    const again = await call(cookie, `/waiting-on/replies/${reply.id}/chase`, 'POST');
    expect(again.status).toBe(200);
    expect(((await again.json()) as { job_id: string }).job_id).toBe(job_id);
    expect(
      (await app.request(`/waiting-on/replies/${reply.id}/chase`, { method: 'POST' })).status,
    ).toBe(401);

    const [row] = await handle.db.select().from(job).where(eq(job.id, job_id));
    expect(row?.objective).toContain('Playbook: chase-reply.');
    expect(row?.objective).toContain(
      'Could you send a quote for the move and a day you could do it?',
    );
    // This app has no trigger service, so no reply watch is registered here;
    // the watch a chase gets is pinned by handle-reply.test.ts.

    // Where the attempt would write, it proposes the follow-up; the person is
    // asked once, for these exact words, and one message goes out.
    await initializeTestLedger(handle.sql);
    await handle.sql`delete from test_destination_ledger`;
    const runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key, scopes });
    const approvals = new ApprovalService(jobs, runner);
    const broker = new BrokerService({
      sql: handle.sql,
      connectors: new ConnectorRegistry().register(connectionId, createTestConnector(handle.sql)),
      resolveTrust: createTableTrustResolver({}),
    });
    const wake = async () => {
      const current = await jobs.get(job_id);
      const claimed = await runner.claim({
        job_id,
        expected_epoch: current.leaseEpoch,
        expected_version: current.stateVersion,
        reason: 'event',
      });
      if (!claimed) throw new Error('Expected an admitted attempt');
      return claimed;
    };
    const first = await wake();
    const payload = {
      to: 'service@deverillit.example',
      subject: 'Re: Moving the studio server',
      body: 'Just following up on the server move. Could you send a quote and a day you could do it?',
    };
    const proposal = await broker.propose(first.claims, {
      connection_id: connectionId,
      kind: 'test.send',
      payload,
    });
    expect(proposal.status).toBe('needs_approval');
    const approvalRows =
      await handle.sql`select id from approval where action_id = ${proposal.action_id}`;
    expect(approvalRows).toHaveLength(1);
    await approvals.decide(
      String(proposal.approval_id),
      { decision: 'approved', payload_hash: proposal.payload_hash },
      String(row?.principalId),
    );
    const carrying = await wake();
    await broker.admit(carrying.claims, proposal.action_id, proposal.payload_hash);
    expect((await broker.dispatch(proposal.action_id)).status).toBe('succeeded');
    const sent = await handle.sql`select action_id from test_destination_ledger`;
    expect(sent).toHaveLength(1);
    await runner.stop();

    // It is being chased now, so it stays on the list but leaves the top.
    const after = await waiting(cookie);
    expect(after.replies.find((entry) => entry.id === reply.id)).toMatchObject({
      status: 'handling',
      job_id,
    });
    expect(after.top.map((entry) => entry.id)).not.toContain(reply.id);
  }, 120_000);
});
