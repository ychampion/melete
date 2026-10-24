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
  /**
   * The job's lease epoch, when the caller holds the job row and has it;
   * otherwise it is read here.
   */
  epoch?: number | null;
};

/** Called inside serviceTransaction; PostgreSQL delivers NOTIFY only after commit. */
export async function appendEvent(tx: Transaction, value: EventWrite) {
  const [current] =
    value.epoch !== undefined
      ? [{ epoch: value.epoch }]
      : value.jobId
        ? await tx.select({ epoch: job.leaseEpoch }).from(job).where(eq(job.id, value.jobId))
        : [];
  const inserted = tx.$with('added_event').as(
    tx
      .insert(event)
      .values({ ...value, epoch: current?.epoch ?? null, payload: value.payload ?? {} })
      .onConflictDoNothing({ target: event.dedupKey })
      .returning(),
  );
  // Selecting from the inserted row keeps the notification in this statement,
  // skips it on deduplication, and still delivers it only when the writer commits.
  const [written] = await tx
    .with(inserted)
    .select({
      row: {
        seq: inserted.seq,
        jobId: inserted.jobId,
        attemptId: inserted.attemptId,
        type: inserted.type,
        epoch: inserted.epoch,
        payload: inserted.payload,
        dedupKey: inserted.dedupKey,
        createdAt: inserted.createdAt,
      },
      notified: sql`pg_notify('melete_events', ${inserted.seq}::text)`,
    })
    .from(inserted);
  return written?.row;
}
