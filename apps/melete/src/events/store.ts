import type { JsonObject, ResponsibilityEvent } from '@melete/contracts';
import { eq, sql } from 'drizzle-orm';
import { event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

export type EventWrite = {
  jobId?: string | null;
  attemptId?: string | null;
  type: ResponsibilityEvent['type'];
  payload?: JsonObject;
  dedupKey: string;
};

/** Called inside serviceTransaction; PostgreSQL delivers NOTIFY only after commit. */
export async function appendEvent(tx: Transaction, value: EventWrite) {
  const [current] = value.jobId
    ? await tx.select({ epoch: job.leaseEpoch }).from(job).where(eq(job.id, value.jobId))
    : [];
  const [row] = await tx
    .insert(event)
    .values({ ...value, epoch: current?.epoch ?? null, payload: value.payload ?? {} })
    .onConflictDoNothing({ target: event.dedupKey })
    .returning();
  if (row) await tx.execute(sql`select pg_notify('melete_events', ${String(row.seq)})`);
  return row;
}
