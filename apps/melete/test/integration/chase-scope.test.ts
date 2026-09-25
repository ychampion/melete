/**
 * One "Allow once" on a chase's first message, and what it covers after.
 *
 * The rule under test: the approval of a chase's first message, by the person
 * the chase belongs to, also covers up to three follow-ups in that same chase,
 * each a fixed line from the service above the approved message word for word,
 * to the same address, in the same thread. Anything else asks again. Revoking
 * the scope ends it, even between admission and sending, and so does
 * correcting the job. Each covered follow-up is still an action with a receipt.
 * The model sends one through `chase.follow_up`, which the service writes.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Action, JsonValue } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { CHASE_FOLLOW_UP_TOOL } from '../../src/broker/chase.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import { handleLedgerItem } from '../../src/companies/handle.ts';
import { type Owner, PostgresCompanyStore } from '../../src/companies/repository.ts';
import { ConnectorFaultError } from '../../src/connectors/faults.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import type { Connector } from '../../src/connectors/types.ts';
import { connection, experienceRule, owner, space } from '../../src/db/schema.ts';
import {
  CHASE_FOLLOW_UP_CAP,
  CHASE_NUDGES,
  chaseFollowUp,
  chaseFollowUpPort,
  recordChaseScope,
  resolveChaseScopedGrant,
  resolvePersonGrant,
} from '../../src/experience/chase-scope.ts';
import { ExperienceEvents } from '../../src/experience/events.ts';
import { toolId } from '../../src/experience/tools.ts';
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
const APPROVED = { to: TO, subject: SUBJECT, body: FIRST };

let runner: AttemptRunner;
let triggers: TriggerService;
let approvals: ApprovalService;
let broker: BrokerService;
let store: PostgresCompanyStore;
let scanOwner: Owner;
let spaceId = '';
let ownerId = '';
let connectionId = '';
/** What the destination does when a follow-up reaches it, before it sends. */
let meetFollowUp: ((action: Action) => Promise<void>) | null = null;

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

const followUp = (n: number, over: Record<string, JsonValue> = {}) => ({
  ...(chaseFollowUp(APPROVED, n) as Record<string, JsonValue>),
  ...over,
});

/** The test destination, with a hook on the way to any follow-up. */
function destination(inner: Connector): Connector {
  return {
    ...inner,
    async execute(action, ctx) {
      const body = String(action.canonical_payload.body ?? '');
      if (meetFollowUp && CHASE_NUDGES.some((nudge) => body.startsWith(nudge)))
        await meetFollowUp(action);
      return inner.execute(action, ctx);
    },
  };
}

