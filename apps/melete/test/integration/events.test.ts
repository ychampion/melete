import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ApiEvent, EventType, JsonObject } from '@melete/contracts';
import { Hono } from 'hono';
import { PgBoss } from 'pg-boss';
import { ServiceError } from '../../src/api/errors.ts';
import { mountEvents } from '../../src/api/events.ts';
import { openDatabase } from '../../src/db/client.ts';
import { job, space } from '../../src/db/schema.ts';
import { serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { EventStream } from '../../src/events/stream.ts';
import { newId } from '../../src/ids.ts';
import { JobService } from '../../src/jobs/service.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const second = handle ? openDatabase(handle.url, 1) : null;
const jobs = handle
  ? new JobService(handle.db, new PgBoss({ connectionString: handle.url }))
  : null;
const withDb = handle ? describe : describe.skip;
const streams = new Set<EventStream>();
type StreamReader = {
  read(): Promise<{ done?: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};
const readers = new Set<StreamReader>();
let jobA = '';
let jobB = '';

function database() {
  if (!handle || !second || !jobs) throw new Error('Postgres unavailable');
  return { handle, second, jobs };
}

function stream(options: ConstructorParameters<typeof EventStream>[1] = {}) {
  const events = new EventStream(database().handle, options);
  streams.add(events);
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ServiceError) return c.json({ error: error.code }, error.status);
    throw error;
  });
  mountEvents(app, events, database().jobs);
  return { events, app };
}

async function write(
  jobId: string | null,
  payload: JsonObject,
  options: { type?: EventType; dedupKey?: string; secondConnection?: boolean } = {},
) {
  const { handle, second } = database();
  const row = await serviceTransaction((options.secondConnection ? second : handle).db, (tx) =>
    appendEvent(tx, {
      jobId,
      type: options.type ?? 'notice',
      payload,
      dedupKey: options.dedupKey ?? `test:${newId('job')}`,
    }),
  );
  if (!row) throw new Error('expected a new persisted event');
  return row;
}

async function reader(response: Promise<Response> | Response) {
  const actual = await response;
  expect(actual.status).toBe(200);
  expect(actual.headers.get('content-type')).toContain('text/event-stream');
  const value = actual.body?.getReader();
  if (!value) throw new Error('stream has no body');
  readers.add(value);
  return value;
}

async function readChunk(value: StreamReader): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      value.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSE read timed out')), 2500);
      }),
    ]);
    return result.done ? null : new TextDecoder().decode(result.value);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readEvent(value: StreamReader) {
  for (;;) {
    const chunk = await readChunk(value);
    if (chunk === null) throw new Error('SSE ended before an event');
    if (chunk.startsWith(':')) continue;
    const data = chunk.split('\n').find((line) => line.startsWith('data: '));
    if (!data) throw new Error(`SSE frame has no data: ${chunk}`);
    return {
      id: Number(
        chunk
          .split('\n')
          .find((line) => line.startsWith('id: '))
          ?.slice(4),
      ),
      name: chunk
        .split('\n')
        .find((line) => line.startsWith('event: '))
        ?.slice(7),
      data: JSON.parse(data.slice(6)) as Omit<ApiEvent, 'dedup_key'>,
    };
  }
}

async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2500;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('SSE condition timed out');
    await Bun.sleep(10);
  }
}

