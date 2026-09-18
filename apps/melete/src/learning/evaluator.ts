import {
  type AttemptBundle,
  attemptOutcome,
  attemptUsage,
  jsonObject,
  type ProcedureDiscrimination,
  type RuntimeAdapter,
} from '@melete/contracts';
import { and, desc, eq, lte, sql } from 'drizzle-orm';
import { openHarness } from '../../../../conformance/memory/harness.ts';
import { scenario } from '../../../../conformance/memory/schema.ts';
import { ServiceError } from '../api/errors.ts';
import { action, attempt, space } from '../db/schema.ts';
import { AttemptRunner, type RunnerOptions } from '../jobs/runner.ts';
import { type JobRow, JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import type { CheckReport } from './checks.ts';
import type { ProcedureScope } from './contracts.ts';
import { discriminate } from './discriminate.ts';
import { discriminationInput } from './discrimination-input.ts';
import { digest, type EpisodeRow } from './episodes.ts';
import { learningEvaluationLease, learningTrial } from './evaluation-schema.ts';
import type { GateInput, Metric } from './gate.ts';
import {
  type Candidate,
  isGeneralProcedure,
  ProcedureService,
  transitionProcedure,
  verifyDefinition,
} from './procedures.ts';
import { openPromoterProcess } from './promoter-process.ts';
import { learningJob, procedureCandidate, procedureEvaluation } from './schema.ts';
import { selectProcedureSkills } from './selection.ts';
import { assertSuiteModules, DEFAULT_SUITES, resolveSuite, suiteHash } from './suites/index.ts';
import type { EvaluationCase, EvaluationSuite, PhaseCases } from './suites/types.ts';

export { EVALUATED_SCOPE } from './suites/records.ts';

const CRITICAL = ['source-authority', 'forgetting-and-access', 'procedure-scope'];
export const OUTPUT_BUDGET = 8192;
/** The promotion gate refuses more than this; asking first gives a reason instead of an opaque mismatch. */
export const MAX_EVALUATION_JOBS = 40;
export const MAX_RESERVED_TOKENS = 65536;
/**
 * Longer than any bounded evaluation can run (sixteen arms of twenty seconds, plus
 * the harness), and short enough that a crashed run does not block a space for a
 * day. The same bound frees the lease and lets the abandoned evaluation it left
 * behind be recorded as failed.
 */
export const EVALUATION_LEASE_MS = 900000;
const wake = (row: JobRow) => ({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'created' as const,
});
type Evaluation = typeof procedureEvaluation.$inferSelect;
type Arm = {
  row: JobRow;
  report: CheckReport;
  tokens: number;
  outputHash: string;
  attemptId: string;
  runtime: string;
  modelActual: string | null;
};

/** Field by field: a jsonb round trip may reorder keys but never changes a verdict. */
export const sameDiscrimination = (
  stored: ProcedureDiscrimination | null,
  recomputed: ProcedureDiscrimination,
) =>
  !!stored &&
  stored.status === recomputed.status &&
  stored.detail === recomputed.detail &&
  stored.prior_failed === recomputed.prior_failed &&
  stored.corrected_failed === recomputed.corrected_failed &&
  stored.empty_failed === recomputed.empty_failed &&
  stored.junk_failed === recomputed.junk_failed;

/** Every phase is two jobs per case; both caps are the gate's own. */
export function assertEvaluationBudget(cases: readonly EvaluationCase[]) {
  if (
    !cases.length ||
    cases.length * 2 > MAX_EVALUATION_JOBS ||
    cases.length * 2 * OUTPUT_BUDGET > MAX_RESERVED_TOKENS
  )
    throw new ServiceError(
      'evaluation_budget_exceeded',
      'This evaluation would exceed the jobs or tokens a promotion decision may rest on.',
    );
}

/** The trusted evaluator owns fixtures, job grants and grading; the proposer receives none of them. */
export class ProcedureEvaluator {
  private busy = false;
  readonly procedures: ProcedureService;
  constructor(
    readonly jobs: JobService,
    readonly runtime: RuntimeAdapter,
    readonly options: RunnerOptions,
    readonly suites: readonly EvaluationSuite[] = DEFAULT_SUITES,
  ) {
    assertSuiteModules(suites);
    this.procedures = new ProcedureService(jobs);
  }

  async evaluate(ownerId: string, spaceId: string, id: string) {
    if (this.busy)
      throw new ServiceError('evaluation_busy', 'Another bounded evaluation is running.');
    this.busy = true;
    // The lease is a row, taken and released in short transactions. Holding a
    // transaction open for the whole run would park a pooled connection idle in
    // transaction while the evaluation drives real jobs through the runner.
    const holder = newId('lease');
    try {
      await this.takeLease(spaceId, id, holder);
      return await this.evaluateLocked(ownerId, spaceId, id);
    } finally {
      await this.removeArmSpaces(id);
      await this.jobs.db
        .delete(learningEvaluationLease)
        .where(
          and(
            eq(learningEvaluationLease.spaceId, spaceId),
            eq(learningEvaluationLease.holder, holder),
          ),
        )
        .catch(() => undefined);
      this.busy = false;
    }
  }

  /**
   * An arm's space exists to isolate one graded run and is finished with when the
   * run is, whether it passed, failed or crashed: the evidence lives on the
   * evaluation row, not in the space. A space the memory layer has provisioned is
   * left alone — its retention is memory's to decide, not this evaluator's.
   */
  private async removeArmSpaces(candidateId: string) {
    await this.jobs.db
      .execute(
        sql`delete from space s where s.id in (
          select j.space_id from learning_trial t join job j on j.id = t.job_id
          where t.candidate_id = ${candidateId}
        ) and not exists (select 1 from memory_spaces m where m.space_id = s.id)`,
      )
      // In a finally after the verdict: a cleanup that cannot run leaves the rows it
      // would have removed, and must not replace the result the caller is waiting for.
      .catch(() => undefined);
  }

  /** One evaluation at a time in a space; a lease whose holder died expires. */
  private async takeLease(spaceId: string, candidateId: string, holder: string) {
    const expiresAt = new Date(Date.now() + EVALUATION_LEASE_MS);
    const [taken] = await this.jobs.db
      .insert(learningEvaluationLease)
      .values({ spaceId, candidateId, holder, expiresAt })
      .onConflictDoUpdate({
        target: learningEvaluationLease.spaceId,
        set: { candidateId, holder, acquiredAt: new Date(), expiresAt },
        setWhere: lte(learningEvaluationLease.expiresAt, new Date()),
      })
      .returning();
    if (!taken)
      throw new ServiceError('evaluation_busy', 'An evaluation is already running in this space.');
  }

  private async evaluateLocked(ownerId: string, spaceId: string, id: string) {
    let promoter: Awaited<ReturnType<typeof openPromoterProcess>> | undefined;
    let runner: AttemptRunner | undefined;
    try {
      const reserved = await this.jobs.transaction(async (tx) => {
        const { candidate, source } = await this.procedures.locked(tx, ownerId, spaceId, id);
        verifyDefinition(candidate);
        if (candidate.rejectionReason)
          throw new ServiceError('candidate_rejected', 'This candidate remains rejected history.');
        // Checks that cannot tell the corrected answer from the objected one measure nothing.
        if (
          (candidate.discrimination || isGeneralProcedure(candidate)) &&
          candidate.discrimination?.status !== 'passed'
        )
          throw new ServiceError(
            'checks_do_not_discriminate',
            `checks_do_not_discriminate:${candidate.discrimination?.detail ?? 'unrecorded'}`,
          );
        // The stored verdict is a record, not an authority: it has to follow from the episode now.
        if (isGeneralProcedure(candidate)) {
          const recomputed = discriminate(candidate.checks, await discriminationInput(tx, source));
          if (!sameDiscrimination(candidate.discrimination, recomputed))
            throw new ServiceError(
              'discrimination_changed',
              `The recorded discrimination no longer follows from the episode: ${recomputed.detail}.`,
            );
        }
        const [existing] = await tx
          .select()
          .from(procedureEvaluation)
          .where(eq(procedureEvaluation.candidateId, id))
          .limit(1);
        if (existing) {
          // A crashed run leaves `running` behind, and nothing else ever closes it:
          // every later call would return this inspection and the candidate could never
          // be evaluated again. Past the lease bound it is recorded as the failure it
          // was, with its reserved budget still charged, exactly as an in-process
          // failure would have been.
          if (
            existing.evidence.status !== 'running' ||
            Date.now() - existing.createdAt.getTime() < EVALUATION_LEASE_MS
          )
            return null;
          await tx
            .update(procedureEvaluation)
            .set({
              passed: false,
              evidence: { ...existing.evidence, status: 'failed', reason: 'evaluation_abandoned' },
            })
            .where(eq(procedureEvaluation.id, existing.id));
          await tx
            .update(procedureCandidate)
            .set({ rejectionReason: 'evaluation_abandoned' })
            .where(eq(procedureCandidate.id, id));
          if (candidate.state === 'candidate')
            await transitionProcedure(
              tx,
              candidate,
              'evaluated',
              'evaluator',
              'An earlier evaluation never finished; its budget remains charged.',
            );
          // Recorded here, refused outside: throwing would roll this record back.
          return 'abandoned' as const;
        }
        if (candidate.state !== 'candidate')
          throw new ServiceError('invalid_procedure_state', 'A fresh candidate is required.');
        const suite = resolveSuite(candidate.scope, this.suites);
        if (!suite)
          throw new ServiceError(
            'evaluation_suite_unavailable',
            'No evaluation suite covers this procedure scope.',
          );
        const model = `${this.options.provider ?? 'stub'}/${this.options.model ?? 'script'}`;
        if (!candidate.compatibleModels.includes(model))
          throw new ServiceError('evaluation_model_mismatch', 'Evaluate with a compatible model.');
        const plan = await suite.plan({ tx, ownerId, candidate, source });
        assertEvaluationBudget(plan.validation.cases);
        return { candidate: plan.candidate, source, suite, plan };
      });
      if (reserved === 'abandoned')
        throw new ServiceError(
          'evaluation_abandoned',
          'An earlier evaluation of this procedure never finished; it is recorded as failed.',
        );
      if (!reserved) return this.procedures.inspect(ownerId, spaceId, id);
      const runtime = await this.runtime.capabilities();
      if (!reserved.source.versions.some((version) => version.runtime === runtime.version))
        throw new ServiceError(
          'evaluation_runtime_mismatch',
          'The runtime version differs from the intervention evidence.',
        );
      promoter = await openPromoterProcess();
      runner = new AttemptRunner(
        new JobService(this.jobs.db, this.jobs.boss),
        this.runtime,
        this.options,
      );
      const validation = await this.runPhase(
        ownerId,
        reserved.candidate,
        reserved.source,
        reserved.suite,
        'validation',
        reserved.plan.validation,
        null,
        runner,
        promoter,
      );
      if (!validation.passed || !validation.selectedAt)
        return this.procedures.inspect(ownerId, spaceId, id);
      // Final cases are resolved only now, after selection committed, from the selection's own id.
      const final = await reserved.plan.sealedFinal(validation.id);
      assertEvaluationBudget(final.cases);
      await this.runPhase(
        ownerId,
        reserved.candidate,
        reserved.source,
        reserved.suite,
        'sealed_final',
        final,
        validation,
        runner,
        promoter,
      );
      return this.procedures.inspect(ownerId, spaceId, id);
    } finally {
      try {
        await runner?.stop();
      } finally {
        await promoter?.close();
      }
    }
  }

  private async runPhase(
    ownerId: string,
    candidate: Candidate,
    source: EpisodeRow,
    suite: EvaluationSuite,
    phase: GateInput['phase'],
    planned: PhaseCases,
    selection: Evaluation | null,
    runner: AttemptRunner,
    promoter: Awaited<ReturnType<typeof openPromoterProcess>>,
  ) {
    const cases = planned.cases;
    const memory = [];
    for (const path of planned.memory)
      memory.push(
        scenario.parse(
          await Bun.file(
            new URL(`../../../../conformance/memory/scenarios/${path}`, import.meta.url),
          ).json(),
        ),
      );
    const hash = await suiteHash({
      phase,
      suite,
      caseTemplates: cases.map((value) => value.template),
      memory,
    });
    const started = performance.now();
    const baseBudget = {
      jobs: cases.length * 2,
      reservedTokens: cases.length * 2 * OUTPUT_BUDGET,
      durationMs: 0,
    };
    const evaluation = await this.jobs.transaction(async (tx) => {
      const current = await this.procedures.locked(tx, ownerId, candidate.spaceId, candidate.id);
      verifyDefinition(current.candidate);
      if (current.candidate.bodyHash !== candidate.bodyHash || current.candidate.rejectionReason)
        throw new ServiceError('definition_changed', 'The candidate changed before evaluation.');
      if (phase === 'sealed_final' && current.candidate.selectedEvaluationId !== selection?.id)
        throw new ServiceError(
          'selection_required',
          'Persist validation selection before final evaluation.',
        );
      const [saved] = await tx
        .insert(procedureEvaluation)
        .values({
          id: newId('pe'),
          candidateId: candidate.id,
          bodyHash: candidate.bodyHash,
          phase,
          suiteId: suite.id,
          suiteHash: hash,
          evidence: { status: 'running', selection_evaluation_id: selection?.id ?? null },
          budget: baseBudget,
          passed: false,
        })
        .returning();
      if (!saved) throw new Error('evaluation_reservation_failed');
      return saved;
    });
    try {
      const rows: Metric[] = [];
      const runs: Record<string, unknown>[] = [];
      let actualTokens = 0;
      let latestCandidate: JobRow | undefined;
      for (const value of cases) {
        const occurredAt = new Date().toISOString();
        const baseline = await this.runArm(
          ownerId,
          candidate,
          evaluation,
          value,
          false,
          runner,
          suite,
        );
        const learned = await this.runArm(
          ownerId,
          candidate,
          evaluation,
          value,
          true,
          runner,
          suite,
        );
        latestCandidate = learned.row;
        actualTokens += baseline.tokens + learned.tokens;
        rows.push({
          family: source.scope.task_family,
          template: value.template,
          space: learned.row.spaceId,
          occurredAt,
          baseline: baseline.report.score,
          candidate: learned.report.score,
          // Failed checks, measured on each run: not a restatement of the score.
          baselineCorrections: baseline.report.corrections,
          candidateCorrections: learned.report.corrections,
          scopeViolations: 0,
        });
        runs.push({
          template: value.template,
          origin: value.origin,
          baseline: {
            job: baseline.row.id,
            attempt: baseline.attemptId,
            outputHash: baseline.outputHash,
            runtime: baseline.runtime,
            modelActual: baseline.modelActual,
            corrections: baseline.report.corrections,
          },
          candidate: {
            job: learned.row.id,
            attempt: learned.attemptId,
            outputHash: learned.outputHash,
            runtime: learned.runtime,
            modelActual: learned.modelActual,
            corrections: learned.report.corrections,
          },
        });
      }
      if (!latestCandidate) throw new Error('evaluation_cases_empty');
      const violations = await this.scopeChecks(latestCandidate, candidate, runner);
      rows.push({
        family: 'procedure-scope',
        template: `${phase}-scope-boundaries`,
        space: latestCandidate.spaceId,
        occurredAt: new Date().toISOString(),
        baseline: 1,
        candidate: violations ? 0 : 1,
        baselineCorrections: 0,
        candidateCorrections: 0,
        scopeViolations: violations,
      });
      const harness = await openHarness({ databasePort: 0, providerPort: 0 });
      if (!harness) throw new Error('memory_conformance_unavailable');
      let memoryTokens = 0;
      let memoryCalls = 0;
      try {
        for (const fixture of memory) {
          const occurredAt = new Date().toISOString();
          const baseline = await harness.run(fixture, 'memory');
          const spaces = await harness.db
            .sql`select space_id from memory_spaces order by space_id limit 1`;
          const learned = await harness.run(fixture, 'memory');
          const withheld = fixture.memory_required ? await harness.run(fixture, 'withheld') : null;
          const exercised = !fixture.memory_required || withheld?.outcome === 'failed';
          const before = baseline.outcome === 'passed' && exercised;
          const after = learned.outcome === 'passed' && exercised;
          rows.push({
            family: fixture.family,
            template: `${phase}-${fixture.id}`,
            space: String(spaces[0]?.space_id ?? ''),
            occurredAt,
            baseline: before ? 1 : 0,
            candidate: after ? 1 : 0,
            baselineCorrections: 0,
            candidateCorrections: 0,
            scopeViolations: 0,
          });
          runs.push({
            memory: fixture.id,
            baseline: baseline.outcome,
            candidate: learned.outcome,
            withheld: withheld?.outcome,
            checks: learned.checks,
            failures: learned.failures,
            exercised,
          });
        }
        memoryCalls = harness.provider.calls.extraction + harness.provider.calls.answer;
        memoryTokens = harness.provider.calls.extraction * 120 + harness.provider.calls.answer * 80;
      } finally {
        await harness.close();
      }
      const selectedRows = selection?.evidence.rows as Metric[] | undefined;
      const gate: GateInput = {
        phase,
        target: 'skill_body',
        definitionHash: candidate.bodyHash,
        suiteHash: hash,
        source: {
          family: source.scope.task_family,
          template: source.templateId,
          space: source.spaceId,
          occurredAt: source.createdAt.toISOString(),
        },
        rows,
        criticalFamilies: CRITICAL,
        budget: { ...baseBudget, durationMs: Math.round(performance.now() - started) },
        selection:
          selection?.selectedAt && selectedRows
            ? {
                definitionHash: selection.bodyHash,
                selectedAt: selection.selectedAt.toISOString(),
                templates: selectedRows.map((row) => row.template),
                spaces: selectedRows.map((row) => row.space),
                latestInstanceAt: new Date(
                  Math.max(...selectedRows.map((row) => Date.parse(row.occurredAt))),
                ).toISOString(),
              }
            : null,
      };
      const verdict = await promoter.decide(gate);
      return this.jobs.transaction(async (tx) => {
        const current = await this.procedures.locked(tx, ownerId, candidate.spaceId, candidate.id);
        verifyDefinition(current.candidate);
        if (current.candidate.bodyHash !== candidate.bodyHash || current.candidate.rejectionReason)
          throw new ServiceError('definition_changed', 'The candidate changed during evaluation.');
        const passed = verdict.decision !== 'reject';
        const selectedAt = phase === 'validation' && passed ? new Date() : null;
        const [saved] = await tx
          .update(procedureEvaluation)
          .set({
            passed,
            selectedAt,
            evidence: {
              status: 'complete',
              rows,
              runs,
              decision: verdict,
              selection_evaluation_id: selection?.id ?? null,
            },
            budget: {
              ...gate.budget,
              actualTokens,
              memoryTokens,
              memoryCalls,
              models: candidate.compatibleModels,
            },
          })
          .where(eq(procedureEvaluation.id, evaluation.id))
          .returning();
        if (!saved) throw new Error('evaluation_result_missing');
        await tx
          .update(procedureCandidate)
          .set({
            ...(selectedAt ? { selectedEvaluationId: evaluation.id } : {}),
            rejectionReason: passed ? null : verdict.reason,
          })
          .where(eq(procedureCandidate.id, candidate.id));
        await transitionProcedure(
          tx,
          current.candidate,
          'evaluated',
          'promoter',
          `${phase}: ${verdict.reason}`,
        );
        return saved;
      });
    } catch (error) {
      await this.jobs.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(procedureCandidate)
          .where(eq(procedureCandidate.id, candidate.id))
          .for('update');
        if (!current) return;
        await tx
          .update(procedureEvaluation)
          .set({
            passed: false,
            evidence: {
              status: 'failed',
              reason: 'evaluation_failed',
              selection_evaluation_id: selection?.id ?? null,
            },
            budget: { ...baseBudget, durationMs: Math.round(performance.now() - started) },
          })
          .where(eq(procedureEvaluation.id, evaluation.id));
        await tx
          .update(procedureCandidate)
          .set({ rejectionReason: 'evaluation_failed' })
          .where(eq(procedureCandidate.id, candidate.id));
        await transitionProcedure(
          tx,
          current,
          'evaluated',
          'evaluator',
          `${phase}: evaluation failed; reserved budget remains charged.`,
        );
      });
      const failure = new ServiceError(
        'evaluation_failed',
        'The trusted evaluation did not complete; its reserved budget and rejection are retained.',
      );
      Object.defineProperty(failure, 'cause', { value: error });
      throw failure;
    }
  }

  private async runArm(
    ownerId: string,
    candidate: Candidate,
    evaluation: Evaluation,
    value: EvaluationCase,
    useCandidate: boolean,
    runner: AttemptRunner,
    suite: EvaluationSuite,
  ): Promise<Arm> {
    const row = await this.jobs.transaction(async (tx) => {
      const id = newId('sp');
      await tx.insert(space).values({
        id,
        name: `Procedure evaluation: ${evaluation.phase}`,
        gitPath: `evaluation/${id}`,
        ownerPrincipalId: ownerId,
      });
      const row = await this.jobs.createInTransaction(
        tx,
        {
          space_id: id,
          title: value.template,
          objective: value.objective,
          learning: { scope: candidate.scope, template_id: value.template, input_refs: [] },
          budget: {
            max_turns: 2,
            max_output_tokens: OUTPUT_BUDGET,
            max_actions: 0,
            max_attempts: 1,
            max_wall_ms: 15000,
            max_usd_est: 0.1,
          },
        },
        undefined,
        // Held-out history or a model-authored variant, never a request typed now.
        'derived',
      );
      await tx.insert(learningTrial).values({
        jobId: row.id,
        candidateId: candidate.id,
        evaluationId: evaluation.id,
        bodyHash: candidate.bodyHash,
        useCandidate,
        expiresAt: new Date(Date.now() + 180000),
      });
      return row;
    });
    await runner.handleWake(wake(row));
    const deadline = Date.now() + 20000;
    let current = await this.jobs.get(row.id);
    while (!['completed', 'failed', 'cancelled'].includes(current.state) && Date.now() < deadline) {
      await Bun.sleep(20);
      current = await this.jobs.get(row.id);
    }
    const [execution] = await this.jobs.db
      .select()
      .from(attempt)
      .where(eq(attempt.jobId, row.id))
      .orderBy(desc(attempt.epoch))
      .limit(1);
    if (!execution?.endedAt) throw new Error('evaluation_job_unfinished');
    const usage = attemptUsage.parse(execution.usage);
    const parsed = attemptOutcome.safeParse(execution.outcomeDetail);
    const summary = parsed.success && 'summary' in parsed.data ? parsed.data.summary : '';
    const actions = await this.jobs.db
      .select({ kind: action.kind, effectClass: action.effectClass, status: action.status })
      .from(action)
      .where(eq(action.jobId, row.id));
    return {
      row,
      report: suite.grade(value, { output: summary, actions, state: current.state }, candidate),
      tokens: usage.input_tokens + usage.output_tokens,
      outputHash: digest(summary),
      attemptId: execution.id,
      runtime: execution.runtimeVersion,
      modelActual: execution.modelActual,
    };
  }

  private async scopeChecks(row: JobRow, candidate: Candidate, runner: AttemptRunner) {
    const scope: ProcedureScope = candidate.scope;
    const model: AttemptBundle['model'] = {
      provider: this.options.provider ?? 'stub',
      model: this.options.model ?? 'script',
      fallback: null,
    };
    const runtime = await runner.runtime.capabilities();
    return this.jobs.transaction(async (tx) => {
      let violations = 0;
      // Every probe below expects nothing, which proves nothing unless the unchanged job
      // receives the candidate. A control that delivers nothing counts against the scope.
      const control = await selectProcedureSkills(tx, row, model, runtime.version);
      if (control.length !== 1 || control[0]?.name !== `procedure:${candidate.id}`) violations += 1;
      violations += (
        await selectProcedureSkills(
          tx,
          {
            ...row,
            constraints: { ...jsonObject.parse(row.constraints), public_compartment: true },
          },
          model,
          runtime.version,
        )
      ).length;
      violations += (
        await selectProcedureSkills(
          tx,
          row,
          { ...model, model: 'incompatible-model' },
          runtime.version,
        )
      ).length;
      violations += (await selectProcedureSkills(tx, row, model, 'incompatible-runtime')).length;
      for (const key of ['task_family', 'app', 'app_version'] as const) {
        const changed = { ...scope, [key]: `another-${scope[key]}` };
        await tx.update(learningJob).set({ scope: changed }).where(eq(learningJob.jobId, row.id));
        violations += (await selectProcedureSkills(tx, row, model, runtime.version)).length;
      }
      await tx.update(learningJob).set({ scope }).where(eq(learningJob.jobId, row.id));
      // With the scope restored, work the triggers do not name still receives nothing.
      if (candidate.triggers.length)
        violations += (
          await selectProcedureSkills(tx, { ...row, objective: '.' }, model, runtime.version, '')
        ).length;
      return violations;
    });
  }
}