/** The person answers "Allow once", and the message goes out. */
async function allowOnce(
  jobId: string,
  proposal: Awaited<ReturnType<typeof send>>,
  decidedBy = ownerId,
) {
  expect(proposal.status).toBe('needs_approval');
  await approvals.decide(
    String(proposal.approval_id),
    { decision: 'approved', payload_hash: proposal.payload_hash },
    decidedBy,
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
  const carrying = await allowOnce(jobId, await send(await claim(jobId), APPROVED));
  return { jobId, carrying };
}

async function sent() {
  const { handle } = fixture();
  return handle.sql`select action_id from test_destination_ledger`;
}

/** The chase waits, its timer passes, and a new attempt picks it up. */
async function wakeAgain(jobId: string, claimed: ClaimedAttempt) {
  await runner.commitOutcome(claimed.claims, {
    kind: 'waiting_for_event_or_time',
    wait: { kind: 'timer', wake_at: new Date(Date.now() - 1000).toISOString() },
  });
  return claim(jobId);
}

/** Whether the attempt is offered the follow-up tool. */
async function offered(claimed: ClaimedAttempt) {
  return (await broker.catalog(claimed.claims)).some(
    (tool) => tool.name === CHASE_FOLLOW_UP_TOOL.name,
  );
}

async function revoke(jobId: string) {
  const { handle } = fixture();
  await handle.db
    .update(experienceRule)
    .set({ revokedAt: new Date() })
    .where(eq(experienceRule.jobId, jobId));
}

withDb('what one "Allow once" on a chase covers', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.background);
    await resetTestRows(handle.sql);
    await initializeTestLedger(handle.sql);
    await handle.sql`delete from test_destination_ledger`;
    meetFollowUp = null;
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
      connectors: new ConnectorRegistry().register(
        connectionId,
        destination(createTestConnector(handle.sql)),
      ),
      // Nothing is vouched for: a company's address came out of its own email.
      resolveTrust: createTableTrustResolver({}),
      resolveStandingGrant: resolvePersonGrant,
      resolveScopedGrant: resolveChaseScopedGrant,
      recordStandingScope: recordChaseScope,
      chaseFollowUp: chaseFollowUpPort,
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

  test('each fixed follow-up goes out without asking, as an action with a receipt', async () => {
    const { handle } = fixture();
    const { carrying } = await allowedChase();
    for (let n = 1; n <= CHASE_FOLLOW_UP_CAP; n++) {
      const covered = await send(carrying, followUp(n));
      expect(covered.status).toBe('succeeded');
      expect(covered.approval_id).toBeNull();
      const [row] =
        await handle.sql`select status, receipt from action where id = ${covered.action_id}`;
      expect(row?.status).toBe('succeeded');
      expect(row?.receipt).not.toBeNull();
    }
    expect(await sent()).toHaveLength(1 + CHASE_FOLLOW_UP_CAP);
  });

  test('anything but the fixed shape asks again', async () => {
    const { carrying } = await allowedChase();
    const changes: Record<string, JsonValue>[] = [
      { cc: 'me@example.test' },
      { to: 'complaints@thornfieldprint.example' },
      { subject: 'Complaint about order TP-5521' },
      { body: `Just checking in.\n\n${FIRST}` },
      { body: `${CHASE_NUDGES[0]}\n\n${FIRST}\n\nI agree to a partial refund.` },
    ];
    for (const over of changes)
      expect((await send(carrying, followUp(1, over))).status).toBe('needs_approval');
  });

  test('the cap is the cap', async () => {
    const { handle } = fixture();
    const { jobId, carrying } = await allowedChase();
    await handle.db
      .update(experienceRule)
      .set({ countCap: 1 })
      .where(eq(experienceRule.jobId, jobId));
    expect((await send(carrying, followUp(1))).status).toBe('succeeded');
    expect((await send(carrying, followUp(2))).status).toBe('needs_approval');
  });

  test('another chase to the same address is not covered', async () => {
    await allowedChase();
    const other = await chase('thornfieldprint.example');
    expect((await send(await claim(other), followUp(1))).status).toBe('needs_approval');
  });

  test('revoking the scope ends it', async () => {
    const { jobId, carrying } = await allowedChase();
    await revoke(jobId);
    expect((await send(carrying, followUp(1))).status).toBe('needs_approval');
  });

  test('a follow-up held back by the destination is refused if the scope is revoked meanwhile', async () => {
    const { jobId, carrying } = await allowedChase();
    // The destination asks to be left alone, so the admitted follow-up waits.
    let parked = false;
    meetFollowUp = async () => {
      if (parked) return;
      parked = true;
      throw new ConnectorFaultError({
        kind: 'rate_limited',
        detail: 'the destination asked to be left alone for a while',
        retry_after: 60,
      });
    };
    const held = await send(carrying, followUp(1));
    expect(held.status).not.toBe('succeeded');
    await revoke(jobId);
    const later = await broker.dispatch(held.action_id, Date.now() + 120_000);
    expect(later.status).not.toBe('succeeded');
    expect(await sent()).toHaveLength(1);
  });

  test('a follow-up whose first try failed is not retried once the scope is revoked', async () => {
    const { jobId, carrying } = await allowedChase();
    let tries = 0;
    meetFollowUp = async () => {
      tries += 1;
      if (tries > 1) return;
      // The person revokes while the first try is on the wire, and it fails.
      await revoke(jobId);
      throw new ConnectorFaultError({
        kind: 'transient_before_dispatch',
        detail: 'the socket closed before the send',
      });
    };
    const attempt = await send(carrying, followUp(1));
    expect(attempt.status).not.toBe('succeeded');
    expect(tries).toBe(1);
    expect(await sent()).toHaveLength(1);
  });

  test('correcting the chase ends the scope', async () => {
    const { jobs } = fixture();
    const { jobId, carrying } = await allowedChase();
    // The chase goes quiet, and the person corrects what it is for.
    await runner.commitOutcome(carrying.claims, {
      kind: 'waiting_for_event_or_time',
      wait: { kind: 'timer', wake_at: new Date(Date.now() - 1000).toISOString() },
    });
    await jobs.revise(jobId, { objective: 'Ask for the refund to go to a different card.' });
    const next = await claim(jobId);
    expect((await send(next, followUp(1))).status).toBe('needs_approval');
  });

  test('an approval given by anyone but the chase’s own person opens nothing', async () => {
    const { handle } = fixture();
    const jobId = await chase();
    const proposal = await send(await claim(jobId), APPROVED);
    await approvals.decide(
      String(proposal.approval_id),
      { decision: 'approved', payload_hash: proposal.payload_hash },
      ownerId,
    );
    // Recorded as decided by someone else, however that came to be.
    const stranger = newId('own');
    await handle.sql`insert into principal (id, email, password_hash)
      values (${stranger}, 'stranger@example.test', 'fixture')`;
    await handle.sql`update approval set decided_by = ${stranger} where id = ${proposal.approval_id}`;
    const carrying = await claim(jobId);
    await broker.admit(carrying.claims, proposal.action_id, proposal.payload_hash);
    expect((await broker.dispatch(proposal.action_id)).status).toBe('succeeded');
    expect(await handle.db.select().from(experienceRule)).toHaveLength(0);
    expect((await send(carrying, followUp(1))).status).toBe('needs_approval');
  });

  test('a job that is not handling anything opens no scope', async () => {
    const { handle, jobs } = fixture();
    const plain = await jobs.create({
      space_id: spaceId,
      title: 'Write to Thornfield',
      objective: 'Ask',
    });
    const carrying = await allowOnce(plain.id, await send(await claim(plain.id), APPROVED));
    expect(await handle.db.select().from(experienceRule)).toHaveLength(0);
    expect((await send(carrying, followUp(1))).status).toBe('needs_approval');
  });

  test('a follow-up through the tool goes out without asking and shows as a tool entry', async () => {
    const { handle, jobs } = fixture();
    const { jobId, carrying } = await allowedChase();
    // The chase is shown in a conversation, as its tool entries are.
    const chat = await jobs.create({ space_id: spaceId, title: 'Refunds', objective: 'Chat' });
    await handle.sql`update job set kind = 'chat' where id = ${chat.id}`;
    await handle.sql`update job set experience_parent_id = ${chat.id} where id = ${jobId}`;
    let attempt = carrying;
    expect(await offered(attempt)).toBe(true);
    for (let n = 1; n <= CHASE_FOLLOW_UP_CAP; n++) {
      // One follow-up per wake.
      if (n > 1) attempt = await wakeAgain(jobId, attempt);
      const covered = await broker.followUp(attempt.claims);
      expect(covered.status).toBe('succeeded');
      expect(covered.approval_id).toBeNull();
      const [row] = await handle.sql`select kind, canonical_payload, receipt from action
        where id = ${covered.action_id}`;
      expect(row?.kind).toBe('test.send');
      expect(row?.canonical_payload).toEqual(chaseFollowUp(APPROVED, n));
      expect(row?.receipt).not.toBeNull();
      const page = await new ExperienceEvents(handle.db).page(spaceId, 0, chat.id, 200, ownerId);
      const entry = page.events
        .flatMap((event) => (event.item.type === 'tool' ? [event.item.tool] : []))
        .filter((tool) => tool.id === toolId('action', covered.action_id))
        .at(-1);
      expect(entry?.status).toBe('done');
      // Asking again before the next wake is the same follow-up, not another.
      expect((await broker.followUp(attempt.claims)).action_id).toBe(covered.action_id);
    }
    expect(await sent()).toHaveLength(1 + CHASE_FOLLOW_UP_CAP);
    // Every covered follow-up is used, so the tool is gone and asking for one is refused.
    const after = await wakeAgain(jobId, attempt);
    expect(await offered(after)).toBe(false);
    const refused = await broker.followUp(after.claims).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'unknown_tool' });
  });

  test('two follow-ups asked for at once send one', async () => {
    const { handle } = fixture();
    const { jobId, carrying } = await allowedChase();
    const [one, two] = await Promise.all([
      broker.followUp(carrying.claims),
      broker.followUp(carrying.claims),
    ]);
    expect(one.action_id).toBe(two.action_id);
    const actions = await handle.sql`select id from action where job_id = ${jobId}`;
    expect(actions).toHaveLength(2);
    expect(await sent()).toHaveLength(2);
    const [rule] = await handle.db
      .select()
      .from(experienceRule)
      .where(eq(experienceRule.jobId, jobId));
    expect(rule?.used).toBe(1);
  });

  test('a follow-up the model writes itself still asks', async () => {
    const { carrying } = await allowedChase();
    const written = await send(carrying, {
      to: TO,
      subject: `Re: ${SUBJECT}`,
      body: `Hello again. Any news on the refund?

${FIRST}`,
    });
    expect(written.status).toBe('needs_approval');
    expect(await sent()).toHaveLength(1);
  });

  test('the tool is offered only while the chase has a scope open', async () => {
    const { jobs } = fixture();
    const unasked = await chase('quillmark.example');
    const first = await claim(unasked);
    expect(await offered(first)).toBe(false);
    expect(await broker.followUp(first.claims).catch((error: unknown) => error)).toMatchObject({
      code: 'unknown_tool',
    });

    const { jobId, carrying } = await allowedChase();
    expect(await offered(carrying)).toBe(true);
    await revoke(jobId);
    expect(await offered(carrying)).toBe(false);
    expect(await broker.followUp(carrying.claims).catch((error: unknown) => error)).toMatchObject({
      code: 'unknown_tool',
    });

    const plain = await jobs.create({ space_id: spaceId, title: 'Write', objective: 'Ask' });
    const allowed = await allowOnce(plain.id, await send(await claim(plain.id), APPROVED));
    expect(await offered(allowed)).toBe(false);
  });
});
