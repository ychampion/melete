import { and, desc, eq, lt } from 'drizzle-orm';
import { attempt } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

/**
 * How an attempt's first answer text joins what an earlier attempt of the same
 * turn already said.
 *
 * - `replace`: the earlier attempt was lost or failed and this one runs the
 *   turn again, so its partial answer is replaced, never glued to the new one.
 * - `separate`: the earlier attempt ended on purpose (it asked, or waited for
 *   an approval or a time) and this one carries on, so the two read as two
 *   paragraphs.
 * - `none`: this is the turn's first attempt, or not a conversation turn.
 */
export type AnswerJoin = 'replace' | 'separate' | 'none';

/** Outcomes after which the next attempt of the turn starts the work over. */
const RETRIED = new Set(['fenced', 'failed']);

export async function answerJoin(tx: Transaction, attemptId: string): Promise<AnswerJoin> {
  const [current] = await tx
    .select({ jobId: attempt.jobId, turnId: attempt.turnId, epoch: attempt.epoch })
    .from(attempt)
    .where(eq(attempt.id, attemptId));
  if (!current?.turnId) return 'none';
  const [previous] = await tx
    .select({ outcome: attempt.outcome })
    .from(attempt)
    .where(
      and(
        eq(attempt.jobId, current.jobId),
        eq(attempt.turnId, current.turnId),
        lt(attempt.epoch, current.epoch),
      ),
    )
    .orderBy(desc(attempt.epoch))
    .limit(1);
  if (!previous) return 'none';
  return RETRIED.has(previous.outcome ?? '') ? 'replace' : 'separate';
}
