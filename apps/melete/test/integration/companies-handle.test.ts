/**
 * Handling a ledger item end to end, on the machinery that already exists.
 *
 * Nothing here stubs the job service, the trigger service, the broker or the
 * approval path: the point of these tests is that dealing with a company is
 * made of the same parts as everything else, and that the one way out of the
 * machine is still the broker's.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Company, LedgerItem, WaitSpec } from '@melete/contracts';
import { ServiceError } from '../../src/api/errors.ts';
import { BrokerService } from '../../src/broker/service.ts';
import { createTableTrustResolver } from '../../src/broker/trust.ts';
import {
  handleLedgerItem,
  PLAYBOOK_FOR_KIND,
  REPLY_EVENT_NAME,
} from '../../src/companies/handle.ts';
import { ConnectorRegistry } from '../../src/connectors/registry.ts';
import { createTestConnector, initializeTestLedger } from '../../src/connectors/test.ts';
import { connection, owner, space, trigger } from '../../src/db/schema.ts';
import { ExperienceEffects } from '../../src/experience/effects.ts';
import { ExperiencePermissions } from '../../src/experience/permissions.ts';
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
const key = 'companies-handle-integration-key-32-bytes';
const scopes = ['test.send', 'test.read', 'job.wait'];
/** The person's own mailbox: what the message goes out as. */
const SENDER = 'jo@example.test';

let runner: AttemptRunner;
let triggers: TriggerService;
let approvals: ApprovalService;
let broker: BrokerService;
let permissions: ExperiencePermissions;
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

/** The exact stored message an item's evidence spans index into. */
const MESSAGE = [
  'Hello,',
  '',
  'Your order 7781 was cancelled on 2 September.',
  'We will refund you within 5-7 working days.',
  '',
  'Acme Support',
].join('\n');
const QUOTE = 'We will refund you within 5-7 working days.';
const QUOTE_AT = MESSAGE.indexOf(QUOTE);

function company(overrides: Partial<Company> = {}): Company {
  const now = new Date().toISOString();
  return {
    id: newId('co'),
    space_id: spaceId,
    name: 'Acme',
    domain: 'acme.test',
    monthly_spend_minor: null,
    currency: null,
    first_seen_at: now,
    last_seen_at: now,
    message_count: 4,
    ...overrides,
  };
}

function item(co: Company, overrides: Partial<LedgerItem> = {}): LedgerItem {
  return {
    id: newId('li'),
    space_id: spaceId,
    principal_id: ownerId,
    company_id: co.id,
    kind: 'refund_owed',
    direction: 'owed_to_you',
    amount_minor: 4999,
    currency: 'GBP',
    due_at: null,
    status: 'found',
    confidence: 'high',
    evidence: [
      {
        message_id: 'msg-7781@acme.test',
        quote: QUOTE,
        start: QUOTE_AT,
        end: QUOTE_AT + QUOTE.length,
      },
    ],
    suggested_playbook: 'refund-owed',
    job_id: null,
    summary: 'Refund for the cancelled order',
    ...overrides,
  };
}

/** The dependency set the integrator wires: real creation, real triggers. */
function deps(
  changes: Parameters<NonNullable<Parameters<typeof handleLedgerItem>[0]['onStatusChange']>>[0][],
) {
  const { jobs } = fixture();
  return {
    createJob: (input: Parameters<JobService['create']>[0]) => jobs.create(input),
    createTrigger: (jobId: string, spec: Parameters<TriggerService['create']>[1]) =>
      triggers.create(jobId, spec),
    onStatusChange: async (change: (typeof changes)[number]) => {
      changes.push(change);
    },
  };
}

async function started(overrides: Partial<LedgerItem> = {}) {
  const changes: Parameters<
    NonNullable<Parameters<typeof handleLedgerItem>[0]['onStatusChange']>
  >[0][] = [];
  const co = company();
  const li = item(co, overrides);
  const result = await handleLedgerItem(deps(changes), {
    item: li,
    company: co,
    messageText: MESSAGE,
    principalId: ownerId,
    spaceId,
    connectionId,
  });
  return { changes, company: co, item: li, ...result };
}

