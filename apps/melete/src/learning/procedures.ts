import { type ProcedurePromotionScope, procedurePromotionScope } from '@melete/contracts';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import { spaceAuthority, visibleJob } from '../principals/authority.ts';
import { compileStoredProcedure, verifyStoredEvidence } from './admit.ts';
import type { ProcedureState } from './contracts.ts';
import { requireLearningSpace } from './episodes.ts';
import { compileProcedure, definitionHash } from './procedure.ts';
import { objectiveIsOwnerText } from './provenance.ts';
import { episode, procedureCandidate, procedureEvaluation, procedureTransition } from './schema.ts';
import { unshareableContent } from './share.ts';

export type Candidate = typeof procedureCandidate.$inferSelect;

/** A general procedure is graded by its checks; the records family by its fixtures. */
export const isGeneralProcedure = (candidate: Pick<Candidate, 'tests'>) =>
  candidate.tests.includes('checks');

/**
 * The stored definition, not just the body, must still match the evaluated
 * bytes. Recompiling re-runs the deny scan, the authority scan and the
 * word-subset rule over the stored steps, so a definition survives only while
 * the rules that admitted it would admit it again. No episode is needed, which
 * is what makes this affordable at every delivery.
 */
export function verifyDefinition(candidate: Candidate) {
  try {
    const compiled = isGeneralProcedure(candidate)
      ? compileStoredProcedure(candidate.change, candidate.triggers)
      : compileProcedure(candidate.change);
    if (compiled.body !== candidate.body || definitionHash(candidate) !== candidate.bodyHash)
      throw new ServiceError(
        'definition_changed',
        'The procedure definition no longer matches its evidence.',
      );
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(
      'definition_changed',
      'The procedure definition no longer matches its evidence.',
    );
  }
}

/**
 * The spans as well, re-sliced out of the correction and the objective they
 * cite. Called where the episode row is already in hand, because a body that
 * recompiles from its stored quotes still has to be quoting something real.
 */
export function verifyEvidence(
  candidate: Candidate,
  source: { intervention: { text: string } | null },
  objective: string,
) {
  if (!isGeneralProcedure(candidate)) return;
  try {
    verifyStoredEvidence(candidate.evidence, [
      { id: 'intervention', offset: 0, text: source.intervention?.text ?? '' },
      { id: 'objective', offset: 0, text: objective },
    ]);
  } catch {
    throw new ServiceError(
      'evidence_changed',
      'The procedure no longer quotes the correction it was learned from.',
    );
  }
}

