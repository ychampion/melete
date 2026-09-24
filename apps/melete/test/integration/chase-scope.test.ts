/**
 * One "Allow once" on a chase's first message, and what it covers after.
 *
 * The rule under test: the person's approval of a chase's first message also
 * covers that same chase's follow-ups to the address they approved, in the
 * same thread, up to three of them. Anything else asks again, and revoking the
 * scope ends it. Each covered follow-up is still an action with a receipt.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JsonValue } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { handleLedgerItem } from '../../src/companies/handle.ts';
import { type Owner, PostgresCompanyStore } from '../../src/companies/repository.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { connection, experienceRule, owner, space } from '../../src/db/schema.ts';
import {
  CHASE_FOLLOW_UP_CAP,
  recordChaseScope,
  resolveChaseGrant,
  resolvePersonGrant,
} from '../../src/experience/chase-scope.ts';
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
const key = 'chase-scope-integration-key-32-bytes!';
const scopes = ['test.send', 'test.read', 'job.wait'];
const TO = 'orders@thornfieldprint.example';
const SUBJECT = 'Refund for order TP-5521';
const FIRST =
  'Your payment of GBP 534.50 was to be refunded within 5 working days. Please confirm the date.';

let runner: AttemptRunner;
let triggers: TriggerService;
let approvals: ApprovalService;
let broker: BrokerService;
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

async function claim(jobId: string): Promise<ClaimedAttempt> {
  const { jobs } = fixture();
  const claimed = await runner.claim(wake(await jobs.get(jobId)));
  if (!claimed) throw new Error('Expected an admitted attempt');
  return claimed;
}

const send = (claimed: ClaimedAttempt, payload: Record<string, JsonValue>) =>
  broker.propose(claimed.claims, { connection_id: connectionId, kind: 'test.send', payload });

/** The person answers "Allow once", and the message goes out. */
async function allowOnce(jobId: string, proposal: Awaited<ReturnType<typeof send>>) {
  expect(proposal.status).toBe('needs_approval');
  await approvals.decide(
    String(proposal.approval_id),
    { decision: 'approved', payload_hash: proposal.payload_hash },
    ownerId,
  );
  const carrying = await claim(jobId);
  await broker.admit(carrying.claims, proposal.action_id, proposal.payload_hash);
  expect((await broker.dispatch(proposal.action_id)).status).toBe('succeeded');
  return carrying;
}

/** A chase: a job handling a ledger item, as "Handle it" makes one. */
async function chase(domain = 'thornfieldprint.example') {
  const { jobs } = fixture();
  // A company and its items are written by an open scan, as a real scan writes them.
  const scan = await store.openScan(scanOwner);
  const companyId = await store.saveCompany(scanOwner, scan.id, {
    name: 'Thornfield Print',
    domain,
    monthly_spend_minor: null,
    currency: null,
    first_seen_at: '2026-09-06T09:00:00.000Z',
    last_seen_at: '2026-09-06T09:00:00.000Z',
    message_count: 1,
  });
  const quote = 'Your payment of GBP 534.50 will be refunded within 5 working days.';
  const item = {
    id: newId('li'),
    space_id: spaceId,
    principal_id: ownerId,
    company_id: companyId,
    kind: 'refund_owed' as const,
    direction: 'owed_to_you' as const,
    amount_minor: 53450,
    currency: 'GBP',
    due_at: null,
    status: 'found' as const,
    confidence: 'high' as const,
    evidence: [{ message_id: `<${newId('li')}@${domain}>`, quote, start: 0, end: quote.length }],
    suggested_playbook: 'refund-owed' as const,
    job_id: null,
    summary: 'Refund owed to you',
  };
  await store.saveItems(scanOwner, scan.id, [item]);
  await store.closeScan(scanOwner, scan.id, {
    status: 'done',
    messagesSeen: 1,
    itemsFound: 1,
    counts: {},
  });
  const company = (await store.map(scanOwner, new Date())).companies.find(
    (entry) => entry.id === companyId,
  );
  if (!company) throw new Error('Expected the company');
  const { job_id } = await handleLedgerItem(
    {
      createJob: (input) => jobs.create(input),
      createTrigger: (jobId, spec) => triggers.create(jobId, spec),
    },
    { item, company, messageText: quote, principalId: ownerId, spaceId, connectionId },
  );
  await store.setJob(scanOwner, item.id, job_id);
  return job_id;
}

/** A chase whose first message the person allowed once, with the attempt that sent it. */
async function allowedChase() {
  const jobId = await chase();
  const carrying = await allowOnce(
    jobId,
    await send(await claim(jobId), { to: TO, subject: SUBJECT, body: FIRST }),
  );
  return { jobId, carrying };
}