async function refusal(operation: () => Promise<unknown>): Promise<ServiceError> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ServiceError);
  return caught as ServiceError;
}

/** The first message out, proposed the way an attempt proposes it. */
async function propose(claimed: ClaimedAttempt, body: string) {
  return broker.propose(claimed.claims, {
    connection_id: connectionId,
    kind: 'test.send',
    payload: { to: 'support@acme.test', subject: 'Refund for order 7781', body },
  });
}

const FIRST_MESSAGE = [
  'Hello,',
  '',
  'I cancelled order 7781 on 2 September and the refund has not arrived.',
  'Your email says: "We will refund you within 5-7 working days."',
  'That is 49.99 GBP. Please let me know the date it will be paid.',
  '',
  'Thanks',
].join('\n');

async function sent(actionId: string) {
  const { handle } = fixture();
  return handle.sql`select action_id from test_destination_ledger where action_id = ${actionId}`;
}

/**
 * The whole way out, as it actually happens: the attempt proposes, the job stops
 * and waits for the person, their yes queues it again, and the attempt that
 * picks it up is the one that carries it out.
 */
async function approveAndDispatch(claimed: ClaimedAttempt, jobId: string, body: string) {
  const { jobs } = fixture();
  const proposal = await propose(claimed, body);
  expect(proposal.status).toBe('needs_approval');
  expect((await jobs.get(jobId)).state).toBe('waiting_for_approval');
  await approvals.decide(
    String(proposal.approval_id),
    { decision: 'approved', payload_hash: proposal.payload_hash },
    ownerId,
  );
  const carrying = await claim(await jobs.get(jobId));
  await broker.admit(carrying.claims, proposal.action_id, proposal.payload_hash);
  const dispatched = await broker.dispatch(proposal.action_id);
  expect(dispatched.status).toBe('succeeded');
  expect(dispatched.receipt?.action_id).toBe(proposal.action_id);
  return { proposal, claimed: carrying };
}

/** The same, starting from a job nobody has claimed yet. */
async function sendApproved(row: JobRow, body: string) {
  return approveAndDispatch(await claim(row), row.id, body);
}

