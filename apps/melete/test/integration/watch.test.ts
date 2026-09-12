/**
 * Watch triggers. A monitor that wakes a model to look at an unchanged feed is
 * not watching, it is spending. The assertion that matters is the negative one:
 * a hundred observations that do not match cost nothing at all.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { JsonObject, WaitSpec } from '@melete/contracts';
import { eq } from 'drizzle-orm';
import { ServiceError } from '../../src/api/errors.ts';
import { connection, space, trigger } from '../../src/db/schema.ts';
import { newId } from '../../src/ids.ts';
import { type AttemptWake, QUEUES, startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { type JobRow, JobService } from '../../src/jobs/service.ts';
import { TriggerService } from '../../src/jobs/triggers.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const withDb = jobs ? describe : describe.skip;
const key = 'watch-predicate-signing-key-32-bytes!';
let runner: AttemptRunner;
let triggers: TriggerService;
let spaceId = '';
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

async function claim(row: JobRow) {
  const result = await runner.claim(wake(row));
  if (!result) throw new Error('Expected an admitted attempt');
  return result;
}

const waitFor = (claimed: ClaimedAttempt, wait: WaitSpec) =>
  runner.commitOutcome(claimed.claims, { kind: 'waiting_for_event_or_time', wait });

/** One observation from the feed, as a connector reported it. */
const observe = (id: string, payload: JsonObject) =>
  triggers.deliver({
    connection_id: connectionId,
    event_name: 'mail.new',
    cursor: `opaque-${id}`,
    dedup_key: id,
    payload,
  });

const routine = (index: number) => ({
  subject: `Weekly digest ${index}`,
  from: { address: 'digest@example.test' },
  amount: 0,
});

const overdue = {
  subject: 'Invoice 7731 is overdue',
  from: { address: 'billing@example.test' },
  amount: 240.5,
};

