import type { EventType, JsonObject } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import { event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

export type EventWrite = {
  jobId?: string | null;
  attemptId?: string | null;
  type: EventType;
  payload?: JsonObject;
  dedupKey: string;
};

/** Called inside serviceTransaction; PostgreSQL delivers NOTIFY only after commit. */
export async function appendEvent(tx: Transaction, value: EventWrite) {
  const [row] = await tx
    .insert(event)
    .values({ ...value, payload: value.payload ?? {} })
    .onConflictDoNothing({ target: event.dedupKey })
    .returning();
  if (row) await tx.execute(sql`select pg_notify('melete_events', ${String(row.seq)})`);
  return row;
}
