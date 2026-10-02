import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { Leases } from './leader.ts';

/** A connection whose statements never answer, as one cut off without a word. */
function silent() {
  const opened = { pools: 0, ended: 0 };
  const connect = () => {
    opened.pools += 1;
    const sql = Object.assign(() => new Promise(() => {}), {
      end: async () => {
        opened.ended += 1;
      },
    });
    return sql as unknown as Sql;
  };
  return { opened, connect };
}

test('a lease check the database never answers counts as lost, and the next uses a fresh connection', async () => {
  const { opened, connect } = silent();
  const leases = new Leases(connect, () => {}, 50);
  expect(await leases.leads('sandbox')).toBe(false);
  expect(opened).toEqual({ pools: 1, ended: 1 });
  expect(await leases.leads('sandbox')).toBe(false);
  expect(opened.pools).toBe(2);
  // Closing never waits on a connection that does not answer.
  const started = Date.now();
  await leases.close();
  expect(Date.now() - started).toBeLessThan(1000);
});
