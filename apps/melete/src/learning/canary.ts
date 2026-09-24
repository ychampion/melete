/**
 * An owner who corrects a job a canary procedure was delivered to has told us the
 * procedure did not do its job. The canary ends in the same transaction that
 * records the correction, whether it was enabled by evaluation or by the owner's
 * own trial, so no later job receives it. One clean canary job is not enough to
 * outweigh a correction. A procedure the owner kept by answering "yes" to its
 * trial is active on their word alone, so it stays under the same watch.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { ENGINE_ORIGIN } from './engine-scan.ts';
import { digest } from './episodes.ts';
import { noticeReverted } from './notices.ts';
import { procedureCandidate, procedureTransition } from './schema.ts';

export const CANARY_INTERVENTION = 'canary_intervention';

export async function revertDeliveredCanaries(tx: Transaction, row: JobRow, episodeId: string) {
  const delivered = await tx.execute(sql`
    select distinct skill->>'name' as name, skill->>'version' as version
    from learning_attempt captured
    join attempt on attempt.id = captured.attempt_id,
    jsonb_array_elements(captured.versions->'skills') skill
    where attempt.job_id = ${row.id}`);
  const names = delivered.map((entry) => String(entry.name));
  // The bytes, not just the name: a catalog skill that happens to share a name with
  // an engine-written one is a different thing and is not reverted for it.
  const versions = new Set(delivered.map((entry) => String(entry.version)));
  // A learned procedure is delivered under its id; a skill the engine wrote for itself
  // under its own name. An intervention ends either one.
  const ids = names.filter((name) => name.startsWith('procedure:')).map((name) => name.slice(10));
  const written = names.filter((name) => !name.startsWith('procedure:'));
  if (!ids.length && !written.length) return [];
  const canaries = await tx
    .select()
    .from(procedureCandidate)
    .where(
      and(
        or(
          ids.length ? inArray(procedureCandidate.id, ids) : undefined,
          written.length
            ? and(
                eq(procedureCandidate.origin, ENGINE_ORIGIN),
                inArray(procedureCandidate.skillName, written),
              )
            : undefined,
        ),
        // What a person kept on their own word stays under the same watch as their trial.
        or(
          eq(procedureCandidate.state, 'enabled_canary'),
          and(
            eq(procedureCandidate.state, 'active'),
            sql`${procedureCandidate.promotion}->>'basis' = 'owner_confirmed'`,
          ),
        ),
        eq(procedureCandidate.canarySpaceId, row.spaceId),
      ),
    )
    .for('update');
  const reverted = [];
  for (const candidate of canaries) {
    // A procedure was named by its own id, so it was this one. An engine skill is named
    // by a name anything could share, so the delivered bytes decide: only the skill this
    // job actually read ends here.
    if (candidate.origin === ENGINE_ORIGIN && !versions.has(`sha256:${digest(candidate.body)}`))
      continue;
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
    if (!saved) continue;
    // The person it was delivered to hears that it stopped, and why.
    await noticeReverted(
      tx,
      saved,
      saved.promotion.principal_id ?? row.principalId,
      row.id,
      CANARY_INTERVENTION,
    );
    reverted.push(saved);
  }
  return reverted;
}
