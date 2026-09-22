/**
 * Noticing a reply, on the real trigger and wait machinery.
 *
 * The three things that must hold: a reply wakes the chase once, the same reply
 * seen again wakes nothing, and mail from anyone else is not a reply at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Company, LedgerItem } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { handleLedgerItem } from '../../src/companies/handle.ts';
import {
  CompanyReplyPoller,
  candidatesFrom,
  companyDomain,
  deliverReplies,
  fixtureReplyMailbox,
  fromAddress,
  isReplyFrom,
  REPLY_EVENT_NAME,
  type ReplyCandidate,
  type ReplyMessage,
  readCandidates,
  registrableDomain,
} from '../../src/companies/replies.ts';
import { action, connection, owner, space, trigger } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
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
const key = 'companies-replies-integration-key-32-bytes';
const scopes = ['test.send', 'test.read', 'job.wait'];

let runner: AttemptRunner;
let triggers: TriggerService;
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

const MESSAGE = 'Your order 7781 was cancelled.\nWe will refund you within 5-7 working days.';
const QUOTE = 'We will refund you within 5-7 working days.';
const QUOTE_AT = MESSAGE.indexOf(QUOTE);
const SENT_AT = '2026-09-18T09:00:00.000Z';

function company(domain = 'acme.test'): Company {
  return {
    id: newId('co'),
    space_id: spaceId,
    name: 'Acme',
    domain,
    monthly_spend_minor: null,
    currency: null,
    first_seen_at: SENT_AT,
    last_seen_at: SENT_AT,
    message_count: 4,
    ...{},
  };
}

function item(co: Company): LedgerItem {
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
  };
}

/** A chase that has already written to the company and is waiting on a reply. */
async function waitingChase(domain = 'acme.test', mailbox = connectionId) {
  const { jobs, handle } = fixture();
  const co = company(domain);
  const { job_id } = await handleLedgerItem(
    {
      createJob: (input) => jobs.create(input),
      createTrigger: (jobId, spec) => triggers.create(jobId, spec),
    },
    {
      item: item(co),
      company: co,
      messageText: MESSAGE,
      principalId: ownerId,
      spaceId,
      connectionId: mailbox,
    },
  );
  const [registration] = await handle.db.select().from(trigger).where(eq(trigger.jobId, job_id));
  if (!registration) throw new Error('Expected the reply trigger');
  const claimed = await claim(await jobs.get(job_id));
  // The first message, already gone out: a succeeded send with a resolved time
  // is what makes this job something a reply can be about.
  const sendId = newId('act');
  await handle.db.insert(action).values({
    id: sendId,
    jobId: job_id,
    attemptId: claimed.claims.attempt_id,
    connectionId: mailbox,
    kind: 'test.send',
    effectClass: 'write_external',
    canonicalPayload: { to: 'support@acme.test', subject: 'Refund', body: 'Please refund me.' },
    payloadHash: 'x'.repeat(64),
    status: 'succeeded',
    idempotencyKey: sendId,
    resolvedAt: new Date(SENT_AT),
  });
  // Park it on the wait a reply is supposed to end.
  const waiting = await runner.commitOutcome(claimed.claims, {
    kind: 'waiting_for_event_or_time',
    wait: {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: new Date(Date.parse(SENT_AT) + 7 * 86_400_000).toISOString(),
    },
  });
  expect(waiting.state).toBe('waiting_for_event_or_time');
  return { jobId: job_id, triggerId: registration.id, waiting };
}

const reply = (overrides: Partial<ReplyMessage> = {}): ReplyMessage => ({
  messageId: '<reply-1@acme.test>',
  from: 'Acme Support <support@acme.test>',
  subject: 'Re: Refund',
  receivedAt: '2026-09-18T11:00:00.000Z',
  ...overrides,
});

function poller(messages: readonly ReplyMessage[]) {
  const { handle } = fixture();
  return new CompanyReplyPoller({
    sql: handle.sql,
    triggers,
    mailboxFor: () => fixtureReplyMailbox(messages),
  });
}

