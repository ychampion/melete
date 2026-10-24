/**
 * The event order lock serialises every event writer, so what runs while it is
 * held decides whether one conversation's work pauses everyone else's. Real
 * Postgres.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { appendEvent as appendBrokerEvent, lockJob } from '../../src/broker/records.ts';
import { openDatabase } from '../../src/db/client.ts';
import { job, space } from '../../src/db/schema.ts';
import { lockEventOrderIn, serviceTransaction } from '../../src/db/transaction.ts';
import { appendEvent } from '../../src/events/store.ts';
import { newId } from '../../src/ids.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const suite = database ? describe : describe.skip;

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withGuard<T>(mode: string | undefined, work: () => Promise<T>): Promise<T> {
  const previous = process.env.MELETE_EVENT_LOCK_GUARD;
  if (mode === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
  else process.env.MELETE_EVENT_LOCK_GUARD = mode;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.MELETE_EVENT_LOCK_GUARD;
    else process.env.MELETE_EVENT_LOCK_GUARD = previous;
  }
}

suite('event order lock', () => {
  const { sql, db, url } = database ?? ({} as NonNullable<typeof database>);
  afterAll(async () => {
    await database?.close();
  });

  async function fixtureJob() {
    const spaceId = newId('sp');
    const id = newId('job');
    await db
      .insert(space)
      .values({ id: spaceId, name: 'Lock order', gitPath: `/spaces/${spaceId}` });
    await db
      .insert(job)
      .values({ id, spaceId, title: 'Lock order', objective: 'Keep events ordered.' });
    return { id, spaceId };
  }

  async function advisoryWaiter(pid: number) {
    const until = performance.now() + 5_000;
    do {
      const [row] = await sql`select wait_event from pg_stat_activity where pid = ${pid}`;
      if (row?.wait_event === 'advisory') return;
      await Bun.sleep(10);
    } while (performance.now() < until);
    throw new Error('The writer did not wait for the event order lock.');
  }

  test('a broker waiter takes no job row lock before the event order lock', async () => {
    const { id } = await fixtureJob();
    const acquired = gate();
    const release = gate();
    const holder = sql.begin(async (tx) => {
      await lockEventOrderIn(tx);
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const started = gate<number>();
    const waiting = sql.begin(async (tx) => {
      const [row] = await tx`select pg_backend_pid() as pid`;
      started.resolve(Number(row?.pid));
      return lockJob(tx, id);
    });
    try {
      await advisoryWaiter(await started.promise);
      // A row-first waiter would hold this row while waiting for the advisory
      // lock, reversing every other writer's lock order.
      await sql.begin(async (tx) => {
        const [row] = await tx`select id from job where id = ${id} for update nowait`;
        expect(row?.id).toBe(id);
      });
    } finally {
      release.resolve();
      await holder;
      expect((await waiting).id).toBe(id);
    }
  });

  test('a broker waiter sees a job committed while it waited for event order', async () => {
    const { spaceId } = await fixtureJob();
    const id = newId('job');
    const acquired = gate();
    const insert = gate();
    const holder = sql.begin(async (tx) => {
      await lockEventOrderIn(tx);
      acquired.resolve();
      await insert.promise;
      await tx`insert into job (id, space_id, title, objective)
        values (${id}, ${spaceId}, 'Committed while waiting', 'Keep events ordered.')`;
    });
    await acquired.promise;
    const started = gate<number>();
    const waiting = sql.begin(async (tx) => {
      const [row] = await tx`select pg_backend_pid() as pid`;
      started.resolve(Number(row?.pid));
      return lockJob(tx, id);
    });
    try {
      await advisoryWaiter(await started.promise);
    } finally {
      insert.resolve();
      await holder;
    }
    // A read in the advisory-lock statement would retain the snapshot taken
    // before the wait, when this job did not exist yet.
    expect((await waiting).id).toBe(id);
  });

  test('a broker event commits before any later sequence becomes visible', async () => {
    const { id } = await fixtureJob();
    const written = gate<number>();
    const release = gate();
    const firstKey = `${id}:first`;
    const secondKey = `${id}:second`;
    const first = sql.begin(async (tx) => {
      await lockJob(tx, id);
      await appendBrokerEvent(tx, id, null, 'notice', { text: 'First' }, firstKey);
      const [row] = await tx`select seq from event where dedup_key = ${firstKey}`;
      written.resolve(Number(row?.seq));
      await release.promise;
    });
    const firstSeq = await written.promise;
    let secondCommitted = false;
    const second = serviceTransaction(db, (tx) =>
      appendEvent(tx, {
        jobId: id,
        type: 'notice',
        payload: { text: 'Second' },
        dedupKey: secondKey,
      }),
    ).then((row) => {
      secondCommitted = true;
      return row;
    });
    try {
      await Bun.sleep(100);
      const visible = await sql`select seq from event where job_id = ${id}`;
      expect(visible).toHaveLength(0);
      expect(secondCommitted).toBe(false);
    } finally {
      release.resolve();
      await first;
    }
    const later = await second;
    expect(Number(later?.seq)).toBeGreaterThan(firstSeq);
    const visible = await sql`select seq from event where job_id = ${id} order by seq`;
    expect(visible.map((row) => Number(row.seq))).toEqual([firstSeq, Number(later?.seq)]);
    // A reader past the later commit has already seen every earlier commit.
    expect(
      await sql`select seq from event where job_id = ${id} and seq > ${Number(later?.seq)}`,
    ).toHaveLength(0);
  });

  test('a holder that sends a statement to the pool is refused under the guard', () =>
    withGuard('throw', async () => {
      await expect(
        sql.begin(async (tx) => {
          await lockEventOrderIn(tx);
          await sql`select 1`;
        }),
      ).rejects.toThrow(/event order lock: a query went to the pool/);
      // Drizzle reports the refusal as the cause of its own query error.
      const refused = await serviceTransaction(db, async () => {
        await db.execute('select 1');
      }).catch((error: { cause?: unknown }) => String(error.cause ?? error));
      expect(refused).toMatch(/event order lock: a query went to the pool/);
      // The transaction's own connection, and the pool before and after it, are fine.
      await sql`select 1`;
      await sql.begin(async (tx) => {
        await lockEventOrderIn(tx);
        await tx`select 1`;
      });
      await sql`select 1`;
    }));

  test(
    "one conversation's stray read while it holds the lock does not pause everyone else",
    () =>
      withGuard(undefined, async () => {
        // A small pool, so the writers waiting on the lock hold every connection of it.
        const small = openDatabase(url, 3);
        try {
          let release!: () => void;
          const queued = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = performance.now();
          const holder = small.sql.begin(async (tx) => {
            await lockEventOrderIn(tx);
            await queued;
            // Slow work's lookup on the pool, while the lock is held.
            const [row] = await small.sql`select 1 as one`;
            return row?.one;
          });
          // Other conversations' event writes queue on the lock, one connection each.
          await Bun.sleep(100);
          const writers = [1, 2].map(() =>
            small.sql.begin(async (tx) => {
              await lockEventOrderIn(tx);
              return performance.now();
            }),
          );
          await Bun.sleep(300);
          release();
          expect(await holder).toBe(1);
          const written = await Promise.all(writers);
          // Without connections kept apart, the holder waits for the writers to
          // give up on the lock (30 s) and every one of them fails.
          for (const at of written) expect(at - started).toBeLessThan(10_000);
          expect(performance.now() - started).toBeLessThan(10_000);
        } finally {
          await small.close();
        }
      }),
    40_000,
  );

  test(
    'a read on the reading connections is answered while writers fill the pool waiting on the lock',
    () =>
      withGuard(undefined, async () => {
        // Two connections of its own and one kept for reads.
        const small = openDatabase(url, 2, undefined, 1);
        try {
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          // Someone else holds the event order lock for a while.
          const holder = sql.begin(async (tx) => {
            await lockEventOrderIn(tx);
            await held;
          });
          await Bun.sleep(100);
          // Writers queue on it, one pool connection each, until the pool is full.
          const writers = [1, 2].map(() =>
            small.sql.begin(async (tx) => {
              await lockEventOrderIn(tx);
            }),
          );
          await Bun.sleep(200);
          const started = performance.now();
          const [row] = await small.reader.execute<{ one: number }>('select 1 as one');
          expect(Number(row?.one)).toBe(1);
          // A read on the pool itself waits for a writer to finish; this one did not.
          expect(performance.now() - started).toBeLessThan(2_000);
          release();
          await holder;
          await Promise.all(writers);
        } finally {
          await small.close();
        }
      }),
    40_000,
  );

  test('without reading connections the reader is the pool itself', async () => {
    const shared = openDatabase(url, 2);
    try {
      expect(shared.reader).toBe(shared.db);
    } finally {
      await shared.close();
    }
  });
});
