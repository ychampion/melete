/**
 * The Companies "Handle it" journey, end to end: the scan finds something a
 * company owes, the person says "Handle it", one message goes out with their
 * say-so, and the chase keeps at it through a reply or silence until the
 * company resolves it.
 *
 * Everything here is the shipping code. The mailbox is the demonstration
 * fixture, the extractor is the scripted one, the store is Postgres, and the
 * way out is the broker with its approval path. Only the model is absent: where
 * an attempt would decide to write, the test proposes what it would propose.
 *
 * The approval rule this pins, as the code implements it: every distinct
 * message to a company needs its own "Allow once". A standing "Always" is only
 * offered for a recipient whose origin Melete can vouch for, and an address
 * read out of a company's own email is not one, so a follow-up asks again.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { evidenceHolds, type LedgerItem, type WaitSpec } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { FIXTURE_REFERENCE, fixtureMessages } from '../../src/companies/fixtures.ts';
import { handleLedgerItem } from '../../src/companies/handle.ts';
import { fixtureMailbox } from '../../src/companies/mailbox.ts';
import {
  CompanyReplyPoller,
  fixtureReplyMailbox,
  type ReplyMessage,
} from '../../src/companies/replies.ts';
import { type Owner, PostgresCompanyStore } from '../../src/companies/repository.ts';
import { runScan } from '../../src/companies/scan.ts';
import { scriptedExtractor } from '../../src/companies/scripted.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { connection, owner, space, trigger } from '../../src/db/schema.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
import { resolveExperienceGrant } from '../../src/experience/rules.ts';
import { newId } from '../../src/ids.ts';
import { ApprovalService } from '../../src/jobs/approvals.ts';
import { type AttemptWake, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { resetTestRows, testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'companies-journey-integration-key-32-bytes';
const scopes = ['test.send', 'test.read', 'job.wait'];

let runner: AttemptRunner;
let triggers: TriggerService;
let approvals: ApprovalService;
let broker: BrokerService;
let permissions: ExperiencePermissions;
let store: PostgresCompanyStore;
let scanOwner: Owner;
let spaceId = '';
let ownerId = '';
let connectionId = '';

function fixture() {
  if (!handle || !queue || !jobs) throw new Error('Postgres unavailable');
  return { handle, queue, jobs };
}

const wake = (row: JobRow): AttemptWake => ({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'event',
});

async function claim(row: JobRow): Promise<ClaimedAttempt> {
  const claimed = await runner.claim(wake(row));
  if (!claimed) throw new Error('Expected an admitted attempt');
  return claimed;
}

async function sends(to: string) {
  const { handle } = fixture();
  return handle.sql`select a.id from action a join test_destination_ledger d on d.action_id = a.id
    where a.kind = 'test.send' and a.canonical_payload->>'to' = ${to}`;
}

/** What "Allow once" does: the person approves these exact words, once. */
async function allowOnceAndSend(claimed: ClaimedAttempt, jobId: string, to: string, body: string) {
  const { jobs } = fixture();
  const proposal = await broker.propose(claimed.claims, {
    connection_id: connectionId,
    kind: 'test.send',
    payload: { to, subject: 'Refund', body },
  });
  expect(proposal.status).toBe('needs_approval');
  const card = await permissions.card(spaceId, String(proposal.approval_id));
  expect(card.options).toContain('allow_once');
  // The destination was read out of the company's email, so nothing standing
  // can cover it: "Always" is not on offer, and the next message asks again.
  expect(card.options).not.toContain('always');
  await approvals.decide(
    String(proposal.approval_id),
    { decision: 'approved', payload_hash: proposal.payload_hash },
    ownerId,
  );
  const carrying = await claim(await jobs.get(jobId));
  await broker.admit(carrying.claims, proposal.action_id, proposal.payload_hash);
  expect((await broker.dispatch(proposal.action_id)).status).toBe('succeeded');
  return { proposal, claimed: carrying };
}