withDb('noticing that a company wrote back', () => {
  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    await queue.boss.deleteAllJobs(QUEUES.attempt);
    await queue.boss.deleteAllJobs(QUEUES.background);
    await resetTestRows(handle.sql);
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
    });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key, scopes });
    triggers = new TriggerService(jobs, runner);
  });

  afterEach(async () => {
    await triggers.stop();
    await runner.stop();
  });
  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('a chase that has written and is waiting is what the poller looks for', async () => {
    const { handle } = fixture();
    const chase = await waitingChase();
    const candidates = await readCandidates(handle.sql);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      jobId: chase.jobId,
      spaceId,
      connectionId,
      triggerId: chase.triggerId,
      domain: 'acme.test',
      since: SENT_AT,
    });
  });

  test('a reply wakes the chase, exactly once', async () => {
    const { jobs } = fixture();
    const chase = await waitingChase();
    const before = await jobs.get(chase.jobId);
    expect(before.state).toBe('waiting_for_event_or_time');

    expect(await poller([reply()]).runOnce()).toBe(1);
    const woken = await jobs.get(chase.jobId);
    expect(woken.state).toBe('queued');

    // The attempt that picks it up is told what arrived.
    const next = await claim(woken);
    expect(next.bundle.inputs.trigger_events).toHaveLength(1);
    expect(next.bundle.inputs.trigger_events[0]).toMatchObject({
      kind: 'connector_event',
      event_name: REPLY_EVENT_NAME,
    });
  });

  test('the same reply seen again is not a second wake', async () => {
    const { jobs, handle } = fixture();
    const chase = await waitingChase();
    const again = poller([reply()]);
    expect(await again.runOnce()).toBe(1);
    const woken = await jobs.get(chase.jobId);

    // Polls two and three see the same message sitting in the mailbox, whether
    // the whole pass runs or the integrator drives one candidate directly.
    expect(await again.runOnce()).toBe(0);
    const [candidate] = await readCandidates(handle.sql);
    if (!candidate) throw new Error('Expected the chase to still be a candidate');
    expect(
      await deliverReplies(
        { triggers, mailboxFor: () => fixtureReplyMailbox([reply()]) },
        candidate,
      ),
    ).toBe(0);
    expect((await jobs.get(chase.jobId)).stateVersion).toBe(woken.stateVersion);
    const events = await handle.sql`select seq from event
      where dedup_key = ${`connector:${connectionId}:<reply-1@acme.test>`}`;
    expect(events).toHaveLength(1);
  });

  test('mail from anyone else is not a reply', async () => {
    const { jobs } = fixture();
    const chase = await waitingChase();
    const before = await jobs.get(chase.jobId);
    const strangers = [
      reply({ messageId: '<n1@other.test>', from: 'Someone <hello@other.test>' }),
      // The right company, but it arrived before we ever wrote.
      reply({ messageId: '<n2@acme.test>', receivedAt: '2026-09-18T08:00:00.000Z' }),
      // A lookalike domain is a different company.
      reply({ messageId: '<n3@acme.test.evil.test>', from: 'Acme <billing@acme.test.evil.test>' }),
      // No message id, so nothing that could be delivered once.
      reply({ messageId: '' }),
    ];
    expect(await poller(strangers).runOnce()).toBe(0);
    const after = await jobs.get(chase.jobId);
    expect(after.state).toBe('waiting_for_event_or_time');
    expect(after.stateVersion).toBe(before.stateVersion);
  });

  test('a reply from one company does not wake the chase with another', async () => {
    const { jobs } = fixture();
    const acme = await waitingChase('acme.test');
    const other = await waitingChase('other.test');
    const before = await jobs.get(other.jobId);
    // One mailbox, two chases on it. Acme writes back; the other company has not.
    expect(await poller([reply()]).runOnce()).toBe(1);
    expect((await jobs.get(acme.jobId)).state).toBe('queued');
    const after = await jobs.get(other.jobId);
    expect(after.state).toBe('waiting_for_event_or_time');
    expect(after.stateVersion).toBe(before.stateVersion);
    // And when the other company does write, its own chase is the one that wakes.
    expect(
      await poller([
        reply({ messageId: '<o1@other.test>', from: 'Other Ltd <help@other.test>' }),
      ]).runOnce(),
    ).toBe(1);
    expect((await jobs.get(other.jobId)).state).toBe('queued');
  });

  test('a subdomain of the company is still the company', async () => {
    const { jobs } = fixture();
    const chase = await waitingChase();
    expect(
      await poller([reply({ from: 'Acme Billing <no-reply@billing.acme.test>' })]).runOnce(),
    ).toBe(1);
    expect((await jobs.get(chase.jobId)).state).toBe('queued');
  });

  test('a finished chase is left alone', async () => {
    const { jobs, handle } = fixture();
    const chase = await waitingChase();
    await jobs.cancel(chase.jobId, 'the person said stop');
    expect(await readCandidates(handle.sql)).toHaveLength(0);
    expect(await poller([reply()]).runOnce()).toBe(0);
  });
});

