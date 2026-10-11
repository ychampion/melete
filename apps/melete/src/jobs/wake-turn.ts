/**
 * A conversation that wakes by itself speaks in a new message.
 *
 * A reminder set with `job.wait`, or a scheduled occurrence of a conversation's
 * own schedule, once reused the turn that set it up: the reminder replaced the
 * "I'll nudge you" reply in the same bubble, stamped with the time that reply was
 * sent. A wake now opens a turn of its own, created when it fires, with no words
 * from the person, so its answer is a new assistant message at the fire time and
 * the setup reply stays as it was.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { agent, experienceTurn, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import type { JobRow } from './service.ts';

/**
 * Opens the turn a conversation's own wake answers in, once per `key`, and
 * makes it the conversation's current turn. Anything that is not a conversation
 * is returned unchanged. A key already used (a wake delivered twice) keeps the
 * turn it opened the first time.
 */
export async function openWakeTurn(tx: Transaction, row: JobRow, key: string): Promise<JobRow> {
  if (row.kind !== 'chat') return row;
  const submissionId = `wake:${row.id}:${key}`;
  const [already] = await tx
    .select({ id: experienceTurn.id })
    .from(experienceTurn)
    .where(eq(experienceTurn.submissionId, submissionId));
  let turnId = already?.id ?? null;
  if (!turnId) {
    // A conversation with no agent of its own speaks as the space's.
    const [fallback] = row.agentId
      ? []
      : await tx
          .select({ id: agent.id })
          .from(agent)
          .where(
            and(eq(agent.spaceId, row.spaceId), eq(agent.isDefault, true), isNull(agent.deletedAt)),
          );
    const agentId = row.agentId ?? fallback?.id ?? null;
    if (!agentId) return row;
    turnId = newId('turn');
    await tx
      .insert(experienceTurn)
      .values({ id: turnId, jobId: row.id, agentId, submissionId, text: '' });
  }
  await tx.update(job).set({ currentTurnId: turnId }).where(eq(job.id, row.id));
  return { ...row, currentTurnId: turnId };
}
