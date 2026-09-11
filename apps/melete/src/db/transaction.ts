import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Shared by the Drizzle service and postgres.js broker before either locks a job. */
export const EVENT_ORDER_LOCK = 31003103;

/**
 * Event sequence order must also be commit order or SSE can skip a slow commit.
 * This short transaction lock precedes every job lock; attempts run outside it.
 */
export function serviceTransaction<T>(
  db: Database,
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`);
    return operation(tx);
  });
}