test('who sent it, and whether it answers us', () => {
  expect(fromAddress('Acme Support <support@acme.test>')).toBe('support@acme.test');
  expect(fromAddress('support@acme.test')).toBe('support@acme.test');
  expect(fromAddress('Acme Support')).toBeNull();
  expect(registrableDomain('no-reply@billing.acme.test')).toBe('acme.test');
  expect(registrableDomain('someone@shop.acme.co.uk')).toBe('acme.co.uk');
  expect(registrableDomain('nonsense')).toBeNull();
  // The bare domain is the company; the `www.` form beside it is the same one.
  expect(companyDomain(['acme.test', 'www.acme.test'])).toBe('acme.test');
  expect(companyDomain(['www.acme.test'])).toBe('acme.test');
  expect(companyDomain([])).toBeNull();

  const candidate: Pick<ReplyCandidate, 'domain' | 'since'> = {
    domain: 'acme.test',
    since: SENT_AT,
  };
  expect(isReplyFrom(candidate, reply())).toBe(true);
  expect(isReplyFrom(candidate, reply({ receivedAt: SENT_AT }))).toBe(false);
  expect(isReplyFrom(candidate, reply({ from: 'x@other.test' }))).toBe(false);
  expect(isReplyFrom(candidate, reply({ messageId: '' }))).toBe(false);
  expect(isReplyFrom(candidate, reply({ receivedAt: 'not a date' }))).toBe(false);
});

test('a row without a domain, a connection or a send is not a candidate', () => {
  const ok = {
    job_id: 'job_1',
    space_id: 'sp_1',
    constraints: { allowed_domains: ['acme.test', 'www.acme.test'] },
    trigger_id: 'trg_1',
    spec: { connection_id: 'conn_1', event_name: 'mail.new' },
    first_send_at: new Date(SENT_AT),
  };
  expect(candidatesFrom([ok])).toHaveLength(1);
  expect(candidatesFrom([{ ...ok, constraints: { allowed_domains: [] } }])).toEqual([]);
  expect(candidatesFrom([{ ...ok, spec: { event_name: 'mail.new' } }])).toEqual([]);
  expect(candidatesFrom([{ ...ok, first_send_at: null }])).toEqual([]);
  // A trigger for some other feed is not a reply trigger.
  expect(
    candidatesFrom([{ ...ok, spec: { connection_id: 'conn_1', event_name: 'calendar.changed' } }]),
  ).toEqual([]);
});

test('noticing a reply cannot send one', async () => {
  const text = await Bun.file(new URL('../../src/companies/replies.ts', import.meta.url)).text();
  // Judge the code, not the prose describing it.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const absent = (needle: string) => [needle, code.includes(needle)];
  expect(
    ['asMailer', 'transport.send', 'nodemailer', '.propose(', '.dispatch(', 'ImapSmtpTransport']
      .map(absent)
      .filter(([, present]) => present),
  ).toEqual([]);
  // The send kinds appear only as values it looks for among already-sent rows,
  // never as the kind of an action it builds.
  for (const kind of ['email.send', 'test.send']) expect(code).not.toContain(`kind: '${kind}'`);
  // The one thing it ever asks a connector to do is read, once.
  expect(code).toContain("kind: 'email.search'");
  expect(code).toContain("effect_class: 'read'");
  expect(code.match(/connector\.execute\(/g) ?? []).toHaveLength(1);
});
