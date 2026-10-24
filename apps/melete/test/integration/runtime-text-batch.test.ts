/** Contiguous words share their writes without changing the conversation or event order. */
import { afterAll, describe, expect, test } from 'bun:test';
import { dedupKey, type RuntimeEvent } from '@melete/contracts';
import { asc, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { attempt, event, experienceTurn, schema, space } from '../../src/db/schema.ts';
import type { Transaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { ExperienceService } from '../../src/experience/service.ts';
import { newId } from '../../src/ids.ts';
import { startQueue } from '../../src/jobs/queue.ts';
import { AttemptRunner, type ClaimedAttempt } from '../../src/jobs/runner.ts';
import { JobService } from '../../src/jobs/service.ts';
import { SubmissionService } from '../../src/jobs/submissions.ts';
import { StubRuntimeAdapter } from '../../src/runtime/stub.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const queue = handle ? await startQueue(handle.url) : null;
const jobs = handle && queue ? new JobService(handle.db, queue.boss) : null;
const runners: AttemptRunner[] = [];
function runner() {
  const one = new AttemptRunner(required(jobs), new StubRuntimeAdapter(), {
    key: 'text-batch-test-capability-key-at-least-32-bytes',
  });
  runners.push(one);
  return one;
}
const one = jobs ? runner() : null;
const conversations =
  handle && jobs && one
    ? new ExperienceService(handle.db, jobs, new SubmissionService(jobs), one)
    : null;
const withDb = handle ? describe : describe.skip;

async function claim(jobId: string, worker = required(one)) {
  const row = await required(jobs).get(jobId);
  return required(
    await worker.claim({
      job_id: row.id,
      expected_epoch: row.leaseEpoch,
      expected_version: row.stateVersion,
      reason: 'input',
    }),
  );
}

async function conversation(name: string) {
  const spaceId = newId('sp');
  await required(handle)
    .db.insert(space)
    .values({ id: spaceId, name, gitPath: `/spaces/${spaceId}` });
  const created = await required(conversations).createConversation(spaceId, {
    title: name,
  });
  if (!('conversation' in created)) throw new Error('Expected an available conversation');
  const { conversation } = created;
  const accepted = await required(conversations).message(spaceId, conversation.id, {
    text: 'Give me the answer.',
  });
  if (!('turn_id' in accepted)) throw new Error('Expected an accepted turn');
  return {
    jobId: conversation.id,
    turnId: accepted.turn_id,
    admitted: await claim(conversation.id),
  };
}

function text(admitted: ClaimedAttempt, pieces: readonly string[], from = 0): RuntimeEvent[] {
  return pieces.map((value, index) => ({
    type: 'text_delta',
    attempt_id: admitted.claims.attempt_id,
    local_seq: from + index,
    dedup_key: dedupKey(admitted.claims.attempt_id, from + index),
    at: '2026-10-24T04:00:00.000Z',
    text: value,
  }));
}

async function write(
  worker: AttemptRunner,
  admitted: ClaimedAttempt,
  values: RuntimeEvent[],
  batch: boolean,
) {
  if (batch) expect(await worker.emitMany(admitted.claims, values)).toEqual(values.map(() => null));
  else for (const value of values) await worker.emit(admitted.claims, value);
}

async function saved(admitted: ClaimedAttempt, turnId: string) {
  const db = required(handle).db;
  const [turn] = await db.select().from(experienceTurn).where(eq(experienceTurn.id, turnId));
  const [execution] = await db
    .select()
    .from(attempt)
    .where(eq(attempt.id, admitted.claims.attempt_id));
  const rows = await db
    .select()
    .from(event)
    .where(eq(event.attemptId, admitted.claims.attempt_id))
    .orderBy(asc(event.seq));
  const words = rows.filter(
    (row) =>
      row.type === 'text_delta' ||
      (row.type === 'notice' && (row.payload as { kind?: string }).kind === 'turn_resumed'),
  );
  return {
    answer: required(turn).answer,
    status: required(turn).status,
    cursor: required(execution).runtimeCursor,
    events: words.map((row) => {
      const {
        attempt_id: _attempt,
        dedup_key: _key,
        turn_id: _turn,
        ...payload
      } = row.payload as Record<string, unknown>;
      return {
        type: row.type,
        payload,
        key: row.dedupKey.slice(admitted.claims.attempt_id.length),
      };
    }),
  };
}

withDb('conversation text recorded together', () => {
  afterAll(async () => {
    for (const worker of runners) await worker.stop();
    await queue?.stop();
    await handle?.close();
  }, 15_000);

  test.each([false, true])(
    'matches single writes, including empty text and stalled=%s',
    async (stalled) => {
      const alone = await conversation('One piece at a time');
      const together = await conversation('Adjacent pieces');
      if (stalled) {
        for (const fixture of [alone, together])
          await required(handle)
            .db.update(experienceTurn)
            .set({ status: 'stalled' })
            .where(eq(experienceTurn.id, fixture.turnId));
      }
      const pieces = ['', 'A clear ', '', 'answer.', ''];
      await write(required(one), alone.admitted, text(alone.admitted, pieces), false);
      await write(required(one), together.admitted, text(together.admitted, pieces), true);
      const before = await saved(alone.admitted, alone.turnId);
      const after = await saved(together.admitted, together.turnId);
      expect(after).toEqual(before);
      expect(after.answer).toBe('A clear answer.');
      expect(after.status).toBe('streaming');
      expect(after.cursor).toBe(4);
      expect(after.events.map((row) => row.type)).toEqual([
        ...(stalled ? ['notice'] : []),
        ...pieces.map(() => 'text_delta'),
      ]);
      if (stalled) expect(after.events[0]?.payload.kind).toBe('turn_resumed');
    },
  );

  test.each(['lost', 'failed'] as const)(
    'keeps the %s attempt answer join after a restart',
    async (ending) => {
      const results = [];
      for (const batch of [false, true]) {
        const fixture = await conversation(`Answer after ${ending}`);
        await write(
          required(one),
          fixture.admitted,
          text(fixture.admitted, ['Earlier partial.']),
          false,
        );
        if (ending === 'lost')
          expect(
            await required(one).loseAttempt(fixture.admitted.claims.attempt_id, 'runtime_crashed'),
          ).toBe(true);
        else
          await required(one).commitOutcome(fixture.admitted.claims, {
            kind: 'failed',
            reason: 'runtime_crashed',
            retryable: true,
          });
        const restarted = runner();
        const admitted = await claim(fixture.jobId, restarted);
        await write(restarted, admitted, text(admitted, ['', 'Fresh ', 'answer.']), batch);
        // A new process answering the same lease sees the first raw piece already
        // recorded, so it appends rather than applying the first-answer join again.
        const reloaded = runner();
        await write(reloaded, admitted, text(admitted, [' More ', 'detail.'], 3), batch);
        results.push(await saved(admitted, fixture.turnId));
      }
      expect(results[1]).toEqual(results[0]);
      expect(results[1]?.answer).toBe(
        `${ending === 'lost' ? '' : 'Earlier partial.\n\n'}Fresh answer. More detail.`,
      );
    },
  );

  test.each([false, true])(
    'a contiguous stream writes each table once with stalled=%s',
    async (stalled) => {
      const fixture = await conversation('Count the writes');
      if (stalled)
        await required(handle)
          .db.update(experienceTurn)
          .set({ status: 'stalled' })
          .where(eq(experienceTurn.id, fixture.turnId));
      const sql = required(handle).sql;
      await sql`create table runtime_text_writes (kind text not null)`;
      await sql`create function count_runtime_text_write() returns trigger language plpgsql as $$
      begin insert into runtime_text_writes(kind) values (TG_ARGV[0]); return null; end $$`;
      try {
        await sql`create trigger runtime_text_insert after insert on event for each statement execute function count_runtime_text_write('event')`;
        await sql`create trigger runtime_text_answer after update of answer on experience_turn for each statement execute function count_runtime_text_write('answer')`;
        await sql`create trigger runtime_text_cursor after update of runtime_cursor on attempt for each statement execute function count_runtime_text_write('cursor')`;
        await write(
          required(one),
          fixture.admitted,
          text(fixture.admitted, ['', 'One ', 'answer', '.', '']),
          true,
        );
        const counts =
          await sql`select kind, count(*)::int as count from runtime_text_writes group by kind order by kind`;
        expect([...counts]).toEqual([
          { kind: 'answer', count: 1 },
          { kind: 'cursor', count: 1 },
          { kind: 'event', count: 1 },
        ]);
        expect((await saved(fixture.admitted, fixture.turnId)).answer).toBe('One answer.');
      } finally {
        await sql`drop trigger if exists runtime_text_insert on event`;
        await sql`drop trigger if exists runtime_text_answer on experience_turn`;
        await sql`drop trigger if exists runtime_text_cursor on attempt`;
        await sql`drop function count_runtime_text_write()`;
        await sql`drop table runtime_text_writes`;
      }
    },
  );

  test('the first answer folds its join history into the write statement', async () => {
    const fixture = await conversation('First answer reads');
    const statements: string[] = [];
    const logged = drizzle(required(handle).sql, {
      schema,
      logger: { logQuery: (statement) => statements.push(statement) },
    });
    const worker = new AttemptRunner(
      new JobService(logged, required(queue).boss),
      new StubRuntimeAdapter(),
      { key: 'text-batch-test-capability-key-at-least-32-bytes' },
    );
    runners.push(worker);
    await write(worker, fixture.admitted, text(fixture.admitted, ['The answer.']), true);
    // Only the runtime fence loader (the job row lock and the attempt read
    // sent with it) and locked authority read separately. Join history,
    // answer, events and cursor share the following CTE.
    const reads = statements.filter(
      (statement) => /^select\b/i.test(statement.trimStart()) && !statement.includes('pg_advisory'),
    );
    expect(reads).toHaveLength(3);
    expect((await saved(fixture.admitted, fixture.turnId)).answer).toBe('The answer.');
  });

  test('duplicate places keep their existing retry behavior and never repeat answer text', async () => {
    const fixture = await conversation('Repeated places');
    const values = text(fixture.admitted, ['First ', 'second.']);
    expect(
      await required(one).emitMany(fixture.admitted.claims, [required(values[0]), ...values]),
    ).toEqual([null, null, null]);
    const result = await saved(fixture.admitted, fixture.turnId);
    expect(result.answer).toBe('First second.');
    expect(result.events.map((row) => row.key)).toEqual([':0', ':1']);
  });

  test('a long contiguous stream retains the event order across insert chunks', async () => {
    const fixture = await conversation('Several insert chunks');
    const pieces = Array.from({ length: 130 }, (_, index) => `${index} `);
    await write(required(one), fixture.admitted, text(fixture.admitted, pieces), true);
    const result = await saved(fixture.admitted, fixture.turnId);
    expect(result.answer).toBe(pieces.join(''));
    expect(result.cursor).toBe(129);
    expect(result.events.map((row) => row.payload.local_seq)).toEqual(
      pieces.map((_, index) => index),
    );
  });

  test('a text batch commits before a later writer can advance a reader cursor', async () => {
    const fixture = await conversation('Commit order');
    const service = required(jobs);
    const original = service.transaction;
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    service.transaction = <T>(operation: (tx: Transaction) => Promise<T>) =>
      original.call(service, async (tx) => {
        const result = await operation(tx);
        entered();
        await held;
        return result;
      }) as Promise<T>;
    let writing: Promise<void> | undefined;
    let later: Promise<unknown> | undefined;
    try {
      writing = write(
        required(one),
        fixture.admitted,
        text(fixture.admitted, ['First ', 'commit.']),
        true,
      );
      await Promise.race([
        ready,
        writing.then(() => {
          throw new Error('Write ended before commit was held');
        }),
      ]);
      let committed = false;
      later = original
        .call(service, async (tx) => {
          await appendEvent(tx, {
            jobId: fixture.jobId,
            epoch: fixture.admitted.claims.epoch,
            type: 'notice',
            payload: { kind: 'later_writer' },
            dedupKey: `${fixture.jobId}:later-writer`,
          });
        })
        .then(() => {
          committed = true;
        });
      const [cursor] = await required(handle)
        .sql`select coalesce(max(seq), 0)::bigint as seq from event`;
      await Bun.sleep(50);
      expect(committed).toBe(false);
      release();
      await Promise.all([writing, later]);
      const rows = await required(handle)
        .db.select()
        .from(event)
        .where(gt(event.seq, Number(cursor?.seq ?? 0)))
        .orderBy(asc(event.seq));
      expect(rows.map((row) => row.type)).toEqual(['text_delta', 'text_delta', 'notice']);
      expect((required(rows.at(-1)).payload as { kind?: string }).kind).toBe('later_writer');
    } finally {
      release();
      service.transaction = original;
      await Promise.allSettled([writing, later]);
    }
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Postgres unavailable');
  return value;
}
