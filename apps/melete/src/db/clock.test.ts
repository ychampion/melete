import { describe, expect, mock, test } from 'bun:test';
import { databaseNow, rememberDatabaseNow } from './clock.ts';
import type { Transaction } from './transaction.ts';

describe('database transaction clock', () => {
  test('the lock statement can supply the timestamp without a separate clock query', async () => {
    const execute = mock(async () => {
      throw new Error('Unexpected clock query');
    });
    const tx = { execute } as unknown as Transaction;
    rememberDatabaseNow(tx, '2026-10-24T04:00:00.000Z');
    expect((await databaseNow(tx)).toISOString()).toBe('2026-10-24T04:00:00.000Z');
    rememberDatabaseNow(tx, '2026-10-24T05:00:00.000Z');
    expect((await databaseNow(tx)).toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(execute).not.toHaveBeenCalled();
  });
  test('concurrent and later reads share one transaction timestamp', async () => {
    const execute = mock(async () => [{ now: '2026-10-24T04:00:00.000Z' }]);
    const tx = { execute } as unknown as Transaction;
    const [first, second] = await Promise.all([databaseNow(tx), databaseNow(tx)]);
    const third = await databaseNow(tx);
    expect(first.toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(second.getTime()).toBe(first.getTime());
    expect(third.getTime()).toBe(first.getTime());
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test('a later transaction gets its own time, and Dates cannot change the stored clock', async () => {
    const instant = new Date('2026-10-24T04:00:00.000Z');
    const one = { execute: mock(async () => [{ now: instant }]) } as unknown as Transaction;
    const two = {
      execute: mock(async () => [{ now: '2026-10-24T04:00:01.000Z' }]),
    } as unknown as Transaction;
    const first = await databaseNow(one);
    first.setTime(0);
    instant.setTime(1);
    expect((await databaseNow(one)).toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect((await databaseNow(two)).toISOString()).toBe('2026-10-24T04:00:01.000Z');
  });
});
