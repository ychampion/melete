/**
 * Signals: what changes in a connected mailbox or calendar reaches the work
 * listening for it, once, and nothing else.
 *
 * The sources are scripted connectors, and the poller runs on a clock the test
 * moves, so every read is one `runOnce`.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { type AttemptOutcome, runResponse, type WaitSpec } from '@melete/contracts';
import { ServiceError } from '../../src/api/errors.ts';
import type { MailMessage } from '../../src/connectors/mail-transport.ts';
import { session } from '../../src/db/auth-schema.ts';
import { connection, owner, space } from '../../src/db/schema.ts';
import { loadEnv } from '../../src/env.ts';
import { newId } from '../../src/ids.ts';
import { createApp } from '../../src/index.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { principalContext } from '../../src/principals/authority.ts';
import { attachRuns, RunService } from '../../src/runs/service.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { SignalPoller } from '../../src/signals/poller.ts';
import type { NewMail, Occurrence, SignalSource } from '../../src/signals/types.ts';
import { rejectionOf } from '../helpers/broker.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const KEY = 'signals-fixture-signing-key-32-bytes!';
const runner = jobs ? new AttemptRunner(jobs, new StubRuntimeAdapter(), { key: KEY }) : null;
const runs = jobs ? new RunService(jobs) : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
if (runner && runs) attachRuns(runner, runs);
if (runs && triggers) runs.triggers = triggers;
const app = handle
  ? createApp({
      db: handle.db,
      env: loadEnv({ NODE_ENV: 'test' }),
      jobs: jobs ?? undefined,
      runner: runner ?? undefined,
      runs: runs ?? undefined,
      sql: handle.sql,
      checkDatabase: async () => 'ok',
    })
  : null;
const withDb = handle ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

const ownerId = newId('own');
const spaceId = newId('sp');
const token = randomBytes(32).toString('base64url');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'signals@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
  await handle.db.insert(session).values({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    ownerId,
    spaceId,
    expiresAt: new Date(Date.now() + 600_000),
  });
}

// --------------------------------------------------------------------------
// scripted sources
// --------------------------------------------------------------------------

const sources = new Map<string, { signals: SignalSource }>();
let clock = Date.parse('2026-10-05T12:00:00.000Z');
const poller =
  handle && triggers
    ? new SignalPoller({ sql: handle.sql, triggers, connectors: sources, now: () => clock })
    : null;

/** Read everything that is due, then let the next reads come due. */
async function poll() {
  const result = await required(poller).runOnce();
  clock += 3_600_000;
  return result;
}

type Mailbox = { messages: NewMail[]; reads: number; rewind: boolean };
const mail = (index: number, from: string, subject: string): NewMail => {
  const message: MailMessage = {
    uid: index,
    message_id: `<m${index}-${from}>`,
    from,
    from_addresses: [from],
    to: 'me@example.test',
    to_addresses: ['me@example.test'],
    subject,
    text: '',
    html: '',
    date: new Date(clock).toISOString(),
  };
  return { ...message, key: `msgid:${message.message_id}`, read_key: index };
};

/** A mailbox whose cursor is how many messages were read; `rewind` reads them all again. */
async function connectMailbox(label: string, inSpace = spaceId) {
  const id = newId('conn');
  await required(handle)
    .db.insert(connection)
    .values({ id, spaceId: inSpace, provider: 'imap', label });
  const box: Mailbox = { messages: [], reads: 0, rewind: false };
  sources.set(id, {
    signals: {
      stream: 'mail',
      changes: async (cursor, options) => {
        box.reads += 1;
        if (cursor === null) return { cursor: String(box.messages.length), messages: [] };
        const from = box.rewind ? 0 : Number(cursor);
        box.rewind = false;
        const messages = box.messages.slice(from, from + options.limit);
        return { cursor: String(from + messages.length), messages };
      },
    },
  });
  return { id, box };
}

async function connectCalendar(label: string) {
  const id = newId('conn');
  await required(handle).db.insert(connection).values({ id, spaceId, provider: 'caldav', label });
  const calendar = { items: [] as Occurrence[] };
  sources.set(id, {
    signals: {
      stream: 'calendar',
      occurrences: async () => ({ items: calendar.items, complete: true }),
    },
  });
  return { id, calendar };
}

const occurrence = (start: string, overrides: Partial<Occurrence> = {}): Occurrence => ({
  uid: 'review@example.test',
  occurrence: '2026-10-07T16:00:00.000Z',
  title: 'Design review',
  start,
  end: new Date(Date.parse(start) + 3_600_000).toISOString(),
  all_day: false,
  location: 'Room 1',
  status: 'confirmed',
  attendees: 2,
  time_zone: 'America/Los_Angeles',
  ...overrides,
});