async function waitForReply(claimed: ClaimedAttempt, jobId: string, deadline: Date) {
  const { handle } = fixture();
  const [registration] = await handle.db.select().from(trigger).where(eq(trigger.jobId, jobId));
  if (!registration) throw new Error('Expected the reply trigger');
  return runner.commitOutcome(claimed.claims, {
    kind: 'waiting_for_event_or_time',
    wait: {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: deadline.toISOString(),
    } satisfies WaitSpec,
  });
}

/** The poller, reading a mailbox that holds exactly these messages. */
const poll = (messages: readonly ReplyMessage[]) =>
  new CompanyReplyPoller({
    sql: fixture().handle.sql,
    triggers,
    mailboxFor: () => fixtureReplyMailbox(messages),
  }).runOnce();

async function owedFrom(domain: string) {
  const map = await store.map(scanOwner, new Date(FIXTURE_REFERENCE));
  const company = map.companies.find((entry) => entry.domain === domain);
  const item = map.items.find(
    (entry: LedgerItem) =>
      entry.company_id === company?.id &&
      entry.kind === 'refund_owed' &&
      entry.direction === 'owed_to_you',
  );
  if (!company || !item) throw new Error(`Expected money owed by ${domain}`);
  const detail = await store.item(scanOwner, item.id);
  if (!detail?.message) throw new Error('Expected the stored message');
  return { map, company, item, text: detail.message.text };
}

async function handleIt(domain: string) {
  const { jobs } = fixture();
  const { company, item, text } = await owedFrom(domain);
  const { job_id } = await handleLedgerItem(
    {
      createJob: (input) => jobs.create(input),
      createTrigger: (jobId, spec) => triggers.create(jobId, spec),
    },
    { item, company, messageText: text, principalId: ownerId, spaceId, connectionId },
  );
  await store.setJob(scanOwner, item.id, job_id);
  return { jobId: job_id, item };
}

