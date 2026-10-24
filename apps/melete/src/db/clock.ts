import { sql } from 'drizzle-orm';
import type { Transaction } from './transaction.ts';

// Postgres now() is the transaction's start time, even across statements and waits.
const clocks = new WeakMap<Transaction, Promise<number>>();

/** Seed the stable clock from the statement that already acquired the transaction's lock. */
export function rememberDatabaseNow(tx: Transaction, now: Date | string): void {
  if (!clocks.has(tx))
    clocks.set(tx, Promise.resolve(now instanceof Date ? now.getTime() : Date.parse(now)));
}

/** Lease writes and admission share Postgres time with the recovery and wake scans. */
export async function databaseNow(tx: Transaction): Promise<Date> {
  let clock = clocks.get(tx);
  if (!clock) {
    clock = (async () => {
      const [row] = await tx.execute<{ now: Date | string }>(sql`select now() as now`);
      return row?.now instanceof Date ? row.now.getTime() : Date.parse(String(row?.now));
    })();
    clocks.set(tx, clock);
  }
  // Callers may change their Date without changing another read of this transaction's time.
  return new Date(await clock);
}