withDb('watch triggers', () => {
  const watching = async (row: JobRow) =>
    triggers.create(row.id, {
      kind: 'watch',
      connection_id: connectionId,
      event_name: 'mail.new',
      poll_seconds: 300,
      predicate: {
        all: [
          { field: 'from.address', op: 'eq', value: 'billing@example.test' },
          { field: 'subject', op: 'contains', value: 'overdue' },
          { field: 'amount', op: 'gt', value: 100 },
        ],
      },
    });

  const monitor = async () =>
    fixture().jobs.create({
      space_id: spaceId,
      title: 'Watch the billing mailbox',
      objective: 'Tell me when an invoice goes overdue.',
    });

  beforeEach(async () => {
    const { handle, queue, jobs } = fixture();
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    await handle.sql`truncate "owner", "space", event_retention cascade`;
    spaceId = newId('sp');
    connectionId = newId('conn');
    await handle.db
      .insert(space)
      .values({ id: spaceId, name: 'Personal', gitPath: `/spaces/${spaceId}` });
    await handle.db
      .insert(connection)
      .values({ id: connectionId, spaceId, provider: 'test', label: 'Scripted inbox' });
    runner = new AttemptRunner(jobs, new StubRuntimeAdapter(), { key });
    triggers = new TriggerService(jobs, runner);
  });

  afterAll(async () => {
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test('a hundred observations that do not match wake nothing; the one that matches wakes exactly once', async () => {
    const { handle, jobs } = fixture();
    const row = await monitor();
    const registration = await watching(row);
    const wait: WaitSpec = { kind: 'event', trigger_id: registration.id, deadline_at: null };
    const waiting = await waitFor(await claim(row), wait);
    expect(waiting.state).toBe('waiting_for_event_or_time');

    for (let index = 0; index < 100; index++) await observe(`routine-${index}`, routine(index));

    // Nothing moved: no wake, no attempt, no model call.
    const quiet = await jobs.get(row.id);
    expect(quiet.state).toBe('waiting_for_event_or_time');
    expect(quiet.stateVersion).toBe(waiting.stateVersion);
    expect(
      await handle.sql`select seq from event where job_id = ${row.id} and payload->>'kind' = 'trigger_event'`,
    ).toHaveLength(0);
    const attempts = await handle.sql`select id from attempt where job_id = ${row.id}`;
    expect(attempts).toHaveLength(1);

    const matched = await observe('overdue', overdue);
    const woken = await jobs.get(row.id);
    expect(woken.state).toBe('queued');

    const consumed =
      await handle.sql`select payload from event where job_id = ${row.id} and payload->>'kind' = 'trigger_event'`;
    expect(consumed).toHaveLength(1);
    const payload = consumed[0]?.payload as {
      because: string[];
      event: { payload: Record<string, unknown> };
    };
    // `because` names the observation that made the wake necessary.
    expect(payload.because).toEqual([`event:${matched.seq}`]);
    expect(payload.event.payload).toMatchObject({ subject: 'Invoice 7731 is overdue' });

    // The attempt gets the observation as its evidence.
    const next = await claim(woken);
    expect(next.bundle.inputs.trigger_events).toHaveLength(1);
    expect(next.bundle.inputs.trigger_events[0]).toMatchObject({
      cursor: 'opaque-overdue',
      payload: { subject: 'Invoice 7731 is overdue' },
    });
  }, 120_000);

  test('the cursor moves past observations that were tested, so none is tested twice', async () => {
    const { handle } = fixture();
    const row = await monitor();
    const registration = await watching(row);
    await waitFor(await claim(row), {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: null,
    });
    const first = await observe('routine-0', routine(0));
    const [afterFirst] = await handle.db
      .select()
      .from(trigger)
      .where(eq(trigger.id, registration.id));
    expect(Number(afterFirst?.cursor)).toBe(first.seq);
    expect(afterFirst?.lastObservation).toMatchObject({ subject: 'Weekly digest 0' });
  }, 60_000);

  test('a backlog accumulated while running reaches observation 201 through durable continuation', async () => {
    const { handle, jobs } = fixture();
    const row = await monitor();
    const registration = await watching(row);
    const running = await claim(row);
    let lastRoutine = 0;
    for (let index = 0; index < 200; index++)
      lastRoutine = (await observe(`backlog-${index}`, routine(index))).seq;
    const match = await observe('backlog-match', overdue);
    const waiting = await waitFor(running, {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: null,
    });
    expect(waiting.state).toBe('waiting_for_event_or_time');
    const [scanned] = await handle.sql`select cursor from trigger where id = ${registration.id}`;
    expect(Number(scanned?.cursor)).toBe(lastRoutine);
    const continuation =
      await handle.sql`select data from pgboss.job where name = 'melete.trigger-scan' and data->>'trigger_id' = ${registration.id}`;
    expect(continuation).toHaveLength(1);
    expect(continuation[0]?.data.after_seq).toBe(lastRoutine);
    // A new service resumes the persisted work, without a new feed delivery.
    const restarted = new TriggerService(jobs, runner);
    try {
      await restarted.start();
      const deadline = Date.now() + 10_000;
      while ((await jobs.get(row.id)).state !== 'queued' && Date.now() < deadline)
        await Bun.sleep(50);
      expect((await jobs.get(row.id)).state).toBe('queued');
      const consumed =
        await handle.sql`select payload from event where job_id = ${row.id} and payload->>'kind' = 'trigger_event'`;
      expect(consumed).toHaveLength(1);
      expect(consumed[0]?.payload.because).toEqual([`event:${match.seq}`]);
      const [finished] = await handle.sql`select cursor from trigger where id = ${registration.id}`;
      expect(Number(finished?.cursor)).toBe(match.seq);
      expect(await handle.sql`select id from attempt where job_id = ${row.id}`).toHaveLength(1);
      expect(
        await handle.sql`select id from pgboss.job where name = ${QUEUES.attempt} and data->>'job_id' = ${row.id} and data->>'reason' = 'event'`,
      ).toHaveLength(1);
    } finally {
      await restarted.stop();
    }
  }, 60_000);

  test('a changed clause is quiet on a first sighting and wakes on the second, different one', async () => {
    const { jobs } = fixture();
    const row = await monitor();
    const registration = await triggers.create(row.id, {
      kind: 'watch',
      connection_id: connectionId,
      event_name: 'mail.new',
      poll_seconds: 300,
      predicate: { all: [{ field: 'status', op: 'changed', value: null }] },
    });
    await waitFor(await claim(row), {
      kind: 'event',
      trigger_id: registration.id,
      deadline_at: null,
    });

    await observe('first', { status: 'pending' });
    expect((await jobs.get(row.id)).state).toBe('waiting_for_event_or_time');

    await observe('same', { status: 'pending' });
    expect((await jobs.get(row.id)).state).toBe('waiting_for_event_or_time');

    await observe('moved', { status: 'shipped' });
    expect((await jobs.get(row.id)).state).toBe('queued');
  }, 60_000);

  test('a pattern that does not compile is refused when the watch is made, not silently never matched', async () => {
    const row = await monitor();
    let caught: unknown;
    try {
      await triggers.create(row.id, {
        kind: 'watch',
        connection_id: connectionId,
        event_name: 'mail.new',
        poll_seconds: 300,
        predicate: { all: [{ field: 'subject', op: 'matches', value: '(' }] },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceError);
    expect((caught as ServiceError).code).toBe('invalid_predicate');
  }, 60_000);

  test('a watch on a connection outside the job space is refused', async () => {
    const { handle } = fixture();
    const otherSpace = newId('sp');
    const otherConnection = newId('conn');
    await handle.db
      .insert(space)
      .values({ id: otherSpace, name: 'Elsewhere', gitPath: `/spaces/${otherSpace}` });
    await handle.db
      .insert(connection)
      .values({ id: otherConnection, spaceId: otherSpace, provider: 'test', label: 'Elsewhere' });
    const row = await monitor();
    let caught: unknown;
    try {
      await triggers.create(row.id, {
        kind: 'watch',
        connection_id: otherConnection,
        event_name: 'mail.new',
        poll_seconds: 300,
        predicate: { all: [{ field: 'subject', op: 'contains', value: 'anything' }] },
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as ServiceError).code).toBe('unknown_connection');
  }, 60_000);
});
