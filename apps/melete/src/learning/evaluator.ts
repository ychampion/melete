import {
  type AttemptBundle,
  attemptOutcome,
  attemptUsage,
  jsonObject,
  type RuntimeAdapter,
} from '@melete/contracts';
import { desc, eq } from 'drizzle-orm';
import {
  gradeRecords,
  type RecordCase,
  taskObjective,
} from '../../../../conformance/learning/records.ts';
import { validationCases, validationMemory } from '../../../../conformance/learning/validation.ts';
import { openHarness } from '../../../../conformance/memory/harness.ts';
import { scenario } from '../../../../conformance/memory/schema.ts';
import { ServiceError } from '../api/errors.ts';
import { attempt, space } from '../db/schema.ts';
import { AttemptRunner, type RunnerOptions } from '../jobs/runner.ts';
import { type JobRow, JobService } from '../jobs/service.ts';
import { newId } from '../memory/db.ts';
import type { ProcedureScope } from './contracts.ts';
import { digest, type EpisodeRow } from './episodes.ts';
import { learningTrial } from './evaluation-schema.ts';
import type { GateInput, Metric } from './gate.ts';
import {
  type Candidate,
  ProcedureService,
  transitionProcedure,
  verifyDefinition,
} from './procedures.ts';
import { openPromoterProcess } from './promoter-process.ts';
import { learningJob, procedureCandidate, procedureEvaluation } from './schema.ts';
import { scopeMatches, selectProcedureSkills } from './selection.ts';

export const EVALUATED_SCOPE: ProcedureScope = {
  task_family: 'organize-records',
  app: 'table-editor',
  app_version: '1.0',
  role: 'owner',
  audience: 'private',
};
const CRITICAL = ['source-authority', 'forgetting-and-access', 'procedure-scope'];
const OUTPUT_BUDGET = 8192;
const wake = (row: JobRow) => ({
  job_id: row.id,
  expected_epoch: row.leaseEpoch,
  expected_version: row.stateVersion,
  reason: 'created' as const,
});
type Evaluation = typeof procedureEvaluation.$inferSelect;
type Arm = {
  row: JobRow;
  score: number;
  tokens: number;
  outputHash: string;
  attemptId: string;
  runtime: string;
  modelActual: string | null;
};

/** The trusted evaluator owns fixtures, job grants and grading; the proposer receives none of them. */
export class ProcedureEvaluator {
  private busy = false;
  readonly procedures: ProcedureService;
  constructor(
    readonly jobs: JobService,
    readonly runtime: RuntimeAdapter,
    readonly options: RunnerOptions,
  ) {
    this.procedures = new ProcedureService(jobs);
  }