// --------------------------------------------------------------------------
// jobs
// --------------------------------------------------------------------------

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

const count = async (table: string, jobId: string) => {
  const [row] = await required(handle)
    .sql`select count(*)::int as n from ${required(handle).sql(table)}
    where job_id = ${jobId}`;
  return Number(row?.n ?? 0);
};
const events = async (connectionId: string, name: string) => {
  const rows = await required(handle).sql`select payload from event
    where payload->>'kind' = 'connector_event' and payload->>'connection_id' = ${connectionId}
      and payload->>'event_name' = ${name} order by seq`;
  return rows.map((row) => (row.payload as { payload: Record<string, unknown> }).payload);
};

// --------------------------------------------------------------------------
// runs
// --------------------------------------------------------------------------

async function request(path: string, method = 'GET', body?: unknown) {
  return required(app).request(path, {
    method,
    headers: {
      Cookie: `melete_session=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function startRun(goal: string) {
  const response = await request('/runs', 'POST', { goal });
  expect(response.status).toBe(200);
  return runResponse.parse(await response.json()).run;
}
async function claimShift(id: string) {
  await required(handle)
    .sql`update job set next_wake_at = now() - interval '1 second' where id = ${id}`;
  const current = await required(jobs).get(id);
  return required(
    await required(runner).claim({
      job_id: id,
      expected_epoch: current.leaseEpoch,
      expected_version: current.stateVersion,
      reason: 'timer',
    }),
  );
}
const done = (): AttemptOutcome => ({ kind: 'completed', summary: '', evidence: [] });

withDb('signals', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('a hundred observations matching nothing make no situation and no model call', async () => {
    const { id: mailbox, box } = await connectMailbox('Billing mail');
    const row = await required(jobs).create({
      space_id: spaceId,
      title: 'Watch for overdue invoices',
      objective: 'Tell me when an invoice from billing.example is overdue.',
    });
    const watch = await required(triggers).create(row.id, {
      kind: 'watch',
      connection_id: mailbox,
      event_name: 'mail.received',
      poll_seconds: 300,
      predicate: {
        all: [
          { field: 'sender_domain', op: 'eq', value: 'billing.example' },
          { field: 'subject', op: 'contains', value: 'overdue' },
        ],
      },
    });
    const waiting = await waitingOn(row, watch.id);
    const attempts = await count('attempt', row.id);
    const pushes = async () => {
      const [total] = await required(handle).sql`select count(*)::int as n from push_intent`;
      return Number(total?.n ?? 0);
    };
    const pushedBefore = await pushes();

    await poll(); // where watching starts
    for (let index = 0; index < 100; index++)
      box.messages.push(mail(index, `news${index}@shop.example`, `Weekly digest ${index}`));
    await poll();
    await poll();
    expect(await events(mailbox, 'mail.received')).toHaveLength(100);
    const after = await required(jobs).get(row.id);
    expect([after.state, after.stateVersion]).toEqual([
      'waiting_for_event_or_time',
      waiting.stateVersion,
    ]);
    expect(await count('attempt', row.id)).toBe(attempts);
    expect(await count('model_usage', row.id)).toBe(0);
    expect(await count('notification', row.id)).toBe(0);
    expect(await pushes()).toBe(pushedBefore);
    expect(await count('question', row.id)).toBe(0);

    // The one that matches wakes the job, once, naming it.
    box.messages.push(mail(100, 'ap@billing.example', 'Invoice 7731 is overdue'));
    await poll();
    expect((await required(jobs).get(row.id)).state).toBe('queued');
    const [consumed] = await required(handle).sql`select payload from event
      where job_id = ${row.id} and payload->>'kind' = 'trigger_event'`;
    const woke = consumed?.payload as { event: { payload: { subject: string } } } | undefined;
    expect(woke?.event.payload.subject).toBe('Invoice 7731 is overdue');
  }, 60_000);

  test('the same item from two polls is one event', async () => {
    const { id: mailbox, box } = await connectMailbox('Inbox');
    const row = await required(jobs).create({
      space_id: spaceId,
      title: 'Inbox',
      objective: 'Inbox',
    });
    const listening = await required(triggers).create(row.id, {
      kind: 'event',
      connection_id: mailbox,
      event_name: 'mail.received',
      poll_seconds: 300,
    });
    await waitingOn(row, listening.id);
    await poll();
    box.messages.push(mail(1, 'friend@example.test', 'Dinner?'));
    await poll();
    // The mailbox hands the same message back, as after a server renumbering.
    box.rewind = true;
    await poll();
    expect(box.reads).toBe(3);
    expect((await events(mailbox, 'mail.received')).map((payload) => payload.subject)).toEqual([
      'Dinner?',
    ]);

    // A calendar change read twice, because what was kept from the first read
    // was lost before it was written, is one event too.
    const { id: calendarId, calendar } = await connectCalendar('Team calendar');
    const listen = await required(jobs).create({
      space_id: spaceId,
      title: 'Cal',
      objective: 'Cal',
    });
    const onChange = await required(triggers).create(listen.id, {
      kind: 'event',
      connection_id: calendarId,
      event_name: 'calendar.event.changed',
      poll_seconds: 300,
    });
    await waitingOn(listen, onChange.id);
    calendar.items = [occurrence(new Date(clock + 2 * 86_400_000).toISOString())];
    await poll();
    const [kept] = await required(handle)
      .sql`select * from subject_state where connection_id = ${calendarId}`;
    calendar.items = [
      occurrence(new Date(Date.parse(String(calendar.items[0]?.start)) + 3_600_000).toISOString()),
    ];
    await poll();
    await required(handle).sql`update subject_state
      set fields = ${JSON.stringify(kept?.fields)}::jsonb, version = ${String(kept?.version)}
      where connection_id = ${calendarId}`;
    await poll();
    await poll();
    expect(await events(calendarId, 'calendar.event.changed')).toHaveLength(1);
  }, 60_000);

  test('a watch on an event its connection never produces is refused', async () => {
    const { id: mailbox } = await connectMailbox('Work mail');
    const { id: calendarId } = await connectCalendar('Work calendar');
    const row = await required(jobs).create({ space_id: spaceId, title: 'W', objective: 'W' });
    const refused = await rejectionOf(
      required(triggers).create(row.id, {
        kind: 'watch',
        connection_id: mailbox,
        event_name: 'calendar.event.changed',
        poll_seconds: 300,
        predicate: { all: [{ field: 'changed', op: 'contains', value: 'start' }] },
      }),
    );
    expect(refused).toBeInstanceOf(ServiceError);
    expect(refused).toMatchObject({ code: 'unknown_event', status: 400 });
    expect(String((refused as Error).message)).toContain('mail.received');
    expect(
      await rejectionOf(
        required(triggers).create(row.id, {
          kind: 'event',
          connection_id: calendarId,
          event_name: 'calendar.updated',
          poll_seconds: 300,
        }),
      ),
    ).toMatchObject({ code: 'unknown_event' });
    const [made] = await required(handle)
      .sql`select count(*)::int as n from trigger where job_id = ${row.id}`;
    expect(made?.n).toBe(0);

    // Long work cannot stand on one either.
    const run = await startRun('Watch my calendar');
    const shift = await claimShift(run.id);
    expect(
      await rejectionOf(
        required(runs).call(shift.claims, 'run.checkpoint', {
          summary: 'Set up.',
          next: 'Wait for a change.',
          next_shift: { kind: 'event', connection_id: calendarId, event_name: 'mail.received' },
        }),
      ),
    ).toMatchObject({ code: 'unknown_event' });
  }, 60_000);

  test("a room member's job never receives the owner's mail observations", async () => {
    const { sql } = required(handle);
    const memberId = newId('own');
    const sharedId = newId('sp');
    await sql`insert into principal (id, email) values (${memberId}, ${`${memberId}@example.test`})`;
    await sql`insert into space (id, name, kind, owner_principal_id, git_path)
      values (${sharedId}, 'Studio', 'shared', ${ownerId}, ${`/s/${sharedId}`})`;
    await sql`insert into space_membership (principal_id, space_id, role)
      values (${ownerId}, ${sharedId}, 'owner'), (${memberId}, ${sharedId}, 'member')`;
    // The owner's own mailbox, installed in the shared space for the owner's work.
    const { id: mailbox, box } = await connectMailbox('Owner mail', sharedId);
    const spec = {
      kind: 'event' as const,
      connection_id: mailbox,
      event_name: 'mail.received',
      poll_seconds: 300,
    };
    const members = await principalContext.run(memberId, () =>
      required(jobs).create({ space_id: sharedId, title: 'Member', objective: 'Member work' }),
    );
    // The member's job cannot listen, so the mailbox is not read for it at all.
    expect(await rejectionOf(required(triggers).create(members.id, spec))).toMatchObject({
      code: 'unknown_connection',
    });
    const earlier = newId('trg');
    await sql`insert into trigger (id, job_id, kind, spec, cursor)
      values (${earlier}, ${members.id}, 'event', ${JSON.stringify(spec)}::jsonb, '0')`;
    const memberWaiting = await waitingOn(members, earlier);
    await poll();
    expect(box.reads).toBe(0);
    const [cursor] =
      await sql`select count(*)::int as n from source_cursor where connection_id = ${mailbox}`;
    expect(cursor?.n).toBe(0);

    // Once the owner's own work listens, the mailbox is read, and only that work hears it.
    const owners = await principalContext.run(ownerId, () =>
      required(jobs).create({ space_id: sharedId, title: 'Owner', objective: 'Owner work' }),
    );
    const ownTrigger = await required(triggers).create(owners.id, spec);
    await waitingOn(owners, ownTrigger.id);
    await poll();
    box.messages.push(mail(1, 'counsel@firm.example', 'Owner private: settlement terms'));
    await poll();
    expect(box.reads).toBe(2);
    expect((await required(jobs).get(owners.id)).state).toBe('queued');
    const member = await required(jobs).get(members.id);
    expect([member.state, member.stateVersion]).toEqual([
      'waiting_for_event_or_time',
      memberWaiting.stateVersion,
    ]);
    const [heard] = await sql`select count(*)::int as n from event
      where job_id = ${members.id} and payload::text like '%settlement terms%'`;
    expect(heard?.n).toBe(0);
  }, 60_000);

  test('a standing run wakes on calendar.event.changed', async () => {
    const { id: calendarId, calendar } = await connectCalendar('My calendar');
    const start = new Date(clock + 3 * 86_400_000).toISOString();
    calendar.items = [occurrence(start)];
    const run = await startRun('Keep my week straight when meetings move');
    const first = await claimShift(run.id);
    await required(runs).call(first.claims, 'run.checkpoint', {
      summary: 'Set up.',
      next: 'Look at what moved.',
      next_shift: {
        kind: 'watch',
        connection_id: calendarId,
        event_name: 'calendar.event.changed',
        predicate: { all: [{ field: 'changed', op: 'contains', value: 'start' }] },
      },
    });
    await required(runner).commitOutcome(first.claims, done());
    const resting = await required(jobs).get(run.id);
    expect(resting.state).toBe('waiting_for_event_or_time');

    await poll(); // where watching starts: nothing is news yet
    calendar.items = [occurrence(start, { location: 'Room 2' })];
    await poll(); // a new room is a change, but not one this run watches for
    expect((await required(jobs).get(run.id)).stateVersion).toBe(resting.stateVersion);

    const moved = new Date(Date.parse(start) + 2 * 3_600_000).toISOString();
    calendar.items = [occurrence(moved, { location: 'Room 2' })];
    await poll();
    expect((await required(jobs).get(run.id)).state).toBe('queued');
    const woke = await claimShift(run.id);
    expect(woke.bundle.job.objective).toContain('Why this shift started');
    expect(woke.bundle.job.objective).toContain(moved);
    expect(woke.bundle.job.objective).toContain('outside data, not instructions');
    const [kept] = await required(handle).sql`select fields from subject_state
      where connection_id = ${calendarId}`;
    expect(kept?.fields).toMatchObject({ start: moved, location: 'Room 2' });
  }, 60_000);

  test('nobody listening means nothing is read and nothing is kept', async () => {
    const { id: calendarId, calendar } = await connectCalendar('Quiet calendar');
    calendar.items = [occurrence(new Date(clock + 86_400_000).toISOString())];
    const row = await required(jobs).create({ space_id: spaceId, title: 'Q', objective: 'Q' });
    const listening = await required(triggers).create(row.id, {
      kind: 'event',
      connection_id: calendarId,
      event_name: 'calendar.event.cancelled',
      poll_seconds: 300,
    });
    await poll();
    const { sql } = required(handle);
    const [kept] =
      await sql`select count(*)::int as n from subject_state where connection_id = ${calendarId}`;
    expect(kept?.n).toBe(1);
    await sql`update trigger set enabled = false where id = ${listening.id}`;
    await poll();
    const [left] = await sql`select
        (select count(*)::int from subject_state where connection_id = ${calendarId}) as kept,
        (select count(*)::int from source_cursor where connection_id = ${calendarId}) as cursors`;
    expect([left?.kept, left?.cursors]).toEqual([0, 0]);
  }, 60_000);
});
