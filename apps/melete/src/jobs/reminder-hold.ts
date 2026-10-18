/**
 * A conversation's reminder cancelled from another conversation is held, not
 * removed: the conversation keeps resting on its timer, with no wake set, so
 * it never fires, and turning it back on restores the same due time. What is
 * held is recorded as notices on the reminder's own conversation, the latest
 * for a due time deciding, so every path that puts a wait back
 * (`JobService.move`) keeps it held until it is released.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

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
