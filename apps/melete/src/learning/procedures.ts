import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import type { ProcedureState } from './contracts.ts';
import { requireLearningSpace } from './episodes.ts';
import { compileProcedure, definitionHash } from './procedure.ts';
import { episode, procedureCandidate, procedureEvaluation, procedureTransition } from './schema.ts';

export type Candidate = typeof procedureCandidate.$inferSelect;

/** The stored definition, not just the body, must still match the evaluated bytes. */
export function verifyDefinition(candidate: Candidate) {
  const compiled = compileProcedure(candidate.change);
  if (compiled.body !== candidate.body || definitionHash(candidate) !== candidate.bodyHash)
    throw new ServiceError(
      'definition_changed',
      'The procedure definition no longer matches its evidence.',
    );
}

export async function transitionProcedure(
  tx: Transaction,
  candidate: Candidate,
  to: ProcedureState,
  actor: string,
  reason: string,
) {
  await tx.insert(procedureTransition).values({
    id: newId('pt'),
    candidateId: candidate.id,
    fromState: candidate.state,
    toState: to,
    actor,
    reason,
  });
  const [saved] = await tx
    .update(procedureCandidate)
    .set({ state: to, version: candidate.version + 1 })
    .where(
      and(
        eq(procedureCandidate.id, candidate.id),
        eq(procedureCandidate.version, candidate.version),
      ),
    )
    .returning();
  if (!saved)
    throw new ServiceError('procedure_changed', 'The procedure changed during this transition.');
  return saved;
}

export class ProcedureService {
  constructor(readonly jobs: JobService) {}

  async locked(tx: Transaction, ownerId: string, spaceId: string, id: string) {
    await requireLearningSpace(tx, ownerId, spaceId);
    const [candidate] = await tx
      .select()
      .from(procedureCandidate)
      .where(and(eq(procedureCandidate.id, id), eq(procedureCandidate.spaceId, spaceId)))
      .for('update');
    if (!candidate) throw new ServiceError('not_found', 'Procedure not found.', 404);
    const [source] = await tx
      .select()
      .from(episode)
      .where(
        and(
          eq(episode.id, candidate.episodeId),
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
        ),
      );
    if (!source)
      throw new ServiceError('evidence_unavailable', 'The procedure evidence is unavailable.');
    return { candidate, source };
  }

  async list(ownerId: string, spaceId: string) {
    return this.jobs.transaction(async (tx) => {
      await requireLearningSpace(tx, ownerId, spaceId);
      return tx
        .select({ procedure: procedureCandidate })
        .from(procedureCandidate)
        .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(episode.restricted, false),
            gt(episode.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(procedureCandidate.createdAt))
        .limit(100);
    });
  }

