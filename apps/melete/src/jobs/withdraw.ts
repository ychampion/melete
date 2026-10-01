/**
 * Taking back permissions nobody can answer any more. Each is decided as
 * denied with a note that says why, and its action is denied with it, in the
 * transaction that made it stale, so it can never be allowed afterwards and
 * the conversation's stream closes its card with the reason.
 */
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { action, approval, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';

/** The note on a permission withdrawn because the job it waited in ended. */
export const ENDED_NOTE = 'ended';

/** The note on a permission withdrawn because a fact it was asked on changed. */
export const OUTDATED_NOTE = 'outdated';

/** Job states after which none of the job's actions can run, so none can be approved. */
export const ENDED_STATES: readonly string[] = ['cancelled', 'failed', 'completed'];

/** Withdraw every permission still waiting on an action that `which` selects. */
export async function withdrawPermissions(tx: Transaction, which: SQL | undefined, note: string) {
  const pending = await tx
    .select({ approval, action })
    .from(approval)
    .innerJoin(action, eq(action.id, approval.actionId))
    .innerJoin(job, eq(job.id, action.jobId))
    .where(and(isNull(approval.decision), eq(action.status, 'needs_approval'), which))
    .for('update', { of: [approval, action] });
  for (const { approval: stale, action: effect } of pending) {
    await tx
      .update(approval)
      .set({ decision: 'denied', decidedAt: new Date(), decidedBy: note })
      .where(eq(approval.id, stale.id));
    await tx.update(action).set({ status: 'denied' }).where(eq(action.id, effect.id));
    // The same record the broker keeps for every status an action moves through.
    await appendEvent(tx, {
      jobId: effect.jobId,
      attemptId: effect.attemptId,
      type: 'action_status_changed',
      payload: { action_id: effect.id, from: effect.status, to: 'denied' },
      dedupKey: `${stale.id}:${note}:status`,
    });
    await appendEvent(tx, {
      jobId: effect.jobId,
      attemptId: effect.attemptId,
      type: 'approval_decided',
      payload: {
        approval_id: stale.id,
        action_id: effect.id,
        decision: 'denied',
        note,
        payload_hash: effect.payloadHash,
      },
      dedupKey: `${stale.id}:decision`,
    });
  }
  return pending.length;
}

/**
 * A job that ended (failed, cancelled, completed) can no longer carry out any
 * of its actions, so what it was waiting on is withdrawn when it ends: a
 * permission it leaves behind would sit on Home and refuse both Allow and Deny.
 */
export function withdrawEndedJobPermissions(tx: Transaction, jobId: string) {
  return withdrawPermissions(tx, eq(action.jobId, jobId), ENDED_NOTE);
}

/** Every permission in this conversation, or the command jobs it started. */
export const inConversation = (conversationId: string) =>
  or(eq(job.id, conversationId), eq(job.experienceParentId, conversationId));
