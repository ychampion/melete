/**
 * Watching by default: a mailbox or calendar a person connects in their own
 * space is read for changes with nothing set up, a room's only once its
 * owners turn it on, and the switch stops the reads and forgets the cursor.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { EmailConnector } from '../../src/connectors/email.ts';
import type { MailMessage, MailTransport } from '../../src/connectors/mail-transport.ts';
import { connection, owner, space } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { DEFAULT_WATCH_SECONDS, SignalPoller } from '../../src/signals/poller.ts';
import type { SignalSource } from '../../src/signals/types.ts';
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
  const box = { messages: [] as MailMessage[], reads: 0 };
  const transport: MailTransport = {
    search: async () => [],
    read: async () => null,
    send: async () => ({ messageId: 'x', sentCopy: false }),
    findSent: async () => false,
    health: async () => {},
    changes: async (cursor) => {
      box.reads += 1;
      const from = cursor === null ? box.messages.length : Number(cursor);
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
    await setWatching(required(handle).db, spaceId, id, false);
    expect(await cursors(id)).toEqual({ count: 0, every: null });
    box.messages.push(header(3, 'Second'));
    await poll();
    await poll();
    expect(box.reads).toBe(2);
    expect(await cursors(id)).toEqual({ count: 0, every: null });
    expect(await received(id)).toEqual(['First']);
    // On again, watching starts afresh from now.
    await setWatching(required(handle).db, spaceId, id, true);
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
    await setWatching(required(handle).db, roomId, id, true);
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
    await expect(setWatching(required(handle).db, spaceId, other, true)).rejects.toMatchObject({
      code: 'not_watchable',
    });
    const { id } = await connectMailbox('Elsewhere');
    await expect(setWatching(required(handle).db, newId('sp'), id, false)).rejects.toMatchObject({
      code: 'not_found',
    });
  }, 60_000);
});