  async evaluate(ownerId: string, spaceId: string, id: string) {
    if (this.busy)
      throw new ServiceError('evaluation_busy', 'Another bounded evaluation is running.');
    this.busy = true;
    let promoter: Awaited<ReturnType<typeof openPromoterProcess>> | undefined;
    let runner: AttemptRunner | undefined;
    try {
      const reserved = await this.jobs.transaction(async (tx) => {
        const { candidate, source } = await this.procedures.locked(tx, ownerId, spaceId, id);
        verifyDefinition(candidate);
        if (candidate.rejectionReason)
          throw new ServiceError('candidate_rejected', 'This candidate remains rejected history.');
        const [existing] = await tx
          .select()
          .from(procedureEvaluation)
          .where(eq(procedureEvaluation.candidateId, id))
          .limit(1);
        if (existing) return null;
        if (candidate.state !== 'candidate')
          throw new ServiceError('invalid_procedure_state', 'A fresh candidate is required.');
        if (!scopeMatches(candidate.scope, EVALUATED_SCOPE))
          throw new ServiceError(
            'evaluation_scope_unsupported',
            'This fixture suite evaluates organize-records in table-editor 1.0.',
          );
        const model = `${this.options.provider ?? 'stub'}/${this.options.model ?? 'script'}`;
        if (!candidate.compatibleModels.includes(model))
          throw new ServiceError('evaluation_model_mismatch', 'Evaluate with a compatible model.');
        return { candidate, source };
      });
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
        'validation',
        validationCases,
        validationMemory,
        null,
        runner,
        promoter,
      );
      if (!validation.passed || !validation.selectedAt)
        return this.procedures.inspect(ownerId, spaceId, id);
      // The final module is deliberately loaded only after selection committed. No adaptive final retries.
      const final = await import('../../../../conformance/learning/sealed-final.ts');
      await this.runPhase(
        ownerId,
        reserved.candidate,
        reserved.source,
        'sealed_final',
        final.sealedFinalCases(),
        final.sealedFinalMemory,
        validation,
        runner,
        promoter,
      );
      return this.procedures.inspect(ownerId, spaceId, id);
    } finally {
      try {
        await runner?.stop();
      } finally {
        try {
          await promoter?.close();
        } finally {
          this.busy = false;
        }
      }
    }
  }

  private async runPhase(
    ownerId: string,
    candidate: Candidate,
    source: EpisodeRow,
    phase: GateInput['phase'],
    cases: readonly RecordCase[],
    memoryFiles: readonly string[],
    selection: Evaluation | null,
    runner: AttemptRunner,
    promoter: Awaited<ReturnType<typeof openPromoterProcess>>,
  ) {
    const memory = [];
    for (const path of memoryFiles)
      memory.push(
        scenario.parse(
          await Bun.file(
            new URL(`../../../../conformance/memory/scenarios/${path}`, import.meta.url),
          ).json(),
        ),
      );
    const code = [];
    for (const path of [
      'conformance/learning/records.ts',
      'conformance/memory/harness.ts',
      'conformance/memory/provider.ts',
      'apps/melete/src/learning/gate.ts',
    ])
      code.push(digest(await Bun.file(new URL(`../../../../${path}`, import.meta.url)).text()));
    const suiteHash = digest({ phase, cases, memory, code });
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
          suiteHash,
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
        const baseline = await this.runArm(candidate, evaluation, value, false, runner);
        const learned = await this.runArm(candidate, evaluation, value, true, runner);
        latestCandidate = learned.row;
        actualTokens += baseline.tokens + learned.tokens;
        rows.push({
          family: source.scope.task_family,
          template: value.template,
          space: learned.row.spaceId,
          occurredAt,
          baseline: baseline.score,
          candidate: learned.score,
          baselineCorrections: 1 - baseline.score,
          candidateCorrections: 1 - learned.score,
          scopeViolations: 0,
        });
        runs.push({
          template: value.template,
          baseline: {
            job: baseline.row.id,
            attempt: baseline.attemptId,
            outputHash: baseline.outputHash,
            runtime: baseline.runtime,
            modelActual: baseline.modelActual,
          },
          candidate: {
            job: learned.row.id,
            attempt: learned.attemptId,
            outputHash: learned.outputHash,
            runtime: learned.runtime,
            modelActual: learned.modelActual,
          },
        });
      }
      if (!latestCandidate) throw new Error('evaluation_cases_empty');
      const violations = await this.scopeChecks(latestCandidate, candidate.scope, runner);
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
        suiteHash,
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
    candidate: Candidate,
    evaluation: Evaluation,
    value: RecordCase,
    useCandidate: boolean,
    runner: AttemptRunner,
  ): Promise<Arm> {
    const row = await this.jobs.transaction(async (tx) => {
      const id = newId('sp');
      await tx.insert(space).values({
        id,
        name: `Procedure evaluation: ${evaluation.phase}`,
        gitPath: `evaluation/${id}`,
      });
      const row = await this.jobs.createInTransaction(tx, {
        space_id: id,
        title: value.template,
        objective: taskObjective(value.task),
        learning: { scope: candidate.scope, template_id: value.template, input_refs: [] },
        budget: {
          max_turns: 2,
          max_output_tokens: OUTPUT_BUDGET,
          max_actions: 0,
          max_attempts: 1,
          max_wall_ms: 15000,
          max_usd_est: 0.1,
        },
      });
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
    return {
      row,
      score: current.state === 'completed' && gradeRecords(value, summary) ? 1 : 0,
      tokens: usage.input_tokens + usage.output_tokens,
      outputHash: digest(summary),
      attemptId: execution.id,
      runtime: execution.runtimeVersion,
      modelActual: execution.modelActual,
    };
  }

  private async scopeChecks(row: JobRow, scope: ProcedureScope, runner: AttemptRunner) {
    const model: AttemptBundle['model'] = {
      provider: this.options.provider ?? 'stub',
      model: this.options.model ?? 'script',
      fallback: null,
    };
    const runtime = await runner.runtime.capabilities();
    return this.jobs.transaction(async (tx) => {
      let violations = 0;
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
      for (const changed of [
        { ...scope, task_family: 'another-family' },
        { ...scope, app: 'another-app' },
        { ...scope, app_version: '99.0' },
      ]) {
        await tx.update(learningJob).set({ scope: changed }).where(eq(learningJob.jobId, row.id));
        violations += (await selectProcedureSkills(tx, row, model, runtime.version)).length;
      }
      await tx.update(learningJob).set({ scope }).where(eq(learningJob.jobId, row.id));
      return violations;
    });
  }
}
