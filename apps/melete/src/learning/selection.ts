import { type AttemptBundle, jsonObject, procedurePromotion } from '@melete/contracts';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import type { JobRow } from '../jobs/service.ts';
import { ownJob, spaceAuthority } from '../principals/authority.ts';
import type { ProcedureScope } from './contracts.ts';
import { ENGINE_BASIS, ENGINE_ORIGIN, engineDefinitionIntact } from './engine-scan.ts';
import { BUILT_IN_SKILL_NAMES, bodyDigest, standingProhibitions } from './engine-skills.ts';
import { learningTrial } from './evaluation-schema.ts';
import { isGeneralProcedure, verifyDefinition } from './procedures.ts';
import { episode, learningJob, procedureCandidate, procedureEvaluation } from './schema.ts';
import { type ProcedureReach, triggerSpecificity, triggersMatch } from './triggers.ts';

/** Never more than three skills in one bundle, whoever wrote them. */
export const MAX_DELIVERED_SKILLS = 3;
/**
 * What learning never takes: a job whose own words name a catalog skill still gets
 * it, however many procedures were learned or skills the engine wrote for this space.
 */
export const RESERVED_CATALOG_SLOTS = 1;
/** How many learned procedures one job may receive. */
export const MAX_DELIVERED_PROCEDURES = MAX_DELIVERED_SKILLS - RESERVED_CATALOG_SLOTS;

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
/** Whose attempt a delivered set of skills belongs to, and where. */
export type LearnedOwner = { spaceId: string; principalId: string | null };

/**
 * The engine's own skills that are live for this person in this space, by name.
 * An engine skill keeps the name the engine gave it, so it is recognised by the
 * stored row rather than by a prefix.
 */
async function liveEngineRows(tx: Transaction, names: readonly string[], owner: LearnedOwner) {
  if (names.length === 0 || !owner.principalId) return [];
  return tx
    .select({ name: procedureCandidate.skillName })
    .from(procedureCandidate)
    .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
    .where(
      and(
        eq(procedureCandidate.spaceId, owner.spaceId),
        eq(procedureCandidate.origin, ENGINE_ORIGIN),
        eq(procedureCandidate.state, 'enabled_canary'),
        eq(procedureCandidate.canarySpaceId, owner.spaceId),
        isNull(procedureCandidate.rejectionReason),
        isNull(procedureCandidate.holdReason),
        isNull(procedureCandidate.pausedAt),
        inArray(procedureCandidate.skillName, [...names]),
        ownJob(job.principalId, owner.principalId),
        sql`${procedureCandidate.promotion}->>'principal_id' = ${owner.principalId}`,
      ),
    );
}

/**
 * The learned skills in a delivered set: evaluated procedures, named
 * `procedure:<id>`, and the engine's own live skills. Anything later that
 * re-selects the catalog keeps these as they were delivered.
 */
export async function learnedSkills(
  tx: Transaction,
  delivered: AttemptBundle['skills'],
  owner: LearnedOwner,
): Promise<AttemptBundle['skills']> {
  const engine = new Set(
    (
      await liveEngineRows(
        tx,
        delivered.flatMap((skill) => (skill.name.startsWith('procedure:') ? [] : [skill.name])),
        owner,
      )
    ).map((row) => row.name),
  );
  return delivered.filter((skill) => skill.name.startsWith('procedure:') || engine.has(skill.name));
}

