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
  REPLY_POLL_CRON,
  REPLY_POLL_SECONDS,
  type ReplyCandidate,
  type ReplyMessage,
  type ReplyPollerDeps,
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

function company(): Company {
  return {
    id: newId('co'),
    space_id: spaceId,
    name: 'Acme',
    domain: 'acme.test',
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
async function waitingChase() {
  const { jobs, handle } = fixture();
  const co = company();
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
      connectionId,
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
    connectionId,
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
  return pollerWith(() => fixtureReplyMailbox(messages));
}

function pollerWith(mailboxFor: ReplyPollerDeps['mailboxFor']) {
  const { handle } = fixture();
  return new CompanyReplyPoller({ sql: handle.sql, triggers, mailboxFor });
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

    expect(await poller([reply()]).runOnce()).toEqual({ delivered: 1, failed: 0 });
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
    expect(await again.runOnce()).toEqual({ delivered: 1, failed: 0 });
    const woken = await jobs.get(chase.jobId);

    // Polls two and three see the same message sitting in the mailbox, whether
    // the whole pass runs or the integrator drives one candidate directly.
    expect(await again.runOnce()).toEqual({ delivered: 0, failed: 0 });
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
    expect(await poller(strangers).runOnce()).toEqual({ delivered: 0, failed: 0 });
    const after = await jobs.get(chase.jobId);
    expect(after.state).toBe('waiting_for_event_or_time');
    expect(after.stateVersion).toBe(before.stateVersion);
  });

  test('a subdomain of the company is still the company', async () => {
    const { jobs } = fixture();
    const chase = await waitingChase();
    expect(
      await poller([reply({ from: 'Acme Billing <no-reply@billing.acme.test>' })]).runOnce(),
    ).toEqual({ delivered: 1, failed: 0 });
    expect((await jobs.get(chase.jobId)).state).toBe('queued');
  });

  test('one chase whose mailbox has gone does not cost the others their pass', async () => {
    const { jobs, handle } = fixture();
    const broken = await waitingChase();
    const healthy = await waitingChase();
    expect(await readCandidates(handle.sql)).toHaveLength(2);

    // The space was deleted, or the credential was pulled, between the query
    // and the read. One chase is no longer readable; the rest still are.
    const pass = await pollerWith((candidate) => {
      if (candidate.jobId === broken.jobId) {
        throw new Error('this space went away mid-pass');
      }
      return fixtureReplyMailbox([reply()]);
    }).runOnce();

    expect(pass).toEqual({ delivered: 1, failed: 1 });
    expect((await jobs.get(healthy.jobId)).state).toBe('queued');
  });

  test('a mailbox that rejects rather than throws is counted the same way', async () => {
    const { handle } = fixture();
    await waitingChase();
    const pass = await pollerWith(() => ({
      recent: async () => {
        throw new Error('the connector said no');
      },
    })).runOnce();
    expect(pass).toEqual({ delivered: 0, failed: 1 });
    // Nothing was delivered, and nothing was left half-done.
    expect(
      await handle.sql`select seq from event where type = 'notice'
      and payload->>'kind' = 'connector_event'`,
    ).toHaveLength(0);
  });

  test('every waiting chase is polled, however many pages it takes', async () => {
    const { handle } = fixture();
    const chases = [await waitingChase(), await waitingChase(), await waitingChase()];
    expect(await readCandidates(handle.sql)).toHaveLength(3);

    // A page smaller than the work, so the pass has to turn the page twice.
    const looked: string[] = [];
    const pass = await new CompanyReplyPoller({
      sql: handle.sql,
      triggers,
      pageSize: 2,
      mailboxFor: (candidate) => {
        looked.push(candidate.jobId);
        return fixtureReplyMailbox([]);
      },
    }).runOnce();

    expect(pass).toEqual({ delivered: 0, failed: 0 });
    // Every one of them, once each, and nobody twice.
    expect([...looked].sort()).toEqual(chases.map((chase) => chase.jobId).sort());
  });

  test('paging asks for the page after the one it just read', async () => {
    const { handle } = fixture();
    await waitingChase();
    await waitingChase();
    const all = await readCandidates(handle.sql);
    expect(all).toHaveLength(2);
    const [first, second] = all;
    if (!first || !second) throw new Error('Expected two chases');
    expect(first.jobId < second.jobId).toBe(true);
    expect(await readCandidates(handle.sql, { limit: 1 })).toEqual([first]);
    expect(await readCandidates(handle.sql, { limit: 1, after: first.jobId })).toEqual([second]);
    expect(await readCandidates(handle.sql, { after: second.jobId })).toEqual([]);
  });

  test('a connection the person took back is not read again', async () => {
    const { handle, jobs } = fixture();
    const chase = await waitingChase();
    expect(await readCandidates(handle.sql)).toHaveLength(1);

    for (const status of ['revoked', 'disabled', 'error']) {
      await handle.sql`update connection set status = ${status} where id = ${connectionId}`;
      // Revocation is the person saying stop. Whether the registry still holds
      // a connector for it is not the question; the row is, and the row says no.
      expect(await readCandidates(handle.sql)).toEqual([]);
      expect(await poller([reply()]).runOnce()).toEqual({ delivered: 0, failed: 0 });
      expect((await jobs.get(chase.jobId)).state).toBe('waiting_for_event_or_time');
    }

    await handle.sql`update connection set status = 'active' where id = ${connectionId}`;
    expect(await readCandidates(handle.sql)).toHaveLength(1);
  });

  test('a connection belonging to another space is not this chase to poll', async () => {
    const { handle } = fixture();
    await waitingChase();
    const elsewhere = newId('sp');
    await handle.db.insert(space).values({
      id: elsewhere,
      name: 'Somewhere else',
      gitPath: `/spaces/${elsewhere}`,
    });
    await handle.sql`update connection set space_id = ${elsewhere} where id = ${connectionId}`;
    expect(await readCandidates(handle.sql)).toEqual([]);
  });

  test('a finished chase is left alone', async () => {
    const { jobs, handle } = fixture();
    const chase = await waitingChase();
    await jobs.cancel(chase.jobId, 'the person said stop');
    expect(await readCandidates(handle.sql)).toHaveLength(0);
    expect(await poller([reply()]).runOnce()).toEqual({ delivered: 0, failed: 0 });
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

test('the poll schedule says exactly what the interval constant says', () => {
  // pg-boss schedules on cron, whose finest grain is a minute, and the payload
  // it carries is data nobody reads. The cron is therefore the only thing that
  // decides how often this runs, so it has to be the constant's own voice.
  const minutes = /^\*\/(\d+) \* \* \* \*$/.exec(REPLY_POLL_CRON)?.[1];
  expect(minutes).toBeDefined();
  expect(Number(minutes) * 60).toBe(REPLY_POLL_SECONDS);
});
