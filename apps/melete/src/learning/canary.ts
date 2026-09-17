/**
 * An owner who corrects a job a canary procedure was delivered to has told us the
 * procedure did not do its job. The canary ends in the same transaction that
 * records the correction, whether it was enabled by evaluation or by the owner's
 * own trial, so no later job receives it. One clean canary job is not enough to
 * outweigh a correction.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { procedureCandidate, procedureTransition } from './schema.ts';

export const CANARY_INTERVENTION = 'canary_intervention';

export async function revertDeliveredCanaries(tx: Transaction, row: JobRow, episodeId: string) {
  const delivered = await tx.execute(sql`
    select distinct substr(skill->>'name', 11) as id
    from learning_attempt captured
    join attempt on attempt.id = captured.attempt_id,
    jsonb_array_elements(captured.versions->'skills') skill
    where attempt.job_id = ${row.id} and skill->>'name' like 'procedure:%'`);
  const ids = delivered.map((entry) => String(entry.id));
  if (!ids.length) return [];
  const canaries = await tx
    .select()
    .from(procedureCandidate)
    .where(
      and(
        inArray(procedureCandidate.id, ids),
        eq(procedureCandidate.state, 'enabled_canary'),
        eq(procedureCandidate.canarySpaceId, row.spaceId),
      ),
    )
    .for('update');
  const reverted = [];
  for (const candidate of canaries) {
    await tx.insert(procedureTransition).values({
      id: newId('pt'),
      candidateId: candidate.id,
      fromState: candidate.state,
      toState: 'reverted',
      actor: 'canary-monitor',
      reason: `Owner intervened on a canary job: ${episodeId}`,
    });
    const [saved] = await tx
      .update(procedureCandidate)
      .set({
        state: 'reverted',
        rejectionReason: CANARY_INTERVENTION,
        version: candidate.version + 1,
      })
      .where(
        and(
          eq(procedureCandidate.id, candidate.id),
          eq(procedureCandidate.version, candidate.version),
        ),
      )
      .returning();
    if (saved) reverted.push(saved);
  }
  return reverted;
}