withDb('handing one ledger item to a playbook', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.background);
    await queue.boss.deleteAllJobs(QUEUES.triggerSchedule);
    await resetTestRows(handle.sql);
    await initializeTestLedger(handle.sql);
    await handle.sql`delete from test_destination_ledger`;
    spaceId = newId('sp');
    ownerId = newId('own');
    connectionId = newId('conn');
    await handle.db
      .insert(owner)
      .values({ id: ownerId, email: 'owner@example.test', passwordHash: 'fixture' });
    await handle.sql`insert into principal (id, email, password_hash) select id, email, password_hash from owner`;
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db.insert(connection).values({
      id: connectionId,
      spaceId,
      provider: 'test',
      label: 'Scripted mailbox',
      scopes,
      // Shaped like a mailbox a person installed, so the card can say which
      // address the message leaves from.
      configuration: { kind: 'mail', mail: { from: SENDER } },
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
      // Nothing is pre-trusted: the destination is an address read out of mail,
      // so the first message must still be put to the person.
      resolveTrust: createTableTrustResolver({}),
    });
    permissions = new ExperiencePermissions(
      handle.sql,
      broker,
      new ExperienceEffects(handle.sql, broker, registry),
    );
  });

  afterEach(async () => {
    await triggers.stop();
    await runner.stop();
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('an item becomes a job carrying its playbook, its quotes and the company it may read', async () => {
    const { jobs, handle } = fixture();
    const start = await started();
    const row = await jobs.get(start.job_id);
    expect(row.spaceId).toBe(spaceId);
    expect(row.principalId).toBe(ownerId);
    expect(row.objective).toContain('refund-owed');
    expect(row.objective).toContain(QUOTE);
    expect(row.objective).toContain('Acme (acme.test)');
    expect(row.objective).toContain(start.item.id);
    // The body of an untrusted email never becomes part of the instructions.
    expect(row.objective).not.toContain('Acme Support');
    const constraints = row.constraints as {
      allowed_domains: string[];
      deliverable: { kind: string; connection_id?: string };
    };
    expect(constraints.allowed_domains).toEqual(['acme.test', 'www.acme.test']);
    expect(constraints.deliverable).toEqual({
      kind: 'message_sent',
      connection_id: connectionId,
    });
    expect(start.changes).toEqual([
      {
        item_id: start.item.id,
        space_id: spaceId,
        principal_id: ownerId,
        job_id: start.job_id,
        status: 'handling',
      },
    ]);
    const registered = await handle.db.select().from(trigger);
    expect(registered).toHaveLength(1);
    const reply = registered[0];
    if (!reply) throw new Error('Expected the reply trigger');
    expect(reply.jobId).toBe(start.job_id);
    expect((reply.spec as { event_name: string }).event_name).toBe(REPLY_EVENT_NAME);
  });

  test('the attempt that picks it up has the playbook in front of it and a reply to wait for', async () => {
    const { jobs } = fixture();
    const start = await started();
    const claimed = await claim(await jobs.get(start.job_id));
    expect(claimed.bundle.skills.map((skill) => skill.name)).toContain('refund-owed');
    expect(claimed.bundle.skills[0]?.body).toContain('Never send the same message');
    expect((claimed.bundle.job.triggers ?? []).map((entry) => entry.event_name)).toEqual([
      REPLY_EVENT_NAME,
    ]);
  });

  test('every kind with a playbook picks it, and one without is refused rather than guessed at', async () => {
    for (const [kind, playbook] of Object.entries(PLAYBOOK_FOR_KIND)) {
      const start = await started({
        kind: kind as LedgerItem['kind'],
        suggested_playbook: null,
      });
      const row = await fixture().jobs.get(start.job_id);
      expect(row.objective).toContain(`Playbook: ${playbook}.`);
    }
    const refused = await refusal(() => started({ kind: 'data_held', suggested_playbook: null }));
    expect(refused.code).toBe('no_playbook');
  });

  test('a quote that no longer sits where it claims to sit stops the whole thing', async () => {
    const { handle } = fixture();
    const refused = await refusal(() =>
      started({
        evidence: [{ message_id: 'msg-7781@acme.test', quote: QUOTE, start: 0, end: QUOTE.length }],
      }),
    );
    expect(refused.code).toBe('evidence_failed');
    expect(await handle.sql`select id from job`).toHaveLength(0);
  });

  test('an item belonging to another space or person is refused before any job exists', async () => {
    const { handle } = fixture();
    const co = company();
    for (const bad of [
      { item: item(co, { space_id: newId('sp') }), code: 'scope_denied' },
      { item: item(co, { principal_id: newId('own') }), code: 'scope_denied' },
      { item: item(co, { company_id: newId('co') }), code: 'invalid_request' },
      { item: item(co, { job_id: newId('job') }), code: 'already_handling' },
      { item: item(co, { status: 'settled' as const }), code: 'already_terminal' },
    ]) {
      const refused = await refusal(() =>
        handleLedgerItem(deps([]), {
          item: bad.item,
          company: co,
          messageText: MESSAGE,
          principalId: ownerId,
          spaceId,
          connectionId,
        }),
      );
      expect(refused.code).toBe(bad.code);
    }
    expect(await handle.sql`select id from job`).toHaveLength(0);
  });

  test('the first message out parks an approval showing the whole text and who it goes to', async () => {
    const { jobs, handle } = fixture();
    const start = await started();
    const claimed = await claim(await jobs.get(start.job_id));
    const proposal = await propose(claimed, FIRST_MESSAGE);
    expect(proposal.status).toBe('needs_approval');
    expect(proposal.requires_approval).toBe(true);
    expect(proposal.approval_id).not.toBeNull();
    expect(await sent(proposal.action_id)).toHaveLength(0);

    // The approval is bound to these exact bytes, not to the action.
    const [bound] =
      await handle.sql`select payload_hash from approval where id = ${proposal.approval_id}`;
    expect(bound?.payload_hash).toBe(proposal.payload_hash);

    const card = await permissions.card(spaceId, String(proposal.approval_id));
    expect(card.draft?.recipient).toBe('support@acme.test');
    expect(card.draft?.body).toBe(FIRST_MESSAGE);
    const preview = card.preview;
    if (!preview) throw new Error('Expected the permission to carry a preview');
    const facts = Object.fromEntries(preview.facts.map((f) => [f.label, f.value]));
    // Which mailbox it leaves from, who it goes to, and every word of it.
    expect(facts.From).toBe(SENDER);
    expect(facts.To).toBe('support@acme.test');
    expect(facts.Subject).toBe('Refund for order 7781');
    expect(facts.Message).toContain('the refund has not arrived');
    expect(preview.facts.map((f) => f.label).slice(0, 2)).toEqual(['From', 'To']);
    expect(preview.source_connection).toBe(connectionId);
    expect(card.options).toContain('allow_once');
  });

  test('approval sends it once, leaves a receipt, and a second identical send is refused', async () => {
    const { jobs, handle } = fixture();
    const start = await started();
    const { proposal, claimed } = await sendApproved(await jobs.get(start.job_id), FIRST_MESSAGE);
    expect(await sent(proposal.action_id)).toHaveLength(1);

    // The same words again are the same effect, and the same effect happens once.
    const again = await propose(claimed, FIRST_MESSAGE);
    expect(again.action_id).toBe(proposal.action_id);
    expect(again.repeated).toBe(true);
    expect(await sent(proposal.action_id)).toHaveLength(1);
    expect(await handle.sql`select id from action where kind = 'test.send'`).toHaveLength(1);

    // A follow-up is different words, so it is a different effect and needs its
    // own approval. It is the cadence, not the machinery, that keeps it to one.
    const followUp = await propose(claimed, `${FIRST_MESSAGE}\n\nJust following this up.`);
    expect(followUp.action_id).not.toBe(proposal.action_id);
    expect(followUp.status).toBe('needs_approval');
    expect(await sent(followUp.action_id)).toHaveLength(0);
  });

  test('silence wakes it once at the cadence deadline and a reply wakes it as soon as it lands', async () => {
    const { jobs, handle } = fixture();
    const start = await started();
    const row = await jobs.get(start.job_id);
    const [registration] = await handle.db.select().from(trigger);
    if (!registration) throw new Error('Expected the reply trigger');
    const { proposal: message, claimed } = await sendApproved(row, FIRST_MESSAGE);
    const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const wait: WaitSpec = {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: deadline,
    };
    const waiting = await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      wait,
    });
    expect(waiting.state).toBe('waiting_for_event_or_time');
    // Nothing arrives: the deadline is the follow-up, and it is one wake.
    expect(waiting.nextWakeAt?.toISOString()).toBe(deadline);
    // A chase is background work, so its wake is on the background queue.
    const wakes =
      await handle.sql`select start_after from pgboss.job where name = ${QUEUES.background}
        and data->>'job_id' = ${waiting.id} and (data->>'expected_version')::int = ${waiting.stateVersion}`;
    expect(wakes).toHaveLength(1);
    expect(new Date(wakes[0]?.start_after).toISOString()).toBe(deadline);
    // And until that deadline, silence keeps its quiet: nothing wakes early.
    expect(await runner.claim(wake(waiting))).toBeNull();

    const reply = () =>
      triggers.deliver({
        connection_id: connectionId,
        event_name: REPLY_EVENT_NAME,
        cursor: 'acme-1',
        dedup_key: 'acme-reply-1',
        payload: { from: 'support@acme.test', subject: 'Re: Refund for order 7781' },
      });
    const received = await reply();
    expect(received.duplicate).toBe(false);
    const woken = await jobs.get(waiting.id);
    expect(woken.state).toBe('queued');
    // The same reply delivered twice is still one wake.
    expect(await reply()).toEqual({ ...received, duplicate: true });
    expect((await jobs.get(waiting.id)).stateVersion).toBe(woken.stateVersion);

    const next = await claim(woken);
    expect(next.bundle.inputs.trigger_events).toHaveLength(1);
    expect(next.bundle.inputs.trigger_events[0]).toMatchObject({
      kind: 'connector_event',
      event_name: REPLY_EVENT_NAME,
    });
    // Saying it is settled is not settling it. With nothing to point at, the
    // job is held open and the person is asked instead.
    const unevidenced = await runner.commitOutcome(next.claims, {
      kind: 'completed',
      summary: 'Acme paid the refund on 14 September.',
      evidence: [],
    });
    expect(unevidenced.state).toBe('waiting_for_input');

    // The person answers, and pointing at the message that actually went out
    // is what settles it.
    await jobs.input(unevidenced.id, 'They paid it, close this off.');
    const resumed = await claim(await jobs.get(unevidenced.id));
    const settled = await runner.commitOutcome(resumed.claims, {
      kind: 'completed',
      summary: 'Acme paid the refund on 14 September.',
      evidence: [{ kind: 'action', action_id: message.action_id }],
    });
    expect(settled.state).toBe('completed');
  });

  test('a window that runs out with no reply brings it back for one follow-up', async () => {
    const { jobs, handle } = fixture();
    const start = await started();
    const row = await jobs.get(start.job_id);
    const [registration] = await handle.db.select().from(trigger);
    if (!registration) throw new Error('Expected the reply trigger');
    const { proposal: first, claimed } = await sendApproved(row, FIRST_MESSAGE);

    // The cadence window has run out and the company never wrote back. This is
    // the path that carries the work when no mail feed is delivering replies:
    // the deadline alone is enough to bring the job back.
    const elapsed = await runner.commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      wait: {
        kind: 'event',
        trigger_id: registration.id,
        deadline_at: new Date(Date.now() - 1000).toISOString(),
      } satisfies WaitSpec,
    });
    const resumed = await claim(elapsed);
    // Nothing came in, so there is nothing to read; it is the deadline talking.
    expect(resumed.bundle.inputs.trigger_events).toEqual([]);
    expect(resumed.bundle.skills.map((skill) => skill.name)).toContain('refund-owed');

    const followUp = await approveAndDispatch(
      resumed,
      elapsed.id,
      `${FIRST_MESSAGE}\n\nJust following this up.`,
    );
    expect(followUp.proposal.action_id).not.toBe(first.action_id);
    expect(await sent(followUp.proposal.action_id)).toHaveLength(1);
    // The first message and one follow-up. Not two.
    expect(await handle.sql`select id from action where kind = 'test.send'`).toHaveLength(2);
  });

  test('stopping halts the message that was waiting for permission', async () => {
    const { jobs } = fixture();
    const start = await started();
    const claimed = await claim(await jobs.get(start.job_id));
    const proposal = await propose(claimed, FIRST_MESSAGE);
    await jobs.cancel(start.job_id, 'the person said stop');

    const refused = await refusal(() =>
      approvals.decide(
        String(proposal.approval_id),
        { decision: 'approved', payload_hash: proposal.payload_hash },
        ownerId,
      ),
    );
    expect(refused.code).toBe('already_terminal');
    expect(await sent(proposal.action_id)).toHaveLength(0);
  });
});

/** Nothing in this suite may reach for a mailbox that is not the broker's. */
test('the handle flow adds no second way to send', async () => {
  const source = await Bun.file(new URL('../../src/companies/handle.ts', import.meta.url)).text();
  for (const forbidden of ['nodemailer', 'ImapSmtpTransport', 'asMailer', 'transport.send']) {
    expect(source).not.toContain(forbidden);
  }
  expect(source).not.toContain('fetch(');
});
