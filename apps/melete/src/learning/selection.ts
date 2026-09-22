import { type AttemptBundle, jsonObject, procedurePromotion } from '@melete/contracts';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { spaceAuthority } from '../principals/authority.ts';
import type { ProcedureScope } from './contracts.ts';
import { learningTrial } from './evaluation-schema.ts';
import { isGeneralProcedure, verifyDefinition } from './procedures.ts';
import { episode, learningJob, procedureCandidate, procedureEvaluation } from './schema.ts';
import { type ProcedureReach, triggersMatch } from './triggers.ts';

export const scopeMatches = (left: ProcedureScope, right: ProcedureScope) =>
  left.task_family === right.task_family &&
  left.app === right.app &&
  left.app_version === right.app_version &&
  left.role === right.role &&
  left.audience === right.audience;

/** The person's most recent message on this job, which a trigger may match as well as the objective. */
async function latestUserMessage(tx: Transaction, jobId: string) {
  const [latest] = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        eq(event.type, 'notice'),
        sql`${event.payload}->>'kind' = 'user_message'`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  const text = (latest?.payload as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text : '';
}

/**
 * Exact applicability, a trigger match, live evidence, and a held-out gate precede
 * every delivery. `latestMessage` is optional: a caller that has already read the
 * person's latest message may pass it; otherwise it is read here.
 */
/**
 * What the delivered procedures cover: their trigger phrases and the objective
 * of the job each was learned on. Nothing when none is delivered.
 */
export async function procedureReach(
  tx: Transaction,
  delivered: AttemptBundle['skills'],
): Promise<ProcedureReach | undefined> {
  const ids = delivered.flatMap((skill) =>
    skill.name.startsWith('procedure:') ? [skill.name.slice('procedure:'.length)] : [],
  );
  if (ids.length === 0) return undefined;
  const rows = await tx
    .select({ triggers: procedureCandidate.triggers, objective: job.objective })
    .from(procedureCandidate)
    .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
    .innerJoin(job, eq(job.id, episode.jobId))
    .where(inArray(procedureCandidate.id, ids));
  return {
    phrases: rows.flatMap((row) => row.triggers.map((trigger) => trigger.phrase)),
    learnedFrom: rows.map((row) => row.objective),
  };
}

export async function selectProcedureSkills(
  tx: Transaction,
  row: JobRow,
  model: AttemptBundle['model'],
  runtimeVersion?: string,
  latestMessage?: string,
): Promise<AttemptBundle['skills']> {
  if (jsonObject.parse(row.constraints).public_compartment || !runtimeVersion) return [];
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  if (registration?.scope.role !== 'owner' || registration.scope.audience !== 'private') return [];
  // Applicability metadata cannot grant membership or access to private evidence.
  const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
  const state = await tx.execute(
    sql`select revoked, restore_ready from memory_spaces where space_id = ${row.spaceId}`,
  );
  if (state[0] && (state[0].revoked || !state[0].restore_ready)) return [];
  const modelKey = `${model.provider}/${model.model}`;
  const message = latestMessage ?? (await latestUserMessage(tx, row.id));
  const valid = (
    candidate: typeof procedureCandidate.$inferSelect,
    source: typeof episode.$inferSelect,
  ) => {
    // Records rows written before triggers existed have none and apply by scope alone.
    const applies = candidate.triggers.length
      ? triggersMatch(candidate.triggers, row.objective, message)
      : !isGeneralProcedure(candidate);
    if (
      !scopeMatches(candidate.scope, registration.scope) ||
      !applies ||
      !candidate.compatibleModels.includes(modelKey) ||
      !source.versions.some(
        (version) =>
          version.runtime === runtimeVersion &&
          `${version.provider}/${version.model_requested}` === modelKey,
      )
    )
      return false;
    try {
      verifyDefinition(candidate);
      return true;
    } catch {
      return false;
    }
  };
  const [trial] = await tx.select().from(learningTrial).where(eq(learningTrial.jobId, row.id));
  if (trial) {
    if (access.role !== 'owner') return [];
    // A withheld control can never accidentally pick up a different active procedure.
    if (!trial.useCandidate || trial.expiresAt <= new Date()) return [];
    const [entry] = await tx
      .select({ candidate: procedureCandidate, source: episode, evaluation: procedureEvaluation })
      .from(procedureCandidate)
      .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
      .innerJoin(procedureEvaluation, eq(procedureEvaluation.id, trial.evaluationId))
      .where(
        and(
          eq(procedureCandidate.id, trial.candidateId),
          eq(procedureEvaluation.candidateId, trial.candidateId),
          eq(procedureEvaluation.bodyHash, trial.bodyHash),
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
        ),
      );
    // Sealed trials deliberately use isolated spaces; their durable trial grant
    // may carry this principal's candidate across that boundary, never another principal's.
    if (
      !entry ||
      entry.source.actor !== access.principalId ||
      entry.candidate.bodyHash !== trial.bodyHash ||
      !valid(entry.candidate, entry.source) ||
      entry.evaluation.evidence.status !== 'running' ||
      !['candidate', 'evaluated'].includes(entry.candidate.state)
    )
      return [];
    if (entry.evaluation.phase === 'sealed_final' && !entry.candidate.selectedEvaluationId)
      return [];
    return [{ name: `procedure:${entry.candidate.id}`, body: entry.candidate.body }];
  }
  const candidates = await tx
    .select({ candidate: procedureCandidate, source: episode })
    .from(procedureCandidate)
    .innerJoin(episode, eq(episode.id, procedureCandidate.episodeId))
    .where(
      and(
        eq(procedureCandidate.spaceId, row.spaceId),
        inArray(procedureCandidate.state, ['enabled_canary', 'active']),
        isNull(procedureCandidate.rejectionReason),
        // Paused or removed by the person: kept for resume or undo, never delivered.
        isNull(procedureCandidate.pausedAt),
        isNull(procedureCandidate.removedAt),
        eq(episode.restricted, false),
        gt(episode.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(procedureCandidate.createdAt));
  for (const { candidate, source } of candidates) {
    const promotion = procedurePromotion.safeParse(candidate.promotion);
    if (!promotion.success) continue;
    if (promotion.data.scope === 'space') {
      if (access.space.kind !== 'shared' || candidate.state !== 'active') continue;
    } else if ((promotion.data.principal_id ?? source.actor) !== access.principalId) continue;
    if (promotion.data.basis === 'owner_trial' || promotion.data.basis === 'owner_confirmed') {
      // The owner's approval of these exact bytes, for that owner, in the space it came from:
      // on trial while they try it, active once they have said to keep it.
      if (
        candidate.state !==
          (promotion.data.basis === 'owner_trial' ? 'enabled_canary' : 'active') ||
        promotion.data.scope !== 'private' ||
        promotion.data.principal_id !== access.principalId ||
        source.actor !== access.principalId ||
        promotion.data.definition_hash !== candidate.bodyHash ||
        candidate.canarySpaceId !== row.spaceId ||
        !valid(candidate, source)
      )
        continue;
      return [{ name: `procedure:${candidate.id}`, body: candidate.body }];
    }
    if (
      candidate.canarySpaceId !== row.spaceId ||
      !candidate.selectedEvaluationId ||
      !valid(candidate, source)
    )
      continue;
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
      .limit(1);
    if (!final || final.evidence.selection_evaluation_id !== candidate.selectedEvaluationId)
      continue;
    // One applicable procedure avoids contradictory instructions and remains below the three-skill cap.
    return [
      {
        name: `procedure:${candidate.id}`,
        body: candidate.body,
        ...(promotion.data.scope === 'space' ? { space_id: row.spaceId } : {}),
      },
    ];
  }
  return [];
}
