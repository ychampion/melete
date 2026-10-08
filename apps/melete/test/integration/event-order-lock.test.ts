/**
 * The event order lock serialises every event writer, so what runs while it is
 * held decides whether one conversation's work pauses everyone else's. Real
 * Postgres.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { openDatabase } from '../../src/db/client.ts';
import { lockEventOrderIn, serviceTransaction } from '../../src/db/transaction.ts';
import { testDatabase } from '../helpers/database.ts';

const database = await testDatabase();
const suite = database ? describe : describe.skip;

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
});
