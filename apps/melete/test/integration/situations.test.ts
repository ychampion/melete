/**
 * Clocks, situations and urgency against Postgres: a deadline is looked at
 * again at its time and raised once if still unmet, meetings that move keep
 * one clock, overlaps are one situation, and only a deadline the person set
 * breaks their quiet.
 *
 * Sources are scripted connectors; the poller and the clocks run on a clock
 * the test moves.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { pushPayload, type WaitSpec } from '@melete/contracts';
import { connection, experienceProfile, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { PolicyService } from '../../src/jobs/policy.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { PushService } from '../../src/push/service.ts';
import { decryptPayload, generateVapidKeys, toBase64Url } from '../../src/push/webpush.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { SignalPoller } from '../../src/signals/poller.ts';
import type { NewMail, Occurrence, SignalSource } from '../../src/signals/types.ts';
import { spokenTime } from '../../src/situations/detectors.ts';
import { SituationService, type SubjectReader } from '../../src/situations/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: 'situations-fixture-key-32-bytes!!' })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

const MINUTE = 60_000;
let clock = Date.parse('2026-10-05T12:00:00.000Z');
const sources = new Map<string, { signals?: SignalSource; subjects?: SubjectReader }>();

// --------------------------------------------------------------------------
// push: a phone that decrypts what reaches it
// --------------------------------------------------------------------------

type Phone = { endpoint: string; publicKey: string; privateKey: string; auth: string };
const delivered: Array<{ principal: string; payload: ReturnType<typeof pushPayload.parse> }> = [];
const phones = new Map<string, Phone & { principal: string }>();
const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
  const phone = phones.get(String(input));
  if (!phone) return new Response(null, { status: 404 });
  const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
  const plain = await decryptPayload(body, phone);
  delivered.push({
    principal: phone.principal,
    payload: pushPayload.parse(JSON.parse(new TextDecoder().decode(plain))),
  });
  return new Response(null, { status: 201 });
}) as typeof fetch;
let push: PushService;

const situations =
  jobs && triggers
    ? new SituationService({
        jobs,
        triggers,
        connectors: sources,
        now: () => clock,
        notify: (principalId) => push.dispatch(principalId, new Date(clock)),
      })
    : null;
if (triggers && situations)
  triggers.observers.push((tx, delivery, seq) => situations.observe(tx, delivery, seq));
const poller =
  handle && triggers && situations
    ? new SignalPoller({
        sql: handle.sql,
        triggers,
        connectors: sources,
        now: () => clock,
        detectorDemand: () => situations.demand(),
        afterCalendarRead: (id) => situations.afterCalendarRead(id),
      })
    : null;

/** Read every account that is due now, then let the next reads come due. */
async function poll() {
  await required(handle).sql`update source_cursor set next_poll_at = now() - interval '1 second'`;
  return required(poller).runOnce();
}

// --------------------------------------------------------------------------
// people and accounts
// --------------------------------------------------------------------------

type Person = { id: string; spaceId: string };
async function person(label: string, day: { start: string; end: string }): Promise<Person> {
  const { db, sql } = required(handle);
  const id = newId('own');
  // The installation has one owner; everyone else is a person beside them.
  await sql`insert into principal (id, email) values (${id}, ${`${label}-${id}@example.test`})`;
  const spaceId = newId('sp');
  await db
    .insert(space)
    .values({ id: spaceId, name: label, gitPath: `/s/${spaceId}`, ownerPrincipalId: id });
  await db
    .insert(experienceProfile)
    .values({ spaceId, timeZone: 'UTC', dayStart: day.start, dayEnd: day.end });
  return { id, spaceId };
}

async function withPhone(who: Person) {
  const keys = await generateVapidKeys();
  const endpoint = `https://push.example.test/${who.id}`;
  phones.set(endpoint, {
    endpoint,
    ...keys,
    auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    principal: who.id,
  });
  const phone = required(phones.get(endpoint));
  await required(handle)
    .sql`insert into push_subscription (id, principal_id, endpoint, p256dh, auth)
    values (${newId('psub')}, ${who.id}, ${endpoint}, ${phone.publicKey}, ${phone.auth})`;
}

