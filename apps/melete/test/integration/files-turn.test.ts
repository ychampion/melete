/**
 * A turn in a space's Files is one at a time across every instance on the
 * database, and turns in many spaces at once never use up a pool between
 * them: each turn reads through the transaction that holds it.
 */
import { afterAll, expect, test } from 'bun:test';
import { recordId } from '../../src/broker/records.ts';
import { filesHold, inFilesTurn } from '../../src/connectors/shared-files.ts';
import { openDatabase } from '../../src/db/client.ts';
import { testDatabase } from '../helpers/database.ts';

const fixture = await testDatabase();
const databaseTest = fixture ? test : test.skip;
const pools: ReturnType<typeof openDatabase>[] = [];

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.close()));
  await fixture?.close();
}, 30_000);

/** A pool of its own, as another instance of the service has. */
const instance = (max: number) => {
  if (!fixture) throw new Error('Postgres fixture unavailable');
  const pool = openDatabase(fixture.url, max);
  pools.push(pool);
  return pool;
};

databaseTest('the database alone keeps turns in one space from two pools apart', async () => {
  const spaceId = recordId('sp');
  const holds = [filesHold(instance(3).sql), filesHold(instance(3).sql)];
  let inside = 0;
  let most = 0;
  const order: number[] = [];
  // Straight to each pool's hold, past this process's own queue: only the
  // database lock stands between them, as between two instances.
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (holds[index % 2] ?? filesHold(null))(spaceId, async (query) => {
        inside += 1;
        most = Math.max(most, inside);
        // A read through the turn's own transaction, as a step's rule check does.
        if (!query) throw new Error('the turn was not held in the database');
        await query`select 1`;
        await Bun.sleep(20);
        order.push(index);
        inside -= 1;
      }),
    ),
  );
  expect(order).toHaveLength(8);
  expect(most).toBe(1);
});

databaseTest('turns in one space queue in this process before the database', async () => {
  const spaceId = recordId('sp');
  const hold = filesHold(instance(2).sql);
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      inFilesTurn(
        spaceId,
        async () => {
          inside += 1;
          most = Math.max(most, inside);
          await Bun.sleep(10);
          inside -= 1;
        },
        hold,
      ),
    ),
  );
  expect(most).toBe(1);
});

databaseTest('turns in other spaces go on at once', async () => {
  const hold = filesHold(instance(4).sql);
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      inFilesTurn(
        recordId('sp'),
        async () => {
          inside += 1;
          most = Math.max(most, inside);
          await Bun.sleep(100);
          inside -= 1;
        },
        hold,
      ),
    ),
  );
  expect(most).toBe(3);
});

databaseTest(
  'turns in more spaces than the pool has connections all finish',
  async () => {
    // Two connections, twelve spaces: each turn holds one connection and reads
    // only through it, so the others wait for the pool rather than for it.
    const hold = filesHold(instance(2).sql);
    const done = await Promise.all(
      Array.from({ length: 12 }, () =>
        inFilesTurn(
          recordId('sp'),
          async (query) => {
            if (!query) throw new Error('the turn was not held in the database');
            const [row] = await query`select 1 as one`;
            await Bun.sleep(10);
            return row?.one;
          },
          hold,
        ),
      ),
    );
    expect(done).toEqual(Array(12).fill(1));
  },
  15_000,
);

databaseTest('a turn that fails lets the next one in, on this instance and the other', async () => {
  const spaceId = recordId('sp');
  const here = filesHold(instance(2).sql);
  const there = filesHold(instance(2).sql);
  await expect(
    inFilesTurn(
      spaceId,
      async () => {
        throw new Error('the file step failed');
      },
      here,
    ),
  ).rejects.toThrow('the file step failed');
  expect(await inFilesTurn(spaceId, async () => 'next here', here)).toBe('next here');
  expect(await inFilesTurn(spaceId, async () => 'next there', there)).toBe('next there');
});
