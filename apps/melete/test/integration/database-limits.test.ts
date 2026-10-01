/**
 * The pool's limits on a stuck transaction: Postgres ends a session left idle
 * in a transaction, and the service says so when it happens.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { openDatabase } from '../../src/db/client.ts';
import { testDatabase } from '../helpers/database.ts';

const handle = await testDatabase();
const withDb = handle ? describe : describe.skip;

withDb('a transaction left idle', () => {
  afterAll(async () => {
    await handle?.close();
  });

  test('is ended by Postgres, rolled back, and reported', async () => {
    if (!handle) throw new Error('Postgres unavailable');
    const pool = openDatabase(handle.url, 2, 200);
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await pool.sql
        .begin(async (tx) => {
          await tx`select 1`;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await tx`select 1`;
          return 'committed';
        })
        .catch((error: unknown) => (error as { code?: string }).code);
      expect(outcome).toBe('CONNECTION_CLOSED');
      expect(logged.mock.calls.flat().join('\n')).toContain('lost its connection');
      // The pool goes on with a fresh connection.
      expect((await pool.sql`select 1 as one`)[0]?.one).toBe(1);
      // A Drizzle transaction begins in the same place, so it is reported too.
      logged.mockClear();
      const drizzled = await pool.db
        .transaction(async (tx) => {
          await tx.execute('select 1');
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          await tx.execute('select 1');
        })
        .catch((error: unknown) => (error as { code?: string }).code);
      expect(drizzled).toBe('CONNECTION_CLOSED');
      expect(logged.mock.calls.flat().join('\n')).toContain('lost its connection');
    } finally {
      logged.mockRestore();
      await pool.close();
    }
  }, 30_000);
});
