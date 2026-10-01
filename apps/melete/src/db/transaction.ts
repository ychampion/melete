import { sql } from 'drizzle-orm';
import type { TransactionSql } from 'postgres';
import type { Database } from './client.ts';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Shared by the Drizzle service and postgres.js broker before either locks a job. */
export const EVENT_ORDER_LOCK = 31003103;

/**
 * How long a transaction that takes the event order lock waits for any lock,
 * this one included. Every event writer queues on this lock, so a holder that
 * stops making progress would otherwise hold the whole service: the waiters
 * give up instead, return their connections to the pool and report it. A
 * healthy holder keeps the lock for milliseconds, so thirty seconds of waiting
 * means something is stuck, not busy. It stays set for the rest of the
 * transaction: a lock holder that waits that long on a row stalls every writer.
 */
export const EVENT_ORDER_LOCK_TIMEOUT = '30s';

/**
 * Say why a locked transaction failed when a limit ended it: Postgres reports
 * `lock_not_available` when `lock_timeout` ends a wait, and
 * `idle_in_transaction_session_timeout` (see `db/client.ts`) when it ended a
 * session that held a transaction open and did nothing.
 */
function reportLimit(error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '55P03')
    console.error(
      `event order lock: gave up after waiting ${EVENT_ORDER_LOCK_TIMEOUT}; a transaction holding it is stuck`,
    );
  else if (code === '25P03')
    console.error(
      'event order lock: Postgres ended a transaction that sat idle while open; it was rolled back',
    );
}

/**
 * Take the event order lock in a postgres.js transaction. The wait limit and
 * the lock are one statement: the limit is the subquery's output and the
 * filter reads it, so it is in force before the lock is requested.
 */
export async function lockEventOrderIn(tx: TransactionSql): Promise<void> {
  try {
    await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})
      from (select set_config('lock_timeout', ${EVENT_ORDER_LOCK_TIMEOUT}, true) as timeout) limits
      where limits.timeout is not null`;
  } catch (error) {
    reportLimit(error);
    throw error;
  }
}

/**
 * Event sequence order must also be commit order or SSE can skip a slow commit.
 * This short transaction lock precedes every job lock; attempts run outside it.
 *
 * Nothing inside `operation` may wait on another pool connection (a query on
 * the pool's `sql` or `db`, or a service that uses them): every other
 * connection can be queued on this lock, so that wait would never end. Read
 * what is needed before the transaction, or after it commits.
 */
export function serviceTransaction<T>(
  db: Database,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db
    .transaction(async (tx) => {
      // The same statement as `lockEventOrderIn`, in Drizzle form.
      await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})
        from (select set_config('lock_timeout', ${EVENT_ORDER_LOCK_TIMEOUT}, true) as timeout) limits
        where limits.timeout is not null`);
      return operation(tx);
    })
    .catch((error: unknown) => {
      reportLimit(error);
      throw error;
    });
}
