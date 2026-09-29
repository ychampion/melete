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

  test('a reply that arrives settles the wait, even while a chase has it', async () => {
    if (!handle || !jobs) throw new Error('Postgres unavailable');
    const reply = (await waiting(cookie)).replies.find((entry) => entry.who === 'Deverill IT');
    if (!reply?.job_id) throw new Error('Expected the reply being chased');
    const [row] = await handle.sql`select principal_id, message_id from awaited_reply
      where id = ${reply.id}`;
    const owner = { spaceId, principalId: String(row?.principal_id) };
    const store = new PostgresCompanyStore(handle.db);
    const latest = await store.latestScan(owner);
    if (!latest) throw new Error('Expected a scan');
    // The next scan sees their answer.
    await store.saveAwaited(owner, latest.id, [], [String(row?.message_id)]);
    expect((await waiting(cookie)).replies.map((entry) => entry.id)).not.toContain(reply.id);
    // The chase stopping afterwards does not open it again.
    await jobs.cancel(reply.job_id, 'answered');
    const [after] = await handle.sql`select status from awaited_reply where id = ${reply.id}`;
    expect(after?.status).toBe('settled');
  }, 60_000);

  test('a chase that completes settles the wait; one that is stopped hands it back', async () => {
    if (!handle || !jobs) throw new Error('Postgres unavailable');
    const view = await waiting(cookie);
    const tomas = view.replies.find((entry) => entry.who === 'Tomas Brennan');
    const ashgrove = view.replies.find((entry) => entry.who === 'Ashgrove Studios');
    if (!tomas || !ashgrove) throw new Error('Expected both replies');
    const chase = async (id: string) => {
      const started = await call(cookie, `/waiting-on/replies/${id}/chase`, 'POST');
      expect(started.status).toBe(201);
      return ((await started.json()) as { job_id: string }).job_id;
    };

    // Whichever path finishes a job, the row follows it.
    const completing = await chase(tomas.id);
    await handle.sql`update job set state = 'completed' where id = ${completing}`;
    expect((await waiting(cookie)).replies.map((entry) => entry.id)).not.toContain(tomas.id);
    const [settled] = await handle.sql`select status from awaited_reply where id = ${tomas.id}`;
    expect(settled?.status).toBe('settled');

    const stopping = await chase(ashgrove.id);
    await jobs.cancel(stopping, 'the person said stop');
    const back = (await waiting(cookie)).replies.find((entry) => entry.id === ashgrove.id);
    expect(back).toMatchObject({ status: 'found', job_id: null });
  }, 60_000);

  test('dismissing a reply stops its chase and takes it off the list for good', async () => {
    if (!app || !handle || !jobs) throw new Error('Postgres unavailable');
    const ashgrove = (await waiting(cookie)).replies.find(
      (entry) => entry.who === 'Ashgrove Studios',
    );
    if (!ashgrove) throw new Error('Expected the reply');
    const started = await call(cookie, `/waiting-on/replies/${ashgrove.id}/chase`, 'POST');
    const { job_id } = (await started.json()) as { job_id: string };

    expect(
      (await app.request(`/waiting-on/replies/${ashgrove.id}/drop`, { method: 'POST' })).status,
    ).toBe(401);
    expect(
      (await call(cookie, '/waiting-on/replies/awr_01J00000000000000000000000/drop', 'POST'))
        .status,
    ).toBe(404);
    const dropped = await call(cookie, `/waiting-on/replies/${ashgrove.id}/drop`, 'POST');
    expect(dropped.status).toBe(200);
    expect(((await dropped.json()) as { status: string }).status).toBe('dropped');
    expect((await jobs.get(job_id)).state).toBe('cancelled');
    expect((await waiting(cookie)).replies.map((entry) => entry.id)).not.toContain(ashgrove.id);

    // Scanning again does not bring back what was dismissed or settled.
    expect((await call(cookie, `/spaces/${spaceId}/companies/scan`, 'POST')).status).toBe(202);
    const rescanned = await waiting(cookie);
    expect(rescanned.scan.status).toBe('done');
    expect(rescanned.replies).toEqual([]);
  }, 120_000);

  test('a reply nothing is chasing leaves the list thirty days after it went out', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const [row] =
      await handle.sql`select id from awaited_reply where to_address = ${'tomas.brennan@brennanphoto.example'}`;
    const id = String(row?.id);
    const reference = Date.parse(FIXTURE_REFERENCE);
    const reopen = (days: number) => handle.sql`update awaited_reply
      set status = 'found', job_id = null,
          sent_at = ${new Date(reference - days * 86_400_000).toISOString()}::timestamptz
      where id = ${id}`;
    await reopen(29);
    expect((await waiting(cookie)).replies.map((entry) => entry.id)).toContain(id);
    await reopen(31);
    expect((await waiting(cookie)).replies.map((entry) => entry.id)).not.toContain(id);
  }, 60_000);

  test('names the space its scan is for, and says when that scan looked for no replies', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const view = await waiting(cookie);
    expect(view.scan).toMatchObject({ space_id: spaceId, status: 'done', stale: false });
    // A scan from before Sent folders were read recorded nothing about replies.
    await handle.sql`update company_scan set counts = counts - 'awaited_replies'
      where space_id = ${spaceId}`;
    expect((await waiting(cookie)).scan.stale).toBe(true);
  }, 60_000);
});
