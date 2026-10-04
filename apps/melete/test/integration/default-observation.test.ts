/**
 * Watching by default: a mailbox or calendar a person connects in their own
 * space is read for changes with nothing set up, a room's only once its
 * owners turn it on, and the switch stops the reads and forgets the cursor.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { WaitSpec } from '@melete/contracts';
import { EmailConnector } from '../../src/connectors/email.ts';
import type { MailMessage, MailTransport } from '../../src/connectors/mail-transport.ts';
import { connection, owner, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import {
  DEFAULT_WATCH_NIGHT_SECONDS,
  DEFAULT_WATCH_SECONDS,
  SignalPoller,
} from '../../src/signals/poller.ts';
import { expireObservations, sweepObservations } from '../../src/signals/retention.ts';
import { type SignalSource, SourceError } from '../../src/signals/types.ts';
import { setWatching } from '../../src/signals/watching.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runner = jobs
  ? new AttemptRunner(jobs, new StubRuntimeAdapter(), {
      key: 'default-observation-signing-key-32b!',
    })
  : null;
const triggers = jobs && runner ? new TriggerService(jobs, runner) : null;
const withDb = triggers ? describe : describe.skip;
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected test fixture');
  return value;
}

const ownerId = newId('own');
const spaceId = newId('sp');
if (handle) {
  await handle.db.insert(owner).values({ id: ownerId, email: 'watching@example.test' });
  await handle.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId}`;
  await handle.db.insert(space).values({ id: spaceId, name: 'Personal', gitPath: `/s/${spaceId}` });
}

const sources = new Map<string, { signals?: SignalSource }>();
let clock = Date.parse('2026-10-05T12:00:00.000Z');
const poller =
  handle && triggers
    ? new SignalPoller({ sql: handle.sql, triggers, connectors: sources, now: () => clock })
    : null;
async function poll() {
  await required(poller).runOnce();
  clock += 3_600_000;
}

const header = (index: number, subject: string): MailMessage => ({
  id: `m${index}`,
  message_id: `<m${index}@example.test>`,
  from: 'Friend <friend@example.test>',
  from_addresses: ['friend@example.test'],
  to: 'me@example.test',
  to_addresses: ['me@example.test'],
  subject,
  text: '',
  html: '',
  date: new Date(clock).toISOString(),
});

/** A mailbox connected the way a person connects one, read through the real mail connector. */
async function connectMailbox(label: string, inSpace = spaceId, sharedUse = 'owner') {
  const id = newId('conn');
  await required(handle).db.insert(connection).values({
    id,
    spaceId: inSpace,
    provider: 'imap',
    label,
    sharedUse,
  });
  const box = {
    messages: [] as MailMessage[],
    reads: 0,
    fail: null as Error | null,
    /** Hand every message back on the next read, as a mailbox does after a resync. */
    rewind: false,
  };
  const transport: MailTransport = {
    search: async () => [],
    read: async () => null,
    send: async () => ({ messageId: 'x', sentCopy: false }),
    findSent: async () => false,
    health: async () => {},
    changes: async (cursor) => {
      box.reads += 1;
      if (box.fail) throw box.fail;
      const from = cursor === null ? box.messages.length : box.rewind ? 0 : Number(cursor);
      box.rewind = false;
      const messages = cursor === null ? [] : box.messages.slice(from);
      return {
        cursor: String(box.messages.length),
        messages: messages.map((message) => ({
          ...message,
          key: `msgid:${message.message_id}`,
          read_key: String(message.id),
        })),
      };
    },
  };
  sources.set(id, {
    signals: new EmailConnector({
      kind: 'api',
      id,
      spaceId: inSpace,
      from: 'me@example.test',
      session: async (work) => work(transport),
    }).signals,
  });
  return { id, box };
}

const received = async (connectionId: string) => {
  const rows = await required(handle).sql`select payload from event
    where job_id is null and payload->>'kind' = 'connector_event'
      and payload->>'connection_id' = ${connectionId} and payload->>'event_name' = 'mail.received'
    order by seq`;
  return rows.map((row) => (row.payload as { payload: { subject: string } }).payload.subject);
};
const cursors = async (connectionId: string) => {
  const [row] = await required(handle).sql`select count(*)::int as n, min(interval_s) as every
    from source_cursor where connection_id = ${connectionId}`;
  return { count: Number(row?.n ?? 0), every: row?.every === null ? null : Number(row?.every) };
};