withDb('handling what a company owes, from the scan to the reply that resolves it', () => {
  beforeAll(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.background);
    await resetTestRows(handle.sql);
    await initializeTestLedger(handle.sql);
    spaceId = newId('sp');
    ownerId = newId('own');
    connectionId = newId('conn');
    await handle.db
      .insert(owner)
      .values({ id: ownerId, email: 'studio@example.test', passwordHash: 'fixture' });
    await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner`;
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db.insert(connection).values({
      id: connectionId,
      spaceId,
      provider: 'test',
      label: 'Studio mailbox',
      scopes,
      configuration: { kind: 'mail', mail: { from: 'studio@example.test' } },
    });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key, scopes });
    triggers = new TriggerService(jobs, runner);
    approvals = new ApprovalService(jobs, runner);
    const registry = new ConnectorRegistry().register(
      connectionId,
      createTestConnector(handle.sql),
    );
    broker = new BrokerService({
      sql: handle.sql,
      connectors: registry,
      // Nothing is vouched for, as in production for an address read out of mail.
      resolveTrust: createTableTrustResolver({}),
      resolveStandingGrant: resolveExperienceGrant,
    });
    permissions = new ExperiencePermissions(
      handle.sql,
      broker,
      new ExperienceEffects(handle.sql, broker, registry),
    );
    store = new PostgresCompanyStore(handle.db);
    scanOwner = { spaceId, principalId: ownerId };
  });

  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('1. the scan finds what is owed, with a quote that holds, and the total counts it', async () => {
    const outcome = await runScan({
      store,
      mailbox: fixtureMailbox(fixtureMessages()),
      extractor: scriptedExtractor(),
      owner: scanOwner,
      now: new Date(FIXTURE_REFERENCE),
    });
    expect(outcome.status).toBe('done');
    const { map, item, text } = await owedFrom('thornfieldprint.example');
    expect(item).toMatchObject({ amount_minor: 53450, currency: 'GBP', status: 'found' });
    for (const evidence of item.evidence) expect(evidenceHolds(text, evidence)).toBe(true);
    expect(text).toContain('Your payment of GBP 534.50 will be refunded within 5 working days.');
    expect(map.totals.owed_to_you_minor).toBeGreaterThanOrEqual(53450);
    const owed = map.items
      .filter(
        (entry) =>
          entry.direction === 'owed_to_you' &&
          entry.currency === 'GBP' &&
          ['found', 'handling', 'waiting'].includes(entry.status),
      )
      .reduce((sum, entry) => sum + (entry.amount_minor ?? 0), 0);
    expect(map.totals.owed_to_you_minor).toBe(owed);
  });

  test('2 and 3. one chase, one approved message, a stall, a follow-up, and the reply that resolves it', async () => {
    const { jobs } = fixture();
    const to = 'orders@thornfieldprint.example';
    const owedAtStart = (await store.map(scanOwner, new Date(FIXTURE_REFERENCE))).totals
      .owed_to_you_minor;
    const { jobId, item } = await handleIt('thornfieldprint.example');
    expect((await store.item(scanOwner, item.id))?.item.status).toBe('handling');

    // The first message waits for "Allow once", and exactly one goes out.
    const first = await claim(await jobs.get(jobId));
    const opened = await allowOnceAndSend(
      first,
      jobId,
      to,
      'Your payment of GBP 534.50 was to be refunded within 5 working days. Please confirm the date.',
    );
    expect(await sends(to)).toHaveLength(1);
    const parked = await waitForReply(opened.claimed, jobId, new Date(Date.now() + 7 * 86_400_000));
    expect(parked.state).toBe('waiting_for_event_or_time');

    // Somebody else writing is not the company answering.
    const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
    expect(
      await poll([
        {
          messageId: '<news@longshoreletter.example>',
          from: 'Longshore <hello@longshoreletter.example>',
          subject: 'This week',
          receivedAt: later(1),
        },
      ]),
    ).toBe(0);
    expect((await jobs.get(jobId)).state).toBe('waiting_for_event_or_time');

    // The company stalls. Its reply wakes this chase, and the follow-up is new
    // words, so it asks again.
    expect(
      await poll([
        {
          messageId: '<stall-1@thornfieldprint.example>',
          from: 'Thornfield Print <orders@thornfieldprint.example>',
          subject: 'Re: Refund',
          receivedAt: later(2),
        },
      ]),
    ).toBe(1);
    const stalled = await claim(await jobs.get(jobId));
    expect(stalled.bundle.inputs.trigger_events).toHaveLength(1);
    const followed = await allowOnceAndSend(
      stalled,
      jobId,
      to,
      'Thank you. Please confirm the date the GBP 534.50 refund will reach my account.',
    );
    expect(await sends(to)).toHaveLength(2);
    await waitForReply(followed.claimed, jobId, new Date(Date.now() + 7 * 86_400_000));

    // The company pays. That reply wakes the chase, and pointing at what went
    // out settles it.
    expect(
      await poll([
        {
          messageId: '<paid-1@thornfieldprint.example>',
          from: 'Thornfield Print <orders@thornfieldprint.example>',
          subject: 'Re: Refund - paid',
          receivedAt: later(3),
        },
      ]),
    ).toBe(1);
    const paid = await claim(await jobs.get(jobId));
    const done = await runner.commitOutcome(paid.claims, {
      kind: 'completed',
      summary: 'Thornfield Print refunded GBP 534.50.',
      evidence: [{ kind: 'action', action_id: followed.proposal.action_id }],
    });
    expect(done.state).toBe('completed');
    // Nothing more went out after the company paid.
    expect(await sends(to)).toHaveLength(2);
    // The chase is done, but only the person can say the money arrived. The
    // item waits for them, with its chase on it, and is still counted.
    const after = await store.map(scanOwner, new Date(FIXTURE_REFERENCE));
    expect(after.items.find((entry) => entry.id === item.id)).toMatchObject({
      status: 'waiting',
      job_id: jobId,
    });
    expect(after.totals.owed_to_you_minor).toBe(owedAtStart);
    // They say "Settled", and the total stops counting it.
    await store.setStatus(scanOwner, item.id, 'settled');
    const settled = await store.map(scanOwner, new Date(FIXTURE_REFERENCE));
    expect(settled.totals.owed_to_you_minor).toBe(owedAtStart - 53450);
  });

  test('a chase that ends on a refusal leaves the item unsettled and still owed', async () => {
    const { jobs } = fixture();
    const to = 'business@tidewell.example';
    const before = (await store.map(scanOwner, new Date(FIXTURE_REFERENCE))).totals;
    const { jobId, item } = await handleIt('tidewell.example');
    const opened = await allowOnceAndSend(
      await claim(await jobs.get(jobId)),
      jobId,
      to,
      'My account is GBP 486.40 in credit. Please refund the balance to my bank account.',
    );
    await waitForReply(opened.claimed, jobId, new Date(Date.now() + 7 * 86_400_000));
    expect(
      await poll([
        {
          messageId: '<no-1@tidewell.example>',
          from: 'Tidewell Energy <business@tidewell.example>',
          subject: 'Re: Refund',
          receivedAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ]),
    ).toBe(1);
    // The company says no, and the chase finishes with that on the record.
    const refused = await claim(await jobs.get(jobId));
    const done = await runner.commitOutcome(refused.claims, {
      kind: 'completed',
      summary: 'Tidewell Energy refused to refund the credit.',
      evidence: [{ kind: 'action', action_id: opened.proposal.action_id }],
    });
    expect(done.state).toBe('completed');
    const after = await store.map(scanOwner, new Date(FIXTURE_REFERENCE));
    expect(after.items.find((entry) => entry.id === item.id)?.status).toBe('waiting');
    expect(after.totals).toEqual(before);
  });

  test('a chase that is stopped puts the item back, ready to be handled again', async () => {
    const { jobs } = fixture();
    const before = (await store.map(scanOwner, new Date(FIXTURE_REFERENCE))).totals;
    const { jobId, item } = await handleIt('lumenrail.example');
    expect((await store.item(scanOwner, item.id))?.item).toMatchObject({
      status: 'handling',
      job_id: jobId,
    });
    await jobs.cancel(jobId, 'the person said stop');
    expect((await store.item(scanOwner, item.id))?.item).toMatchObject({
      status: 'found',
      job_id: null,
    });
    // It remembers which chase it was.
    const [row] = await fixture().handle
      .sql`select last_job_id from ledger_item where id = ${item.id}`;
    expect(row?.last_job_id).toBe(jobId);
    expect((await store.map(scanOwner, new Date(FIXTURE_REFERENCE))).totals).toEqual(before);
  });

  test('4. silence past the window brings exactly one follow-up', async () => {
    const { jobs, handle } = fixture();
    const to = 'business@harrowgatehardware.example';
    const { jobId } = await handleIt('harrowgatehardware.example');
    const opened = await allowOnceAndSend(
      await claim(await jobs.get(jobId)),
      jobId,
      to,
      'A refund of GBP 429.99 was to reach my account within 10 working days. Please confirm the date.',
    );
    // The window has already run out and the company never wrote.
    const elapsed = await waitForReply(opened.claimed, jobId, new Date(Date.now() - 1000));
    const wakes = await handle.sql`select id from pgboss.job where name = ${QUEUES.background}
      and data->>'job_id' = ${jobId} and (data->>'expected_version')::int = ${elapsed.stateVersion}`;
    expect(wakes).toHaveLength(1);
    const resumed = await claim(elapsed);
    expect(resumed.bundle.inputs.trigger_events).toEqual([]);
    // The same wake a second time admits nothing.
    expect(await runner.claim(wake(elapsed))).toBeNull();
    await allowOnceAndSend(
      resumed,
      jobId,
      to,
      'Following up on the GBP 429.99 refund. Please confirm the date it will be paid.',
    );
    expect(await sends(to)).toHaveLength(2);
  });
});