const followUp = (n: number, over: Record<string, JsonValue> = {}) => ({
  to: TO,
  subject: `Re: ${SUBJECT}`,
  body: `Following up (${n}) on the GBP 534.50 refund. Please confirm the date it will be paid.`,
  ...over,
});

async function sent() {
  const { handle } = fixture();
  return handle.sql`select action_id from test_destination_ledger`;
}

withDb('what one "Allow once" on a chase covers', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.background);
    await resetTestRows(handle.sql);
    await initializeTestLedger(handle.sql);
    await handle.sql`delete from test_destination_ledger`;
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
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Studio mailbox', scopes });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key, scopes });
    triggers = new TriggerService(jobs, runner);
    approvals = new ApprovalService(jobs, runner);
    broker = new BrokerService({
      sql: handle.sql,
      connectors: new ConnectorRegistry().register(connectionId, createTestConnector(handle.sql)),
      // Nothing is vouched for: a company's address came out of its own email.
      resolveTrust: createTableTrustResolver({}),
      resolveStandingGrant: resolvePersonGrant,
      resolveScopedGrant: resolveChaseGrant,
      recordStandingScope: recordChaseScope,
    });
    store = new PostgresCompanyStore(handle.db);
    scanOwner = { spaceId, principalId: ownerId };
  });

  afterAll(async () => {
    await triggers?.stop();
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('the first message asks, and its approval opens a scope for this chase alone', async () => {
    const { handle } = fixture();
    const { jobId } = await allowedChase();
    const rules = await handle.db.select().from(experienceRule);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ jobId, countCap: CHASE_FOLLOW_UP_CAP, used: 0 });
  });

  test('a follow-up to the same address in the same thread goes out without asking, as an action', async () => {
    const { handle } = fixture();
    const { carrying } = await allowedChase();
    const covered = await send(carrying, followUp(1));
    expect(covered.status).toBe('succeeded');
    expect(covered.approval_id).toBeNull();
    // It is still an effect with a receipt, not something done quietly.
    const [row] =
      await handle.sql`select status, receipt from action where id = ${covered.action_id}`;
    expect(row?.status).toBe('succeeded');
    expect(row?.receipt).not.toBeNull();
    expect(await sent()).toHaveLength(2);
  });

  test('someone copied in asks again', async () => {
    const { carrying } = await allowedChase();
    expect((await send(carrying, followUp(1, { cc: 'me@example.test' }))).status).toBe(
      'needs_approval',
    );
  });

  test('a new recipient, a new thread, a new amount or a commitment asks again', async () => {
    const { carrying } = await allowedChase();
    const changes: Record<string, JsonValue>[] = [
      { to: 'complaints@thornfieldprint.example' },
      { subject: 'Complaint about order TP-5521' },
      { body: 'Please refund GBP 600.00 including costs.' },
      { body: 'I agree to your offer of a partial refund.' },
    ];
    for (const over of changes)
      expect((await send(carrying, followUp(9, over))).status).toBe('needs_approval');
  });

  test(`it covers ${CHASE_FOLLOW_UP_CAP} follow-ups, and the next one asks`, async () => {
    const { carrying } = await allowedChase();
    for (let n = 1; n <= CHASE_FOLLOW_UP_CAP; n++)
      expect((await send(carrying, followUp(n))).status).toBe('succeeded');
    expect((await send(carrying, followUp(CHASE_FOLLOW_UP_CAP + 1))).status).toBe('needs_approval');
  });

  test('another chase to the same address is not covered', async () => {
    await allowedChase();
    const other = await chase('thornfieldprint.example');
    expect((await send(await claim(other), followUp(1))).status).toBe('needs_approval');
  });

  test('revoking the scope ends it', async () => {
    const { handle } = fixture();
    const { jobId, carrying } = await allowedChase();
    await handle.db
      .update(experienceRule)
      .set({ revokedAt: new Date() })
      .where(eq(experienceRule.jobId, jobId));
    expect((await send(carrying, followUp(1))).status).toBe('needs_approval');
  });

  test('a job that is not handling anything opens no scope', async () => {
    const { handle, jobs } = fixture();
    const plain = await jobs.create({
      space_id: spaceId,
      title: 'Write to Thornfield',
      objective: 'Ask',
    });
    const carrying = await allowOnce(
      plain.id,
      await send(await claim(plain.id), { to: TO, subject: SUBJECT, body: FIRST }),
    );
    expect(await handle.db.select().from(experienceRule)).toHaveLength(0);
    expect((await send(carrying, followUp(1))).status).toBe('needs_approval');
  });
});