withDb('watching connected accounts by default', () => {
  afterAll(async () => {
    await runner?.stop();
    await queue?.stop();
    await handle?.close();
  }, 30_000);

  test('a newly connected mailbox produces mail.received with no trigger', async () => {
    const { id, box } = await connectMailbox('Personal mail');
    await poll(); // where watching starts
    expect(await cursors(id)).toEqual({ count: 1, every: DEFAULT_WATCH_SECONDS });
    box.messages.push(header(1, 'Dinner on Friday?'));
    await poll();
    expect(await received(id)).toEqual(['Dinner on Friday?']);
    const [triggersMade] = await required(handle).sql`select count(*)::int as n from trigger
      where spec->>'connection_id' = ${id}`;
    expect(triggersMade?.n).toBe(0);
  }, 60_000);

  test('switching it off stops reads and clears its cursor', async () => {
    const { id, box } = await connectMailbox('Mail to stop watching');
    await poll();
    box.messages.push(header(2, 'First'));
    await poll();
    expect(box.reads).toBe(2);
    await setWatching(required(handle).sql, spaceId, id, false);
    expect(await cursors(id)).toEqual({ count: 0, every: null });
    box.messages.push(header(3, 'Second'));
    await poll();
    await poll();
    expect(box.reads).toBe(2);
    expect(await cursors(id)).toEqual({ count: 0, every: null });
    // What watching read, and nothing used, went with it.
    expect(await received(id)).toEqual([]);
    // On again, watching starts afresh from now.
    await setWatching(required(handle).sql, spaceId, id, true);
    await poll();
    expect(box.reads).toBe(3);
    expect(await cursors(id)).toEqual({ count: 1, every: DEFAULT_WATCH_SECONDS });
  }, 60_000);

  test('a room account is not observed by default', async () => {
    const roomId = newId('sp');
    await required(handle).sql`insert into space (id, name, kind, owner_principal_id, git_path)
      values (${roomId}, 'Studio', 'shared', ${ownerId}, ${`/s/${roomId}`})`;
    const { id, box } = await connectMailbox('Team mailbox', roomId, 'room');
    await poll();
    box.messages.push(header(4, 'For the team'));
    await poll();
    expect(box.reads).toBe(0);
    expect(await cursors(id)).toEqual({ count: 0, every: null });
    // The room's owners turn it on: from then on the room's mailbox is read.
    await setWatching(required(handle).sql, roomId, id, true);
    await poll();
    box.messages.push(header(5, 'Team news'));
    await poll();
    expect(await received(id)).toEqual(['Team news']);
  }, 60_000);

  test('a code mail is still dropped', async () => {
    const { id, box } = await connectMailbox('Mail with codes');
    await poll();
    box.messages.push(
      header(6, 'Your code is 482910'),
      header(7, 'G-112233 is your Google verification code'),
      header(8, 'Lunch next week'),
    );
    await poll();
    expect(await received(id)).toEqual(['Lunch next week']);
  }, 60_000);

  test('only a mailbox or a calendar can be watched, and only in its own space', async () => {
    const other = newId('conn');
    await required(handle).db.insert(connection).values({
      id: other,
      spaceId,
      provider: 'web',
      label: 'Web',
    });
    await expect(setWatching(required(handle).sql, spaceId, other, true)).rejects.toMatchObject({
      code: 'not_watchable',
    });
    const { id } = await connectMailbox('Elsewhere');
    await expect(setWatching(required(handle).sql, newId('sp'), id, false)).rejects.toMatchObject({
      code: 'not_found',
    });
  }, 60_000);
  /** A job waiting on a watch for mail whose subject holds `word`. */
  async function waitingFor(connectionId: string, word: string) {
    const row = await required(jobs).create({ space_id: spaceId, title: 'W', objective: 'W' });
    const made = await required(triggers).create(row.id, {
      kind: 'watch',
      connection_id: connectionId,
      event_name: 'mail.received',
      poll_seconds: 300,
      predicate: { all: [{ field: 'subject', op: 'contains', value: word }] },
    });
    const claimed = required(
      await required(runner).claim({
        job_id: row.id,
        expected_epoch: row.leaseEpoch,
        expected_version: row.stateVersion,
        reason: 'created',
      }),
    );
    const wait: WaitSpec = { kind: 'event', trigger_id: made.id, deadline_at: null };
    await required(runner).commitOutcome(claimed.claims, {
      kind: 'waiting_for_event_or_time',
      wait,
    });
    return { jobId: row.id, triggerId: made.id };
  }
  const subjects = async (connectionId: string) => (await received(connectionId)).sort();

  test('turning watching off removes what it read, and keeps what work took in', async () => {
    const { id, box } = await connectMailbox('Mail with a private thread');
    const { jobId } = await waitingFor(id, 'Kept');
    await poll();
    box.messages.push(header(10, 'Settlement terms (private)'), header(11, 'Kept by the work'));
    await poll();
    expect(await subjects(id)).toEqual(['Kept by the work', 'Settlement terms (private)']);
    expect((await required(jobs).get(jobId)).state).toBe('queued');
    await setWatching(required(handle).sql, spaceId, id, false);
    // The observation the work woke on stays; the one nothing used is gone.
    expect(await subjects(id)).toEqual(['Kept by the work']);
    const [copies] = await required(handle).sql`select count(*)::int as n from event
      where job_id = ${jobId} and payload->>'kind' = 'trigger_event'`;
    expect(copies?.n).toBe(1);
    const [leftover] = await required(handle).sql`select count(*)::int as n from event
      where payload::text like '%Settlement terms%'`;
    expect(leftover?.n).toBe(0);
  }, 60_000);

  test('observations nothing used go after the retention period, on the leading instance only', async () => {
    const { id, box } = await connectMailbox('Mail that ages');
    const { triggerId } = await waitingFor(id, 'Cited');
    await poll();
    box.messages.push(
      header(20, 'Old and unused'),
      header(21, 'Cited by the work'),
      header(22, 'Recent and unused'),
    );
    await poll();
    // The work stops listening, so nothing still waits to read these.
    await required(handle).sql`update trigger set enabled = false where id = ${triggerId}`;
    await required(handle).sql`update event set created_at = now() - interval '15 days'
      where job_id is null and payload->>'connection_id' = ${id}
        and payload->'payload'->>'subject' in ('Old and unused', 'Cited by the work')`;
    // Not leading: nothing goes.
    expect(await sweepObservations(required(handle).sql, 14, () => false)).toBe(0);
    expect(await subjects(id)).toHaveLength(3);
    // Kept for 30 days instead: nothing is old enough yet.
    expect(await expireObservations(required(handle).sql, 30)).toBe(0);
    await expireObservations(required(handle).sql, 14);
    expect(await subjects(id)).toEqual(['Cited by the work', 'Recent and unused']);
  }, 60_000);

  test('a read in flight when watching is turned off keeps nothing it found', async () => {
    const calendarId = newId('conn');
    await required(handle).db.insert(connection).values({
      id: calendarId,
      spaceId,
      provider: 'caldav',
      label: 'Calendar turned off mid-read',
    });
    let turnOff = false;
    sources.set(calendarId, {
      signals: {
        stream: 'calendar',
        occurrences: async () => {
          if (turnOff) await setWatching(required(handle).sql, spaceId, calendarId, false);
          return {
            items: [
              {
                uid: 'meeting@example.test',
                occurrence: null,
                title: 'Board meeting',
                start: new Date(clock + 86_400_000).toISOString(),
                end: new Date(clock + 90_000_000).toISOString(),
                all_day: false,
                location: 'Room 1',
                status: 'confirmed',
                attendees: 3,
                time_zone: null,
              },
            ],
            complete: true,
          };
        },
      },
    });
    turnOff = true;
    await poll();
    const [kept] = await required(handle).sql`select
        (select count(*)::int from subject_state where connection_id = ${calendarId}) as kept,
        (select count(*)::int from source_cursor where connection_id = ${calendarId}) as cursors`;
    expect([kept?.kept, kept?.cursors]).toEqual([0, 0]);
  }, 60_000);

  test('a provider in trouble pauses its own accounts, and the others keep being read', async () => {
    // Accounts left from earlier tests stay quiet here.
    await required(handle)
      .sql`update connection set watch_changes = false where space_id = ${spaceId}`;
    const failing: Awaited<ReturnType<typeof connectMailbox>>[] = [];
    for (let index = 0; index < 5; index++) {
      const account = await connectMailbox(`Down mailbox ${index}`);
      account.box.fail = new SourceError(503, null);
      failing.push(account);
    }
    const calendarId = newId('conn');
    await required(handle).db.insert(connection).values({
      id: calendarId,
      spaceId,
      provider: 'caldav',
      label: 'Calendar elsewhere',
    });
    let calendarReads = 0;
    sources.set(calendarId, {
      signals: {
        stream: 'calendar',
        occurrences: async () => {
          calendarReads += 1;
          return { items: [], complete: true };
        },
      },
    });
    const sequential = new SignalPoller({
      sql: required(handle).sql,
      triggers: required(triggers),
      connectors: sources,
      now: () => clock,
      concurrency: 1,
    });
    await sequential.runOnce();
    const reads = () => failing.reduce((sum, account) => sum + account.box.reads, 0);
    // Three failures in a row open the breaker; the other two are not read.
    expect(reads()).toBe(3);
    expect(calendarReads).toBe(1);
    const [paused] = await required(handle).sql`select count(*)::int as n from source_cursor
      where connection_id in ${required(handle).sql(failing.map((account) => account.id))}
        and failures = 0 and last_error like '%provider%'`;
    expect(paused?.n).toBe(2);
    // Once the pause is over, they are read again.
    clock += 600_000;
    await sequential.runOnce();
    expect(reads()).toBeGreaterThan(3);
    clock += 3_600_000;
    // Quiet again for the tests after this one.
    await required(handle)
      .sql`update connection set watch_changes = false where space_id = ${spaceId}`;
  }, 60_000);
  test('a watched account is read less often in its owner’s night', async () => {
    const { id } = await connectMailbox('Mail read at night');
    const saved = clock;
    try {
      clock = Date.parse('2026-10-08T23:30:00.000Z');
      await required(poller).refresh();
      expect(await cursors(id)).toEqual({ count: 1, every: DEFAULT_WATCH_NIGHT_SECONDS });
      clock = Date.parse('2026-10-09T09:30:00.000Z');
      await required(poller).refresh();
      expect(await cursors(id)).toEqual({ count: 1, every: DEFAULT_WATCH_SECONDS });
    } finally {
      clock = Math.max(saved, clock);
    }
  }, 60_000);
  test('a message read again after its observation expired is not delivered twice', async () => {
    const { id, box } = await connectMailbox('Mail read again later');
    await poll();
    box.messages.push(header(30, 'Quarterly numbers'));
    await poll();
    expect(await received(id)).toEqual(['Quarterly numbers']);
    const { sql } = required(handle);
    await sql`update event set created_at = now() - interval '20 days'
      where job_id is null and payload->>'connection_id' = ${id}`;
    await expireObservations(sql, 14);
    expect(await received(id)).toEqual([]);
    const [kept] = await sql`select count(*)::int as n from observation_tombstone
      where connection_id = ${id}`;
    expect(kept?.n).toBe(1);
    // The mailbox hands the message back, as after a resync: it is recognised.
    box.rewind = true;
    await poll();
    expect(await received(id)).toEqual([]);
    // Delivered directly under the same key, it is a duplicate too.
    const [tombstone] = await sql`select dedup_key from observation_tombstone
      where connection_id = ${id}`;
    const again = await required(triggers).deliver({
      connection_id: id,
      event_name: 'mail.received',
      cursor: 'again',
      dedup_key: String(tombstone?.dedup_key).slice(`connector:${id}:`.length),
      payload: { subject: 'Quarterly numbers' },
    });
    expect(again.duplicate).toBe(true);
    expect(await received(id)).toEqual([]);
  }, 60_000);

  test('mail an open wait on an answer may still need is kept while the wait is open', async () => {
    const { id, box } = await connectMailbox('Mail with an open wait');
    await poll();
    box.messages.push(header(40, 'Re: the proposal'));
    await poll();
    const { sql } = required(handle);
    await sql`update event set created_at = now() - interval '18 days'
      where job_id is null and payload->>'connection_id' = ${id}`;
    const waitId = newId('task');
    await sql`insert into awaited_reply (id, space_id, principal_id, message_id, to_address,
        subject, sent_at, evidence, status, scan_id)
      values (${waitId}, ${spaceId}, ${ownerId}, '<sent@example.test>', 'friend@example.test',
        'The proposal', now() - interval '25 days', '{}'::jsonb, 'waiting', 'scan_1')`;
    await expireObservations(sql, 14);
    expect(await received(id)).toEqual(['Re: the proposal']);
    await sql`update awaited_reply set status = 'settled' where id = ${waitId}`;
    await expireObservations(sql, 14);
    expect(await received(id)).toEqual([]);
  }, 60_000);

  test('a request to slow down from one account pauses that account alone', async () => {
    await required(handle)
      .sql`update connection set watch_changes = false where space_id = ${spaceId}`;
    const busy: Awaited<ReturnType<typeof connectMailbox>>[] = [];
    for (let index = 0; index < 4; index++) {
      const account = await connectMailbox(`Busy mailbox ${index}`);
      account.box.fail = new SourceError(429, 900);
      busy.push(account);
    }
    const sequential = new SignalPoller({
      sql: required(handle).sql,
      triggers: required(triggers),
      connectors: sources,
      now: () => clock,
      concurrency: 1,
    });
    const at = clock;
    await sequential.runOnce();
    // Every account was read: one account's limit is not the provider's.
    expect(busy.map((account) => account.box.reads)).toEqual([1, 1, 1, 1]);
    const due = await required(handle).sql`select next_poll_at from source_cursor
      where connection_id in ${required(handle).sql(busy.map((account) => account.id))}`;
    for (const row of due) expect(new Date(row.next_poll_at).getTime()).toBe(at + 900_000);
    clock += 3_600_000;
  }, 60_000);
});