/**
 * What the delivered correction procedures cover: their trigger phrases, which are
 * the person's own words, and the objective of the job each was learned on. A
 * built-in doing the same work is left out beside them. A skill the engine wrote
 * has no such words behind it, so it never pushes a built-in out. Nothing when no
 * correction procedure is delivered.
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
        eq(procedureCandidate.origin, 'owner_correction'),
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
  // Newest first: among equally specific matches, the latest lesson leads.
  const deliverable: { skill: AttemptBundle['skills'][number]; specificity: number }[] = [];
  const deliver = (candidate: typeof procedureCandidate.$inferSelect, spaceScoped: boolean) =>
    deliverable.push({
      skill: {
        name: `procedure:${candidate.id}`,
        body: candidate.body,
        ...(spaceScoped ? { space_id: row.spaceId } : {}),
      },
      specificity: triggerSpecificity(candidate.triggers, row.objective, message),
    });
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
      deliver(candidate, false);
      continue;
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
    deliver(candidate, promotion.data.scope === 'space');
  }
  // The most specific matches first; the bundle's own skill cap still applies.
  const taught = deliverable
    .map((entry, order) => ({ ...entry, order }))
    .sort((left, right) => right.specificity - left.specificity || left.order - right.order)
    .slice(0, MAX_DELIVERED_PROCEDURES)
    .map((entry) => entry.skill);
  // A skill the engine wrote for itself is delivered beside the taught procedures,
  // never instead of one, and never in the slot kept for the catalog skills the
  // job's own words select.
  const written = await liveEngineSkills(
    tx,
    row,
    access.principalId,
    MAX_DELIVERED_SKILLS - taught.length - RESERVED_CATALOG_SLOTS,
  );
  return [...taught, ...written];
}

/**
 * Skills the engine wrote for itself: live, not paused, approved for these exact
 * bytes, written by a job of this same principal, and delivered only in the space
 * they came from. The stored definition is re-verified here, so a body edited in
 * storage is not delivered even though the row still says it is live.
 */
async function liveEngineSkills(
  tx: Transaction,
  row: JobRow,
  principalId: string | null,
  limit: number,
): Promise<AttemptBundle['skills']> {
  if (!principalId || limit <= 0) return [];
  const rows = await tx
    .select({ candidate: procedureCandidate })
    .from(procedureCandidate)
    .innerJoin(job, eq(job.id, procedureCandidate.sourceJobId))
    .where(
      and(
        eq(procedureCandidate.spaceId, row.spaceId),
        eq(procedureCandidate.origin, ENGINE_ORIGIN),
        eq(procedureCandidate.state, 'enabled_canary'),
        eq(procedureCandidate.canarySpaceId, row.spaceId),
        isNull(procedureCandidate.rejectionReason),
        isNull(procedureCandidate.holdReason),
        isNull(procedureCandidate.pausedAt),
        ownJob(job.principalId, principalId),
        sql`${procedureCandidate.promotion}->>'basis' = ${ENGINE_BASIS}`,
        sql`${procedureCandidate.promotion}->>'scope' = 'private'`,
        sql`${procedureCandidate.promotion}->>'principal_id' = ${principalId}`,
      ),
    )
    // Newest first: when not everything fits, the skills the engine wrote most
    // recently are the ones it is working from. Read past the limit, because the
    // checks below can pass over some.
    .orderBy(desc(procedureCandidate.createdAt))
    .limit(50);
  // What this person said not to do stays undone, in any of their spaces, under the
  // name they stopped or with the same bytes under another name.
  const prohibited = await standingProhibitions(tx, principalId);
  const delivered: AttemptBundle['skills'] = [];
  for (const { candidate } of rows) {
    const promotion = procedurePromotion.safeParse(candidate.promotion);
    if (!promotion.success || promotion.data.definition_hash !== candidate.bodyHash) continue;
    if (!candidate.skillName || !engineDefinitionIntact(candidate)) continue;
    // A skill that took a built-in's name before intake refused such names is not
    // delivered: its name would give it reach over the very built-in it copies,
    // and that built-in would be left out in its favour.
    if (BUILT_IN_SKILL_NAMES.has(candidate.skillName)) continue;
    if (
      prohibited.names.has(candidate.skillName) ||
      prohibited.digests.has(bodyDigest(candidate.body))
    )
      continue;
    delivered.push({ name: candidate.skillName, body: candidate.body });
    if (delivered.length >= limit) break;
  }
  return delivered;
}