  async inspect(ownerId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate } = await this.locked(tx, ownerId, spaceId, id);
      const history = await tx
        .select()
        .from(procedureTransition)
        .where(eq(procedureTransition.candidateId, id))
        .orderBy(procedureTransition.createdAt);
      // Final task contents are never served to the proposer or included in procedure context.
      const evaluations = await tx
        .select({
          id: procedureEvaluation.id,
          phase: procedureEvaluation.phase,
          passed: procedureEvaluation.passed,
          budget: procedureEvaluation.budget,
          createdAt: procedureEvaluation.createdAt,
          selectedAt: procedureEvaluation.selectedAt,
        })
        .from(procedureEvaluation)
        .where(eq(procedureEvaluation.candidateId, id))
        .orderBy(procedureEvaluation.createdAt);
      return { candidate, history, evaluations };
    });
  }

  async reject(ownerId: string, spaceId: string, id: string, reason: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate } = await this.locked(tx, ownerId, spaceId, id);
      if (!['candidate', 'evaluated'].includes(candidate.state))
        throw new ServiceError('invalid_procedure_state', 'Use rollback for an enabled procedure.');
      await tx
        .update(procedureCandidate)
        .set({ rejectionReason: `owner_rejected:${reason}` })
        .where(eq(procedureCandidate.id, id));
      return transitionProcedure(
        tx,
        candidate,
        candidate.state,
        ownerId,
        `Owner rejected: ${reason}`,
      );
    });
  }

  async enableCanary(ownerId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate } = await this.locked(tx, ownerId, spaceId, id);
      verifyDefinition(candidate);
      if (
        candidate.state !== 'evaluated' ||
        candidate.rejectionReason ||
        !candidate.selectedEvaluationId
      )
        throw new ServiceError(
          'promotion_denied',
          'A selected procedure with passing final evidence is required.',
        );
      const [validation] = await tx
        .select()
        .from(procedureEvaluation)
        .where(
          and(
            eq(procedureEvaluation.id, candidate.selectedEvaluationId),
            eq(procedureEvaluation.candidateId, id),
            eq(procedureEvaluation.phase, 'validation'),
            eq(procedureEvaluation.passed, true),
            eq(procedureEvaluation.bodyHash, candidate.bodyHash),
          ),
        );
      const [final] = await tx
        .select()
        .from(procedureEvaluation)
        .where(
          and(
            eq(procedureEvaluation.candidateId, id),
            eq(procedureEvaluation.phase, 'sealed_final'),
            eq(procedureEvaluation.bodyHash, candidate.bodyHash),
            eq(procedureEvaluation.passed, true),
          ),
        )
        .orderBy(desc(procedureEvaluation.createdAt))
        .limit(1);
      if (
        !validation?.selectedAt ||
        !final ||
        final.evidence.selection_evaluation_id !== validation.id ||
        final.createdAt < validation.selectedAt
      )
        throw new ServiceError(
          'promotion_denied',
          'The sealed final evidence does not follow this selection.',
        );
      await tx
        .update(procedureCandidate)
        .set({ canarySpaceId: spaceId })
        .where(eq(procedureCandidate.id, id));
      return transitionProcedure(
        tx,
        candidate,
        'enabled_canary',
        ownerId,
        'Passing held-out validation and sealed final evidence; one origin space.',
      );
    });
  }

  async activate(ownerId: string, spaceId: string, id: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate } = await this.locked(tx, ownerId, spaceId, id);
      verifyDefinition(candidate);
      if (candidate.state !== 'enabled_canary' || candidate.canarySpaceId !== spaceId)
        throw new ServiceError('invalid_procedure_state', 'Enable the one-space canary first.');
      const learned = await tx.execute(sql`
        select e.id from episode e where e.space_id = ${spaceId} and e.judgement = 'completed'
          and e.intervention is null and not e.restricted and e.expires_at > now()
          and exists (select 1 from jsonb_array_elements(e.versions) v,
            jsonb_array_elements(v->'skills') s where s->>'name' = ${`procedure:${id}`})
        limit 1`);
      if (!learned.length)
        throw new ServiceError(
          'canary_evidence_required',
          'A completed canary job without an intervention is required.',
        );
      const previous = await tx
        .select()
        .from(procedureCandidate)
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(procedureCandidate.scope, candidate.scope),
            eq(procedureCandidate.compatibleModels, candidate.compatibleModels),
            inArray(procedureCandidate.state, ['active', 'enabled_canary']),
            isNull(procedureCandidate.rejectionReason),
          ),
        )
        .for('update');
      for (const old of previous) {
        if (old.id !== id)
          await transitionProcedure(
            tx,
            old,
            'superseded',
            ownerId,
            `Superseded by ${id} after its canary.`,
          );
      }
      return transitionProcedure(
        tx,
        candidate,
        'active',
        ownerId,
        'The owner activated a completed one-space canary.',
      );
    });
  }

  async rollback(ownerId: string, spaceId: string, id: string, reason: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate } = await this.locked(tx, ownerId, spaceId, id);
      if (candidate.state === 'reverted') return candidate;
      if (!['active', 'enabled_canary'].includes(candidate.state))
        throw new ServiceError(
          'invalid_procedure_state',
          'Only an enabled procedure can be rolled back.',
        );
      return transitionProcedure(tx, candidate, 'reverted', ownerId, `Owner rollback: ${reason}`);
    });
  }
}