async function account(who: Person, provider: string, label: string) {
  const id = newId('conn');
  await required(handle)
    .db.insert(connection)
    .values({ id, spaceId: who.spaceId, provider, label });
  return id;
}

/** A document source: its fields are read at the source each time a clock asks. */
function documentSource(connectionId: string, fields: Record<string, unknown>) {
  const doc = { fields, reads: 0, fail: false };
  sources.set(connectionId, {
    subjects: {
      read: async () => {
        doc.reads += 1;
        if (doc.fail) throw new Error('unreachable');
        return { ...doc.fields };
      },
    },
  });
  return doc;
}

function calendarSource(connectionId: string) {
  const calendar = { items: [] as Occurrence[] };
  sources.set(connectionId, {
    signals: {
      stream: 'calendar',
      occurrences: async () => ({ items: calendar.items, complete: true }),
      confirm: async (wanted) =>
        calendar.items.find(
          (item) => item.uid === wanted.uid && item.occurrence === wanted.occurrence,
        ) ?? 'gone',
    },
  });
  return calendar;
}

const meeting = (uid: string, start: number, overrides: Partial<Occurrence> = {}): Occurrence => ({
  uid,
  occurrence: null,
  title: `Meeting ${uid}`,
  start: new Date(start).toISOString(),
  end: new Date(start + 60 * MINUTE).toISOString(),
  all_day: false,
  location: 'Room 1',
  status: 'confirmed',
  attendees: 2,
  time_zone: 'UTC',
  ...overrides,
});

const live = async (principalId: string, kind?: string) =>
  required(handle).sql`select * from situation where principal_id = ${principalId}
    and state in ('open', 'routed') ${kind ? required(handle).sql`and kind = ${kind}` : required(handle).sql``}`;
const armed = async (subjectKey: string) =>
  required(handle).sql`select * from clock where subject_key = ${subjectKey}
    and state in ('armed', 'checking')`;
const modelCalls = async () => {
  const [row] = await required(handle).sql`select count(*)::int as n from model_usage`;
  return Number(row?.n ?? 0);
};
const keyOf = async (connectionId: string, uid: string) => {
  const [row] = await required(handle).sql`select subject_key from subject_state
    where connection_id = ${connectionId} and fields->>'uid' = ${uid}`;
  return String(required(row).subject_key);
};

async function waitingOn(row: JobRow, triggerId: string) {
  const claimed = required(
    await required(runner).claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'created',
    }),
  );
  const wait: WaitSpec = { kind: 'event', trigger_id: triggerId, deadline_at: null };
  await required(runner).commitOutcome(claimed.claims, { kind: 'waiting_for_event_or_time', wait });
  return required(jobs).get(row.id);
}

