/**
 * A conversation's reminder cancelled from another conversation is held, not
 * removed: it keeps its due time and never fires, and turning it back on
 * restores that time. What is held is recorded as notices on the reminder's
 * own conversation, the latest for a due time deciding.
 *
 * A hold is honoured only where the held wait is put back by itself: the end
 * of a turn that had it set aside (`AttemptRunner.restorableWait`, then
 * `JobService.move` with `restoring`). A conversation resting on it when it
 * was cancelled is left with no wake. A wait chosen afresh with job.wait, for
 * the same time or another, releases the hold: the person asked for it again.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';

export const REMINDER_HELD = 'reminder_held';
export const REMINDER_RELEASED = 'reminder_released';
/** The receipt in the conversation the change was made from. */
export const REMINDER_RECEIPT = 'reminder_receipt';
/** Notice kinds whose `note` the conversation shows as a line of its own. */
export const REMINDER_NOTES: readonly string[] = [
  REMINDER_HELD,
  REMINDER_RELEASED,
  REMINDER_RECEIPT,
];

/** Whether the reminder due at `wakeAt` on this conversation is held. */
export async function reminderHeld(
  tx: Transaction,
  jobId: string,
  wakeAt: string,
): Promise<boolean> {
  const [latest] = await tx
    .select({ kind: sql<string>`${event.payload}->>'kind'` })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        eq(event.type, 'notice'),
        inArray(sql`${event.payload}->>'kind'`, [REMINDER_HELD, REMINDER_RELEASED]),
        sql`(${event.payload}->>'wake_at')::timestamptz = ${wakeAt}::timestamptz`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  return latest?.kind === REMINDER_HELD;
}

/**
 * Releases the hold on the reminder due at `wakeAt`. With a `note`, the
 * conversation shows it as a line of its own; without one nothing is said,
 * as when a job.wait set the time again and its own reply says so.
 */
export async function releaseReminder(
  tx: Transaction,
  jobId: string,
  wakeAt: string,
  attemptId: string | null,
  note?: string,
): Promise<void> {
  await appendEvent(tx, {
    jobId,
    attemptId,
    type: 'notice',
    payload: { kind: REMINDER_RELEASED, wake_at: wakeAt, ...(note ? { note } : {}) },
    dedupKey: `${jobId}:reminder-released:${newId('op')}`,
  });
}
