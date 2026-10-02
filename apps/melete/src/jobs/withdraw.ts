/**
 * Taking back permissions nobody can answer any more. Each is decided as
 * denied with a note that says why, and its action is denied with it, in the
 * transaction that made it stale, so it can never be allowed afterwards and
 * the conversation's stream closes its card with the reason.
 */
import { APPROVAL_OUTDATED_NOTE } from '@melete/contracts';
import { and, eq, isNull, ne, or, type SQL } from 'drizzle-orm';
import { action, approval, job, question } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';

/** The note on a permission withdrawn because the job it waited in ended. */
export const ENDED_NOTE = 'ended';

/**
 * The note on a permission withdrawn because what it was asked on changed: a
 * fact it rested on, or the job's revision moved on before anyone answered.
 */
export const OUTDATED_NOTE = APPROVAL_OUTDATED_NOTE;

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

/**
 * Take back the job's open question: nobody can usefully answer it once the job
 * ended or its turn was stopped. The conversation's card closes with it. A
 * question about an effect whose outcome is unknown ("did it arrive?") stays:
 * stopping the work does not settle what already left, so it waits for the
 * person whatever happens to the job.
 */
export async function withdrawOpenQuestion(tx: Transaction, jobId: string, reason: string) {
  const [closed] = await tx
    .update(question)
    .set({ state: 'withdrawn', answer: null, answerSubmissionId: null, answeredAt: new Date() })
    .where(
      and(
        eq(question.jobId, jobId),
        eq(question.state, 'open'),
        eq(question.blocksExternalEffect, false),
      ),
    )
    .returning();
  if (!closed) return;
  await appendEvent(tx, {
    jobId,
    type: 'notice',
    payload: {
      kind: 'question_closed',
      question_id: closed.id,
      state: closed.state,
      reason,
      submission_id: null,
    },
    dedupKey: `${closed.id}:closed`,
  });
}

/** Every permission in this conversation, or the command jobs it started. */
export const inConversation = (conversationId: string) =>
  or(eq(job.id, conversationId), eq(job.experienceParentId, conversationId));

/**
 * Withdraw the unanswered permissions of a job that can no longer be allowed:
 * the job's revision moved on before anyone answered (a correction, or a fact
 * the work rested on changed), or the action they asked about has already
 * ended. Left open they would sit in every list and refuse both Allow and
 * Deny. Each is withdrawn as outdated, the same way a memory correction
 * withdraws one, so the next attempt is told nothing was refused and asks
 * again with the current details if the work still needs it.
 */
export async function withdrawOutdatedPermissions(tx: Transaction, jobId: string) {
  const moved = await withdrawPermissions(
    tx,
    and(eq(action.jobId, jobId), ne(approval.jobRevision, job.revision)),
    OUTDATED_NOTE,
  );
  // An approval whose action already ended (fenced before this was so) has
  // only the question itself to close.
  const ended = await tx
    .select({ approval, action })
    .from(approval)
    .innerJoin(action, eq(action.id, approval.actionId))
    .where(
      and(eq(action.jobId, jobId), isNull(approval.decision), ne(action.status, 'needs_approval')),
    )
    .for('update', { of: [approval, action] });
  for (const { approval: stale, action: effect } of ended) {
    await tx
      .update(approval)
      .set({ decision: 'denied', decidedAt: new Date(), decidedBy: OUTDATED_NOTE })
      .where(eq(approval.id, stale.id));
    await appendEvent(tx, {
      jobId: effect.jobId,
      attemptId: effect.attemptId,
      type: 'approval_decided',
      payload: {
        approval_id: stale.id,
        action_id: effect.id,
        decision: 'denied',
        note: OUTDATED_NOTE,
        payload_hash: effect.payloadHash,
      },
      dedupKey: `${stale.id}:decision`,
    });
  }
  return moved + ended.length;
}