withDb('situations', () => {
  beforeAll(async () => {
    push = new PushService(required(handle).db, {
      keys: await generateVapidKeys(),
      subject: 'mailto:owner@example.test',
      extraOrigins: ['https://push.example.test'],
      fetcher,
    });
  });
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('a deadline is checked against fresh state at its time, once', async () => {
    const ana = await person('ana', { start: '08:00', end: '22:00' });
    await withPhone(ana);
    const docs = await account(ana, 'test', 'Documents');
    const doc = documentSource(docs, { signed: false });
    const due = clock + 30 * MINUTE;
    await required(situations).setDeadline({
      spaceId: ana.spaceId,
      principalId: ana.id,
      subjectKey: 'doc:contract',
      connectionId: docs,
      title: 'The contract is signed',
      dueAt: new Date(due),
      leadSeconds: 5 * 60,
      atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
      personSet: true,
    });
    // Before its time nothing is read and nothing is raised.
    clock = due - 6 * MINUTE;
    await required(situations).sweep();
    expect(doc.reads).toBe(0);
    expect(await live(ana.id)).toHaveLength(0);
    // At its time: one fresh read, one situation, one push, with Melete's reason.
    clock = due - 5 * MINUTE;
    const before = delivered.length;
    await required(situations).sweep();
    await required(situations).sweep();
    expect(doc.reads).toBe(1);
    const raised = await live(ana.id, 'deadline.at_risk');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.urgency).toBe('urgent');
    expect(raised[0]?.reason).toBe('Due Mon 12:30 PM, and it is not done yet.');
    expect(raised[0]?.because).toEqual([expect.stringMatching(/^clock:clk_/)]);
    const told = delivered.slice(before).filter((entry) => entry.principal === ana.id);
    expect(told).toHaveLength(1);
    expect(told[0]?.payload.because).toBe('Because you asked Melete to keep this deadline.');
    expect(told[0]?.payload.ack).toBe(`/situations/${raised[0]?.id}/ack`);
    expect(await armed('doc:contract')).toHaveLength(0);
    expect(await modelCalls()).toBe(0);
  }, 60_000);

  test('a deadline met before its time says nothing', async () => {
    const ben = await person('ben', { start: '08:00', end: '22:00' });
    await withPhone(ben);
    const docs = await account(ben, 'test', 'Documents');
    const doc = documentSource(docs, { signed: false });
    const due = clock + 30 * MINUTE;
    await required(situations).setDeadline({
      spaceId: ben.spaceId,
      principalId: ben.id,
      subjectKey: 'doc:lease',
      connectionId: docs,
      title: 'The lease is signed',
      dueAt: new Date(due),
      leadSeconds: 5 * 60,
      atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
      personSet: true,
    });
    // Signed at 2:54, after the clock was made: the fresh read sees it.
    doc.fields.signed = true;
    clock = due - 5 * MINUTE;
    await required(situations).sweep();
    expect(doc.reads).toBe(1);
    expect(await live(ben.id)).toHaveLength(0);
    const [settled] = await required(handle)
      .sql`select state from clock where subject_key = 'doc:lease'`;
    expect(settled?.state).toBe('met');
    expect(delivered.filter((entry) => entry.principal === ben.id)).toHaveLength(0);
  }, 60_000);

  test('a source that cannot be read is tried again, and is never raised on stale state', async () => {
    const cy = await person('cy', { start: '08:00', end: '22:00' });
    const docs = await account(cy, 'test', 'Documents');
    const doc = documentSource(docs, { signed: false });
    doc.fail = true;
    const due = clock + 30 * MINUTE;
    await required(situations).setDeadline({
      spaceId: cy.spaceId,
      principalId: cy.id,
      subjectKey: 'doc:nda',
      connectionId: docs,
      title: 'The NDA is signed',
      dueAt: new Date(due),
      leadSeconds: 2 * 60,
      atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
      personSet: true,
    });
    clock = due - 2 * MINUTE;
    await required(situations).sweep();
    expect(await live(cy.id)).toHaveLength(0);
    // It could not be read before its time: missed, and still nothing raised.
    clock = due - MINUTE;
    await required(situations).sweep();
    const [settled] = await required(handle)
      .sql`select state, note from clock where subject_key = 'doc:nda'`;
    expect(settled?.state).toBe('missed');
    expect(await live(cy.id)).toHaveLength(0);
  }, 60_000);

  test('an urgent deadline the person set pushes now, even in quiet hours; one they didn’t set waits', async () => {
    // Their day is 08:00–10:00 UTC; the test's noon is quiet.
    const dee = await person('dee', { start: '08:00', end: '10:00' });
    await withPhone(dee);
    const docs = await account(dee, 'test', 'Documents');
    documentSource(docs, { signed: false });
    const due = clock + 20 * MINUTE;
    const deadline = (subjectKey: string, personSet: boolean) =>
      required(situations).setDeadline({
        spaceId: dee.spaceId,
        principalId: dee.id,
        subjectKey,
        connectionId: docs,
        title: 'The form is filed',
        dueAt: new Date(due),
        leadSeconds: 5 * 60,
        atRisk: { all: [{ field: 'signed', op: 'eq', value: false }] },
        personSet,
      });
    await deadline('doc:theirs', true);
    await deadline('doc:found', false);
    clock = due - 5 * MINUTE;
    const before = delivered.length;
    await required(situations).sweep();
    const raised = await live(dee.id, 'deadline.at_risk');
    expect(raised.map((row) => [row.subject_key, row.urgency]).sort()).toEqual([
      ['doc:found', 'soon'],
      ['doc:theirs', 'urgent'],
    ]);
    // The one they set reached the phone at once; the other waits for their day.
    const told = delivered.slice(before).filter((entry) => entry.principal === dee.id);
    expect(told).toHaveLength(1);
    expect(told[0]?.payload.ack).toContain(String(raised.find((r) => r.person_set)?.id));
    const [waiting] = await required(handle).sql`select count(*)::int as n from push_intent
      where principal_id = ${dee.id} and sent_at is null and dropped_at is null`;
    expect(waiting?.n).toBe(1);
    expect(await push.dispatch(dee.id, new Date(clock + 10 * MINUTE))).toBe('quiet');
    // Seeing it stops it: acknowledging drops what was still to be pushed.
    const found = required(raised.find((row) => !row.person_set));
    await required(situations).ack(dee.id, String(found.id));
    const [left] = await required(handle).sql`select count(*)::int as n from push_intent
      where principal_id = ${dee.id} and sent_at is null and dropped_at is null`;
    expect(left?.n).toBe(0);
    // Nothing a detector reads can be urgent: the database refuses it.
    let refused = false;
    try {
      await required(handle)
        .sql`update situation set urgency = 'urgent' where id = ${String(found.id)}`;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, 60_000);

  test('a meeting moved twice has one live clock, at its new time', async () => {
    const eve = await person('eve', { start: '08:00', end: '22:00' });
    const calendarId = await account(eve, 'caldav', 'Work calendar');
    const calendar = calendarSource(calendarId);
    const start = clock + 48 * 60 * MINUTE;
    calendar.items = [meeting('board', start)];
    await poll();
    await poll();
    const subject = await keyOf(calendarId, 'board');
    await required(situations).setDeadline({
      spaceId: eve.spaceId,
      principalId: eve.id,
      subjectKey: subject,
      connectionId: calendarId,
      title: 'The board deck is ready',
      anchor: { field: 'start', offset_s: -3600 },
      leadSeconds: 15 * 60,
      atRisk: { all: [{ field: 'status', op: 'eq', value: 'confirmed' }] },
      personSet: true,
    });
    for (const hours of [50, 53]) {
      calendar.items = [meeting('board', clock + hours * 60 * MINUTE)];
      await poll();
    }
    const clocks = await armed(subject);
    expect(clocks).toHaveLength(1);
    const newStart = clock + 53 * 60 * MINUTE;
    expect(new Date(clocks[0]?.fire_at).getTime()).toBe(newStart - 60 * MINUTE - 15 * MINUTE);
    // At the old time nothing fires.
    const saved = clock;
    clock = start - 75 * MINUTE;
    await required(situations).sweep();
    expect(await live(eve.id, 'deadline.at_risk')).toHaveLength(0);
    clock = saved;
  }, 60_000);

  test('a cancelled meeting’s clocks are cleared', async () => {
    const fay = await person('fay', { start: '08:00', end: '22:00' });
    const calendarId = await account(fay, 'caldav', 'Work calendar');
    const calendar = calendarSource(calendarId);
    calendar.items = [meeting('offsite', clock + 72 * 60 * MINUTE)];
    await poll();
    await poll();
    const subject = await keyOf(calendarId, 'offsite');
    await required(situations).setDeadline({
      spaceId: fay.spaceId,
      principalId: fay.id,
      subjectKey: subject,
      connectionId: calendarId,
      title: 'Travel is booked',
      anchor: { field: 'start', offset_s: -86_400 },
      leadSeconds: 3600,
      atRisk: { all: [{ field: 'status', op: 'eq', value: 'confirmed' }] },
      personSet: true,
    });
    expect(await armed(subject)).toHaveLength(1);
    calendar.items = [{ ...meeting('offsite', clock + 72 * 60 * MINUTE), status: 'cancelled' }];
    await poll();
    expect(await armed(subject)).toHaveLength(0);
    const [cleared] = await required(handle)
      .sql`select state from clock where subject_key = ${subject}`;
    expect(cleared?.state).toBe('cleared');
  }, 60_000);

  test('a conflict between two meetings is one situation, not two, and ends when they part', async () => {
    const gus = await person('gus', { start: '08:00', end: '22:00' });
    const work = await account(gus, 'caldav', 'Work');
    const home = await account(gus, 'caldav', 'Home');
    const workCalendar = calendarSource(work);
    const homeCalendar = calendarSource(home);
    const at = clock + 5 * 60 * MINUTE;
    workCalendar.items = [meeting('review', at)];
    homeCalendar.items = [meeting('dentist', at + 30 * MINUTE, { attendees: 0 })];
    await poll();
    await poll();
    await poll();
    const conflicts = await live(gus.id, 'meeting.conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.urgency).toBe('soon');
    expect(conflicts[0]?.reason).toBe(
      `Both are on your calendar at ${spokenTime(new Date(at + 30 * MINUTE).toISOString(), 'UTC')}.`,
    );
    // The dentist moves to the evening: the overlap is over.
    homeCalendar.items = [meeting('dentist', at + 4 * 60 * MINUTE, { attendees: 0 })];
    await poll();
    expect(await live(gus.id, 'meeting.conflict')).toHaveLength(0);
  }, 60_000);

  test('a meeting that moves within a day wakes the work watching it, once', async () => {
    const hal = await person('hal', { start: '08:00', end: '22:00' });
    await withPhone(hal);
    const calendarId = await account(hal, 'caldav', 'Work');
    const calendar = calendarSource(calendarId);
    calendar.items = [meeting('standup', clock + 3 * 60 * MINUTE)];
    await poll();
    await poll();
    const subject = await keyOf(calendarId, 'standup');
    const row = await required(jobs).create({
      space_id: hal.spaceId,
      title: 'Prepare',
      objective: 'Prepare for the standup',
    });
    const watch = await required(triggers).create(row.id, {
      kind: 'watch',
      connection_id: calendarId,
      event_name: 'calendar.event.cancelled',
      poll_seconds: 300,
      predicate: { all: [{ field: 'about.key', op: 'eq', value: subject }] },
    });
    await waitingOn(row, watch.id);
    calendar.items = [meeting('standup', clock + 4 * 60 * MINUTE)];
    await poll();
    const raised = await live(hal.id, 'meeting.changed');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.state).toBe('routed');
    expect(raised[0]?.routed_job_ids).toEqual([row.id]);
    const woke = await required(jobs).get(row.id);
    expect(woke.state).toBe('queued');
    const [wakes] = await required(handle).sql`select count(*)::int as n from event
      where job_id = ${row.id} and payload->>'kind' = 'trigger_event'`;
    expect(wakes?.n).toBe(1);
    // A second move folds into the same situation.
    const later = clock + 5 * 60 * MINUTE;
    const earlier = clock + 4 * 60 * MINUTE;
    calendar.items = [meeting('standup', later)];
    await poll();
    const again = await live(hal.id, 'meeting.changed');
    expect(again).toHaveLength(1);
    expect(again[0]?.sightings).toBe(2);
    const spoken = (at: number) => spokenTime(new Date(at).toISOString(), 'UTC');
    expect(again[0]?.reason).toBe(`It now starts ${spoken(later)}; it was ${spoken(earlier)}.`);
    expect(await modelCalls()).toBe(0);
  }, 60_000);

  test('a hundred observations matching nothing make no situation and no model call', async () => {
    const ida = await person('ida', { start: '08:00', end: '22:00' });
    const mailbox = await account(ida, 'imap', 'Inbox');
    const box = { messages: [] as NewMail[] };
    sources.set(mailbox, {
      signals: {
        stream: 'mail',
        changes: async (cursor, options) => {
          if (cursor === null) return { cursor: '0', messages: [] };
          const messages = box.messages.slice(Number(cursor), Number(cursor) + options.limit);
          return { cursor: String(Number(cursor) + messages.length), messages };
        },
      },
    });
    const row = await required(jobs).create({ space_id: ida.spaceId, title: 'W', objective: 'W' });
    await required(triggers).create(row.id, {
      kind: 'watch',
      connection_id: mailbox,
      event_name: 'mail.received',
      poll_seconds: 300,
      predicate: { all: [{ field: 'subject', op: 'contains', value: 'never' }] },
    });
    await poll();
    for (let index = 0; index < 100; index++)
      box.messages.push({
        uid: index,
        message_id: `<n${index}@ida.test>`,
        from: 'news@ida.test',
        from_addresses: ['news@ida.test'],
        to: 'ida@example.test',
        to_addresses: ['ida@example.test'],
        subject: `Newsletter ${index}`,
        text: '',
        html: '',
        date: new Date(clock).toISOString(),
        key: `msgid:<n${index}@ida.test>`,
        read_key: index,
      });
    await poll();
    await poll();
    expect(await live(ida.id)).toHaveLength(0);
    expect(await modelCalls()).toBe(0);
  }, 60_000);

  test('a wait on a reply is raised for Home, and settles when the answer arrives', async () => {
    const jo = await person('jo', { start: '08:00', end: '22:00' });
    const mailbox = await account(jo, 'imap', 'Inbox');
    const box = { messages: [] as NewMail[] };
    sources.set(mailbox, {
      signals: {
        stream: 'mail',
        changes: async (cursor, options) => {
          if (cursor === null) return { cursor: '0', messages: [] };
          const messages = box.messages.slice(Number(cursor), Number(cursor) + options.limit);
          return { cursor: String(Number(cursor) + messages.length), messages };
        },
      },
    });
    const { sql } = required(handle);
    const awaitedId = newId('awr');
    await sql`insert into awaited_reply (id, space_id, principal_id, message_id, to_address,
        subject, sent_at, evidence, status, scan_id)
      values (${awaitedId}, ${jo.spaceId}, ${jo.id}, '<ask@jo.test>', 'ana@acme.test',
        'Quote for October', ${new Date(clock - 4 * 86_400_000).toISOString()}::timestamptz,
        '{}'::jsonb, 'found', 'scn_fixture')`;
    await required(situations).sweep();
    expect(await armed(`awaited:${awaitedId}`)).toHaveLength(1);
    // The mailbox is now read for it, and its silence counts once it has been.
    await poll();
    clock += 11 * MINUTE;
    await poll();
    await required(situations).sweep();
    const raised = await live(jo.id, 'reply.overdue');
    expect(raised).toHaveLength(1);
    expect(raised[0]?.urgency).toBe('normal');
    expect(raised[0]?.fired_at).toBeNull();
    box.messages.push({
      uid: 1,
      message_id: '<answer@acme.test>',
      from: 'ana@acme.test',
      from_addresses: ['ana@acme.test'],
      to: 'jo@example.test',
      to_addresses: ['jo@example.test'],
      subject: 'Re: Quote for October',
      text: '',
      html: '',
      date: new Date(clock).toISOString(),
      in_reply_to: '<ask@jo.test>',
      key: 'msgid:<answer@acme.test>',
      read_key: 1,
    });
    await poll();
    expect(await live(jo.id, 'reply.overdue')).toHaveLength(0);
  }, 60_000);

  test('revoking an account takes what was noticed in it and its clocks', async () => {
    const kit = await person('kit', { start: '08:00', end: '22:00' });
    const calendarId = await account(kit, 'caldav', 'Work');
    const calendar = calendarSource(calendarId);
    calendar.items = [
      meeting('one', clock + 2 * 60 * MINUTE),
      meeting('two', clock + 2 * 60 * MINUTE + 15 * MINUTE),
    ];
    await poll();
    await poll();
    calendar.items = [
      meeting('one', clock + 3 * 60 * MINUTE),
      meeting('two', clock + 3 * 60 * MINUTE),
    ];
    await poll();
    expect((await live(kit.id)).length).toBeGreaterThan(0);
    await required(situations).setDeadline({
      spaceId: kit.spaceId,
      principalId: kit.id,
      subjectKey: await keyOf(calendarId, 'one'),
      connectionId: calendarId,
      title: 'Notes are ready',
      anchor: { field: 'start', offset_s: -1800 },
      leadSeconds: 600,
      atRisk: { all: [{ field: 'status', op: 'eq', value: 'confirmed' }] },
      personSet: true,
    });
    const [before] = await required(handle)
      .sql`select count(*)::int as n from clock where connection_id = ${calendarId}`;
    expect(before?.n).toBe(1);
    const { sql: raw } = required(handle);
    const [current] = await raw`select generation from connection where id = ${calendarId}`;
    await new PolicyService(required(jobs), required(runner)).changeConnection(calendarId, {
      kind: 'revoke',
      expected_generation: Number(current?.generation ?? 0),
    });
    const { sql } = required(handle);
    const [left] = await sql`select
        (select count(*)::int from situation where principal_id = ${kit.id}) as situations,
        (select count(*)::int from clock where connection_id = ${calendarId}) as clocks`;
    expect([left?.situations, left?.clocks]).toEqual([0, 0]);
  }, 60_000);
});