/** A passing sealed final, bound to the candidate's selected validation and recorded after it. */
export async function hasSelectedFinalEvidence(tx: Transaction, candidate: Candidate) {
  if (!candidate.selectedEvaluationId) return false;
  const [validation] = await tx
    .select()
    .from(procedureEvaluation)
    .where(
      and(
        eq(procedureEvaluation.id, candidate.selectedEvaluationId),
        eq(procedureEvaluation.candidateId, candidate.id),
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
        eq(procedureEvaluation.candidateId, candidate.id),
        eq(procedureEvaluation.phase, 'sealed_final'),
        eq(procedureEvaluation.bodyHash, candidate.bodyHash),
        eq(procedureEvaluation.passed, true),
      ),
    )
    .orderBy(desc(procedureEvaluation.createdAt))
    .limit(1);
  return !!(
    validation?.selectedAt &&
    final &&
    final.evidence.selection_evaluation_id === validation.id &&
    final.createdAt >= validation.selectedAt
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
          visibleJob(episode.jobId, ownerId),
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
        ),
      );
    if (!source)
      throw new ServiceError('evidence_unavailable', 'The procedure evidence is unavailable.');
    // The objective the spans may cite, alongside the correction itself: only when the
    // correcting owner wrote it. Otherwise no span may cite it at all.
    const [origin] = await tx
      .select({
        objective: job.objective,
        kind: job.kind,
        principalId: job.principalId,
        planId: job.planId,
      })
      .from(job)
      .where(eq(job.id, source.jobId));
    const objective = origin && objectiveIsOwnerText(origin, source.actor) ? origin.objective : '';
    return { candidate, source, objective };
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
            visibleJob(episode.jobId, ownerId),
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
      const { candidate, source, objective } = await this.locked(tx, ownerId, spaceId, id);
      verifyDefinition(candidate);
      verifyEvidence(candidate, source, objective);
      if (
        candidate.state !== 'evaluated' ||
        candidate.rejectionReason ||
        !candidate.selectedEvaluationId
      )
        throw new ServiceError(
          'promotion_denied',
          'A selected procedure with passing final evidence is required.',
        );
      if (!(await hasSelectedFinalEvidence(tx, candidate)))
        throw new ServiceError(
          'promotion_denied',
          'The sealed final evidence does not follow this selection.',
        );
      await tx
        .update(procedureCandidate)
        .set({ canarySpaceId: spaceId, promotion: { scope: 'private', principal_id: ownerId } })
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

  /**
   * The owner who made the correction approves the exact definition they were shown,
   * by its hash, and tries it on their own work in this space. Discrimination is not
   * required: a correction about tone may have nothing a check can read. Evaluation
   * evidence is still required to activate or share.
   */
  async startTrial(ownerId: string, spaceId: string, id: string, definitionHash: string) {
    return this.jobs.transaction(async (tx) => {
      const { candidate, source, objective } = await this.locked(tx, ownerId, spaceId, id);
      if (source.actor !== ownerId)
        throw new ServiceError(
          'trial_denied',
          'Only the owner who made the correction may try what it taught.',
          403,
        );
      verifyDefinition(candidate);
      verifyEvidence(candidate, source, objective);
      if (!['candidate', 'evaluated'].includes(candidate.state) || candidate.rejectionReason)
        throw new ServiceError(
          'invalid_procedure_state',
          'Only a candidate that is not rejected can be tried.',
        );
      if (definitionHash !== candidate.bodyHash)
        throw new ServiceError(
          'definition_hash_mismatch',
          'The approved definition is not the current one; review it again.',
        );
      await tx
        .update(procedureCandidate)
        .set({
          canarySpaceId: spaceId,
          promotion: {
            scope: 'private',
            principal_id: ownerId,
            basis: 'owner_trial',
            definition_hash: definitionHash,
            approved_at: new Date().toISOString(),
          },
        })
        .where(eq(procedureCandidate.id, id));
      return transitionProcedure(
        tx,
        candidate,
        'enabled_canary',
        ownerId,
        'The owner approved this exact definition for a private trial in its origin space.',
      );
    });
  }

  async activate(
    ownerId: string,
    spaceId: string,
    id: string,
    delivery: ProcedurePromotionScope = 'private',
  ) {
    const scope = procedurePromotionScope.parse(delivery);
    return this.jobs.transaction(async (tx) => {
      const { candidate, source, objective } = await this.locked(tx, ownerId, spaceId, id);
      const access = await spaceAuthority(tx, spaceId, ownerId, true);
      if (scope === 'space' && access.space.kind !== 'shared')
        throw new ServiceError('scope_denied', 'Space promotion requires a shared space.', 403);
      verifyDefinition(candidate);
      verifyEvidence(candidate, source, objective);
      if (candidate.state !== 'enabled_canary' || candidate.canarySpaceId !== spaceId)
        throw new ServiceError('invalid_procedure_state', 'Enable the one-space canary first.');
      // An owner trial delivers to its owner; only held-out evidence can make a procedure active.
      if (!(await hasSelectedFinalEvidence(tx, candidate)))
        throw new ServiceError(
          'promotion_denied',
          'Activation needs passing sealed final evidence bound to its selection.',
        );
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
      // Sharing reaches other people; a body carrying the owner's private material stays private.
      if (scope === 'space') {
        const unshareable = await unshareableContent(tx, spaceId, candidate.body);
        if (unshareable)
          throw new ServiceError('shareable_check_failed', `shareable_check_failed:${unshareable}`);
      }
      const previous = await tx
        .select()
        .from(procedureCandidate)
        .where(
          and(
            eq(procedureCandidate.spaceId, spaceId),
            eq(procedureCandidate.scope, candidate.scope),
            eq(procedureCandidate.compatibleModels, candidate.compatibleModels),
            sql`${procedureCandidate.promotion}->>'scope' = ${scope}`,
            sql`coalesce(${procedureCandidate.promotion}->>'principal_id', ${ownerId}) = ${ownerId}`,
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
      // This owner-controlled grant changes who may receive the evaluated body,
      // never its bytes, applicability, source evidence or tool authority.
      await tx
        .update(procedureCandidate)
        .set({ promotion: { scope, principal_id: ownerId } })
        .where(eq(procedureCandidate.id, id));
      return transitionProcedure(
        tx,
        candidate,
        'active',
        ownerId,
        `The owner activated a completed private canary with ${scope} delivery.`,
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