withDb('persisted event streams', () => {
  beforeEach(async () => {
    const { handle } = database();
    await handle.sql`truncate "space" cascade`;
    const spaceId = newId('sp');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: '/spaces/test' });
    jobA = newId('job');
    jobB = newId('job');
    await handle.db.insert(job).values([
      { id: jobA, spaceId, title: 'A', objective: 'Stream A.' },
      { id: jobB, spaceId, title: 'B', objective: 'Stream B.' },
    ]);
  });
  afterEach(async () => {
    // Stream shutdown drains pending queries before releasing the shared listener.
    for (const value of readers) await value.cancel().catch(() => {});
    readers.clear();
    for (const value of streams) await value.close();
    streams.clear();
  }, 15_000);
  afterAll(async () => {
    // Both pools can consume their five-second drain allowance during shutdown.
    await second?.close();
    await handle?.close();
  }, 15_000);

  test('replays actual global rows and isolates the job stream across sequence gaps', async () => {
    const first = await write(jobA, { text: 'A1' }, { type: 'text_delta' });
    const other = await write(jobB, { text: 'B1' });
    const global = await write(null, { text: 'Global' });
    const last = await write(jobA, { text: 'A2' });
    const { app } = stream({ pageSize: 2 });
    const globalReader = await reader(app.request('/events?after=0'));
    const actualGlobal = [];
    for (let index = 0; index < 4; index++) actualGlobal.push((await readEvent(globalReader)).id);
    expect(actualGlobal).toEqual([first?.seq, other?.seq, global?.seq, last?.seq]);
    const jobReader = await reader(app.request(`/jobs/${jobA}/events?after=0`));
    expect((await readEvent(jobReader)).id).toBe(first?.seq);
    expect((await readEvent(jobReader)).id).toBe(last?.seq);
  });

  test('Last-Event-ID overrides the URL cursor and unknown jobs fail before streaming', async () => {
    const first = await write(jobA, { text: 'First' });
    const next = await write(jobA, { text: 'Next' });
    const { app, events } = stream();
    const resumed = await reader(
      app.request(`/jobs/${jobA}/events?after=${next?.seq}`, {
        headers: { 'Last-Event-ID': String(first?.seq) },
      }),
    );
    expect((await readEvent(resumed)).id).toBe(next?.seq);
    const count = events.subscriberCount;
    expect((await app.request(`/jobs/${newId('job')}/events`)).status).toBe(404);
    expect(events.subscriberCount).toBe(count);
  });

  test('refuses negative, fractional, unsafe and malformed cursors', async () => {
    const { app, events } = stream();
    for (const value of ['-1', '1.5', '1e3', '', '9007199254740992', 'abc', ' 1']) {
      expect((await app.request(`/events?after=${encodeURIComponent(value)}`)).status).toBe(400);
      // HTTP Headers normalizes surrounding whitespace before route parsing.
      if (value !== value.trim()) continue;
      expect(
        (await app.request('/events?after=0', { headers: { 'Last-Event-ID': value } })).status,
      ).toBe(400);
    }
    expect(events.subscriberCount).toBe(0);
  });

  test('receives an append concurrent with subscription establishment exactly once', async () => {
    const { app } = stream();
    const pendingResponse = app.request(`/jobs/${jobA}/events`);
    const appended = await write(jobA, { text: 'During subscribe' });
    const subscribed = await reader(pendingResponse);
    expect((await readEvent(subscribed)).id).toBe(appended?.seq);
    const following = await write(jobA, { text: 'After subscribe' });
    expect((await readEvent(subscribed)).id).toBe(following?.seq);
  });

  test('one dedicated listener fans out commits from a second database connection', async () => {
    const { app, events } = stream();
    const first = await reader(app.request(`/jobs/${jobA}/events`));
    const secondReader = await reader(app.request('/events'));
    const committed = await write(jobA, { text: 'Other connection' }, { secondConnection: true });
    expect((await readEvent(first)).id).toBe(committed?.seq);
    expect((await readEvent(secondReader)).id).toBe(committed?.seq);
    expect(events.subscriberCount).toBe(2);
    const active = await database().handle
      .sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and application_name = 'melete-events'`;
    expect(active[0]?.count).toBe(1);
  });

  test('duplicate event delivery emits one stored row and no duplicate frame', async () => {
    const { app } = stream();
    const subscribed = await reader(app.request(`/jobs/${jobA}/events`));
    const first = await write(jobA, { text: 'One' }, { dedupKey: 'same-event' });
    const duplicate = await serviceTransaction(database().second.db, (tx) =>
      appendEvent(tx, {
        jobId: jobA,
        type: 'notice',
        payload: { text: 'One' },
        dedupKey: 'same-event',
      }),
    );
    const next = await write(jobA, { text: 'Two' });
    expect(duplicate).toBeUndefined();
    expect((await readEvent(subscribed)).id).toBe(first?.seq);
    expect((await readEvent(subscribed)).id).toBe(next?.seq);
  });

  test('a slow consumer retains one page and receives every persisted event in order', async () => {
    const expected: number[] = [];
    for (let index = 0; index < 35; index++) {
      const row = await write(jobA, { index });
      if (row) expected.push(row.seq);
    }
    const { app, events } = stream({ pageSize: 3, pollIntervalMs: 20 });
    const subscribed = await reader(app.request(`/jobs/${jobA}/events`));
    await eventually(() => events.bufferedEventCount > 0);
    for (let index = 35; index < 45; index++) {
      const row = await write(jobA, { index }, { secondConnection: true });
      if (row) expected.push(row.seq);
    }
    expect(events.bufferedEventCount).toBeLessThanOrEqual(3);
    const received: number[] = [];
    for (let index = 0; index < expected.length; index++)
      received.push((await readEvent(subscribed)).id);
    expect(received).toEqual(expected);
  });

  test('a gap marker names its persisted notice and rollback holes never invent gaps', async () => {
    const first = await write(jobA, { text: 'Before' });
    try {
      await serviceTransaction(database().handle.db, async (tx) => {
        await appendEvent(tx, {
          jobId: jobA,
          type: 'notice',
          payload: { text: 'Rolled back' },
          dedupKey: 'rolled-back',
        });
        throw new Error('rollback fixture');
      });
    } catch (error) {
      expect(String(error)).toContain('rollback fixture');
    }
    const next = await write(jobA, { text: 'After rollback' });
    const gap = await write(jobA, {
      kind: 'gap',
      reason: 'runtime_lost',
      attempt_id: 'old-attempt',
    });
    const { app } = stream();
    const subscribed = await reader(app.request(`/jobs/${jobA}/events?after=${first?.seq}`));
    const ordinary = await readEvent(subscribed);
    expect(ordinary.id).toBe(next?.seq);
    expect(ordinary.name).toBe('notice');
    const marker = await readEvent(subscribed);
    expect(marker.id).toBe(gap?.seq);
    expect(marker.name).toBe('gap');
    expect(marker.data.type).toBe('notice');
    expect(marker.data.payload).toEqual({
      kind: 'gap',
      reason: 'runtime_lost',
      attempt_id: 'old-attempt',
    });
  });

  test('replays across a terminated LISTEN connection and cleans it up on shutdown', async () => {
    const { app, events } = stream({ pollIntervalMs: 30 });
    const subscribed = await reader(app.request(`/jobs/${jobA}/events`));
    const { handle } = database();
    const terminated =
      await handle.sql`select pg_terminate_backend(pid) as terminated from pg_stat_activity where datname = current_database() and application_name = 'melete-events'`;
    expect(terminated.some((row) => row.terminated)).toBe(true);
    const committed = await write(jobA, { text: 'After reconnect' }, { secondConnection: true });
    expect((await readEvent(subscribed)).id).toBe(committed?.seq);
    await events.close();
    expect(events.subscriberCount).toBe(0);
    await eventually(async () => {
      const active =
        await handle.sql`select count(*)::int as count from pg_stat_activity where datname = current_database() and application_name = 'melete-events'`;
      return active[0]?.count === 0;
    });
    expect((await handle.sql`select 1 as available`)[0]?.available).toBe(1);
  });

  test('abort, reader cancellation and shutdown release clients without waiting for a new event', async () => {
    const { app, events } = stream({ pollIntervalMs: 20 });
    const controller = new AbortController();
    const aborted = await reader(
      app.request(`/jobs/${jobA}/events`, { signal: controller.signal }),
    );
    const cancelled = await reader(app.request('/events'));
    expect(events.subscriberCount).toBe(2);
    controller.abort();
    expect(await readChunk(aborted)).toBeNull();
    expect(events.subscriberCount).toBe(1);
    await cancelled.cancel();
    expect(events.subscriberCount).toBe(0);
    const closed = await reader(app.request('/events'));
    await events.close();
    expect(await readChunk(closed)).toBeNull();
    expect(events.subscriberCount).toBe(0);
  });

  test('idle keepalive is a comment without an event ID', async () => {
    const { app } = stream({ pollIntervalMs: 10, keepaliveMs: 30 });
    const subscribed = await reader(app.request('/events'));
    expect(await readChunk(subscribed)).toBe(': keepalive\n\n');
    const committed = await write(jobA, { text: 'After keepalive' });
    expect((await readEvent(subscribed)).id).toBe(committed?.seq);
  });
});
