/**
 * Evaluation cases drawn from the owner's own work, for any scope without a
 * bundled fixture suite.
 *
 * Held-out history is the owner's completed jobs in the same space and scope
 * that were never corrected, whose objectives match one of the candidate's
 * triggers, taken oldest first so a job created to flatter a candidate cannot
 * push real history out of the set. The candidate's admitted variant objectives
 * fill out the pool. A variant carries no answer and no grader: both arms run it
 * and are graded by the checks that already had to discriminate on the real
 * episode, and every phase must contain at least one history case, so a run is
 * never the candidate's own variants alone.
 *
 * The pool is split into validation and final templates before anything runs,
 * and the split is stored on the candidate, where the definition hash binds it.
 * Which final templates run is decided only from the selection's own id, after
 * selection commits.
 */
import { and, asc, eq, gt, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { validationMemory } from '../../../../../conformance/learning/validation.ts';
import { ServiceError } from '../../api/errors.ts';
import { job } from '../../db/schema.ts';
import { visibleJob } from '../../principals/authority.ts';
import type { GeneralChange } from '../admit.ts';
import { caseInput } from '../case-input.ts';
import { digest } from '../episodes.ts';
import { definitionHash } from '../procedure.ts';
import type { Candidate } from '../procedures.ts';
import { episode, learningJob, procedureCandidate } from '../schema.ts';
import { objectiveTemplate } from '../scope.ts';
import { scopeMatches } from '../selection.ts';
import { triggersMatch } from '../triggers.ts';
import { type EvaluationCase, type EvaluationSuite, gradeFinished } from './types.ts';

export const MAX_HISTORY_CASES = 6;
export const MAX_CASES_PER_PHASE = 4;
export const MIN_CASES_PER_PHASE = 3;
export const FINAL_CASES = 3;

const insufficient = (detail: string) =>
  new ServiceError(
    'evaluation_cases_insufficient',
    `Not enough held-out work to evaluate this procedure: ${detail}.`,
  );

/** At least three cases, two distinct templates, and one that is real history. */
function assertPhase(cases: readonly EvaluationCase[], phase: string) {
  if (cases.length < MIN_CASES_PER_PHASE) throw insufficient(`${phase} needs three cases`);
  if (new Set(cases.map((value) => value.template)).size < 2)
    throw insufficient(`${phase} needs two templates`);
  if (!cases.some((value) => value.origin === 'history'))
    throw insufficient(`${phase} needs a held-out history case`);
}

/**
 * A deterministic, disjoint split that neither the candidate nor the order of
 * history can choose: each group is ordered by a digest of the partition key and
 * the template, and alternate cases go to validation and to the final pool, so
 * both sides get history whenever there are at least two history cases.
 */
function partition(key: string, cases: readonly EvaluationCase[]) {
  const ordered = [...cases].sort((left, right) =>
    digest(`${key}:${left.template}`).localeCompare(digest(`${key}:${right.template}`)),
  );
  return {
    validation: ordered.filter((_, index) => index % 2 === 0),
    final: ordered.filter((_, index) => index % 2 === 1),
  };
}

export const episodeDerivedSuite: EvaluationSuite = {
  id: 'episode-derived/1',
  modules: [
    'apps/melete/src/learning/suites/episode-derived.ts',
    'apps/melete/src/learning/scope.ts',
    'apps/melete/src/learning/triggers.ts',
    'apps/melete/src/learning/case-input.ts',
    'conformance/learning/records.ts',
    'conformance/learning/validation.ts',
    'conformance/learning/sealed-final.ts',
  ],
  // Registered after every bundled suite, so it covers whatever they do not.
  supports: () => true,
  async plan({ tx, ownerId, candidate, source }) {
    const excluded = [source.jobId, ...(source.correctiveJobId ? [source.correctiveJobId] : [])];
    const rows = await tx
      .select({
        jobId: job.id,
        objective: job.objective,
        template: learningJob.templateId,
        scope: learningJob.scope,
      })
      .from(learningJob)
      .innerJoin(job, eq(job.id, learningJob.jobId))
      .innerJoin(episode, eq(episode.jobId, job.id))
      .where(
        and(
          eq(learningJob.spaceId, source.spaceId),
          visibleJob(job.id, ownerId),
          eq(job.state, 'completed'),
          eq(episode.judgement, 'completed'),
          isNull(episode.intervention),
          eq(episode.restricted, false),
          gt(episode.expiresAt, new Date()),
          ne(learningJob.templateId, source.templateId),
          notInArray(job.id, excluded),
          // Never corrected, and never itself a correction of something else.
          sql`not exists (select 1 from episode corrected where corrected.job_id = ${job.id}
            and corrected.intervention is not null)`,
          sql`not exists (select 1 from episode linked where linked.corrective_job_id = ${job.id})`,
        ),
      )
      .orderBy(asc(job.createdAt), asc(job.id));
    const history: EvaluationCase[] = [];
    const seen = new Set<string>([source.templateId]);
    for (const row of rows) {
      if (history.length >= MAX_HISTORY_CASES) break;
      if (seen.has(row.template)) continue;
      if (!scopeMatches(row.scope, candidate.scope)) continue;
      if (!triggersMatch(candidate.triggers, row.objective)) continue;
      seen.add(row.template);
      const input = caseInput(row.objective);
      history.push({
        template: row.template,
        objective: row.objective,
        origin: 'history',
        ...(input ? { input } : {}),
      });
    }
    const variants: EvaluationCase[] = [];
    for (const objective of (candidate.change as GeneralChange).variant_objectives ?? []) {
      const template = objectiveTemplate(objective);
      if (seen.has(template)) continue;
      seen.add(template);
      const input = caseInput(objective);
      variants.push({ template, objective, origin: 'variant', ...(input ? { input } : {}) });
    }
    const pool = new Map([...history, ...variants].map((value) => [value.template, value]));

    let chosen = candidate;
    let validation: EvaluationCase[];
    let finalPool: EvaluationCase[];
    const stored = candidate.caseTemplates;
    if (stored.validation?.length && stored.final_pool?.length) {
      // A plan already bound into the definition is reused, never redrawn.
      const lookup = (templates: readonly string[]) =>
        templates.map((template) => {
          const value = pool.get(template);
          if (!value) throw insufficient('a planned case is no longer available');
          return value;
        });
      validation = lookup(stored.validation);
      finalPool = lookup(stored.final_pool);
    } else {
      // The key cannot depend on the templates it is about to choose.
      const key = definitionHash({ ...candidate, caseTemplates: {} });
      const fromHistory = partition(key, history);
      const fromVariants = partition(key, variants);
      validation = [...fromHistory.validation, ...fromVariants.validation].slice(
        0,
        MAX_CASES_PER_PHASE,
      );
      finalPool = [...fromHistory.final, ...fromVariants.final];
      assertPhase(validation, 'validation');
      assertPhase(finalPool, 'the final pool');
      const caseTemplates = {
        validation: validation.map((value) => value.template),
        final_pool: finalPool.map((value) => value.template),
      };
      const bodyHash = definitionHash({ ...candidate, caseTemplates });
      const [saved] = await tx
        .update(procedureCandidate)
        .set({ caseTemplates, bodyHash, version: candidate.version + 1 })
        .where(
          and(
            eq(procedureCandidate.id, candidate.id),
            eq(procedureCandidate.version, candidate.version),
          ),
        )
        .returning();
      if (!saved)
        throw new ServiceError('procedure_changed', 'The procedure changed while it was planned.');
      chosen = saved as Candidate;
    }
    assertPhase(validation, 'validation');
    assertPhase(finalPool, 'the final pool');
    const finalChoices = finalPool;
    return {
      candidate: chosen,
      validation: { cases: validation, memory: validationMemory },
      async sealedFinal(seed: string) {
        const ordered = [...finalChoices].sort((left, right) =>
          digest(`${seed}:${left.template}`).localeCompare(digest(`${seed}:${right.template}`)),
        );
        const cases = ordered.slice(0, FINAL_CASES);
        if (!cases.some((value) => value.origin === 'history')) {
          const history = ordered.find((value) => value.origin === 'history');
          if (history) cases[cases.length - 1] = history;
        }
        assertPhase(cases, 'the final phase');
        const final = await import('../../../../../conformance/learning/sealed-final.ts');
        return { cases, memory: final.sealedFinalMemory };
      },
    };
  },
  grade: (value, run, candidate) => gradeFinished(candidate.checks, value, run),
};
