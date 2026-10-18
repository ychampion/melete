import { and, desc, eq, lt } from 'drizzle-orm';
import { attempt } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';

/**
 * How an attempt's first answer text joins what an earlier attempt of the same
 * turn already said.
 *
 * - `replace`: every earlier attempt of the turn was fenced, its context
 *   revoked or its lease taken over, and this one runs the turn again without
 *   being told what they said, so their partial answer is replaced, never
 *   glued to the new one.
 * - `separate`: an earlier attempt ended on purpose (it answered, asked, or
 *   waited for an approval or a time), or failed after saying something the
 *   person already has. Its words stay, and so do those of any attempt fenced
 *   after it: only a fenced attempt's own words are ever taken back, never an
 *   answer that came before it. This one starts a new paragraph.
 * - `none`: this is the turn's first attempt, or not a conversation turn.
 */
export type AnswerJoin = 'replace' | 'separate' | 'none';

/**
 * Outcomes after which the next attempt of the turn carries on from an answer
 * the person already has, and is shown it (`said_this_turn`). An attempt that
 * waited for an approval or an event ends on words its continuation's own
 * answer takes the place of.
 */
export const CARRIES_ON = new Set(['completed', 'failed']);

/** The outcomes of the turn's attempts before this one, newest first; null outside a turn. */
async function earlierOutcomes(tx: Transaction, attemptId: string): Promise<string[] | null> {
  const [current] = await tx
    .select({ jobId: attempt.jobId, turnId: attempt.turnId, epoch: attempt.epoch })
    .from(attempt)
    .where(eq(attempt.id, attemptId));
  if (!current?.turnId) return null;
  const rows = await tx
    .select({ outcome: attempt.outcome })
    .from(attempt)
    .where(
      and(
        eq(attempt.jobId, current.jobId),
        eq(attempt.turnId, current.turnId),
        lt(attempt.epoch, current.epoch),
      ),
    )
    .orderBy(desc(attempt.epoch));
  // An earlier attempt still open when this one was claimed was fenced by it.
  return rows.map((row) => row.outcome ?? 'fenced');
}

export async function answerJoin(tx: Transaction, attemptId: string): Promise<AnswerJoin> {
  const earlier = await earlierOutcomes(tx, attemptId);
  if (!earlier?.length) return 'none';
  return earlier.every((outcome) => outcome === 'fenced') ? 'replace' : 'separate';
}

/**
 * Whether this attempt carries on from an answer already in: the newest
 * earlier attempt of its turn that was not fenced answered, or failed after
 * saying something. It was shown those words (`said_this_turn`), so what it
 * writes goes after them.
 */
export async function carriesOnAnswer(tx: Transaction, attemptId: string): Promise<boolean> {
  const kept = (await earlierOutcomes(tx, attemptId))?.find((outcome) => outcome !== 'fenced');
  return kept !== undefined && CARRIES_ON.has(kept);
}
