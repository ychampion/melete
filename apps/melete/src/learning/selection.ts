import { type AttemptBundle, jsonObject } from '@melete/contracts';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { spaceAuthority } from '../principals/authority.ts';
import type { ProcedureScope } from './contracts.ts';
import { learningTrial } from './evaluation-schema.ts';
import { verifyDefinition } from './procedures.ts';
import { episode, learningJob, procedureCandidate, procedureEvaluation } from './schema.ts';

export const scopeMatches = (left: ProcedureScope, right: ProcedureScope) =>
  left.task_family === right.task_family &&
  left.app === right.app &&
  left.app_version === right.app_version &&
  left.role === right.role &&
  left.audience === right.audience;

/** Exact applicability, live evidence, and a held-out gate precede every delivery. */
export async function selectProcedureSkills(
  tx: Transaction,
  row: JobRow,
  model: AttemptBundle['model'],
  runtimeVersion?: string,
): Promise<AttemptBundle['skills']> {
  if (jsonObject.parse(row.constraints).public_compartment || !runtimeVersion) return [];
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  if (registration?.scope.role !== 'owner' || registration.scope.audience !== 'private') return [];
  // A requested learning scope cannot turn a member into the owner of private evidence.
  const access = await spaceAuthority(tx, row.spaceId, row.principalId, true);
  if (access.role !== 'owner') return [];
  const state = await tx.execute(
    sql`select revoked, restore_ready from memory_spaces where space_id = ${row.spaceId}`,
  );
  if (state[0] && (state[0].revoked || !state[0].restore_ready)) return [];
  const modelKey = `${model.provider}/${model.model}`;
  const valid = (
    candidate: typeof procedureCandidate.$inferSelect,
    source: typeof episode.$inferSelect,
  ) => {
    if (
      !scopeMatches(candidate.scope, registration.scope) ||
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
    if (
      !entry ||
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
        eq(episode.restricted, false),
        gt(episode.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(procedureCandidate.createdAt));
  for (const { candidate, source } of candidates) {
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
    return [{ name: `procedure:${candidate.id}`, body: candidate.body }];
  }
  return [];
}
