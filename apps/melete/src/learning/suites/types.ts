/**
 * An evaluation suite supplies the cases a candidate is run against and the
 * grader that scores each run. The evaluator owns everything else: the isolated
 * spaces, the paired baseline and candidate arms, the memory conformance guard,
 * the gate, and the evidence rows.
 *
 * A suite never hands a case a grader of its own: grading is trusted code over
 * the run's output and actions, and every module a suite depends on is hashed
 * into the evidence, so editing a fixture or a grader invalidates what it proved.
 */
import type { ProcedureCheck } from '@melete/contracts';
import type { Transaction } from '../../db/transaction.ts';
import type { ActionFact, CheckReport, RecordRow } from '../checks.ts';
import { runChecks } from '../checks.ts';
import type { ProcedureScope } from '../contracts.ts';
import type { EpisodeRow } from '../episodes.ts';
import type { Candidate } from '../procedures.ts';

export type EvaluationCase = {
  /** Becomes the gate row's template, and the evaluation job's template id. */
  template: string;
  objective: string;
  /** Where the case came from; a phase needs at least one held-out history case. */
  origin: 'fixture' | 'history' | 'variant';
  input?: { columns: string[]; rows: RecordRow[] };
  /** Fixture-declared identities. Only a bundled suite supplies these. */
  expected?: { row_ids: string[] };
};

export type EvaluationPhase = 'validation' | 'sealed_final';
export type PhaseCases = { cases: readonly EvaluationCase[]; memory: readonly string[] };
export type SuiteCases = {
  validation: PhaseCases;
  /** Resolved only after selection commits; `seed` is the selection's evaluation id. */
  sealedFinal(seed: string): Promise<PhaseCases>;
};
export type SuiteRun = { output: string; actions: readonly ActionFact[]; state: string };

export interface EvaluationSuite {
  readonly id: string;
  /** Repository-relative paths, all hashed into every evaluation's suite hash. */
  readonly modules: readonly string[];
  supports(scope: ProcedureScope): boolean;
  plan(input: {
    tx: Transaction;
    ownerId: string;
    candidate: Candidate;
    source: EpisodeRow;
  }): Promise<SuiteCases & { candidate: Candidate }>;
  grade(value: EvaluationCase, run: SuiteRun, candidate: Candidate): CheckReport;
}

/** An unfinished run answered nothing, so every check it was held to counts as a correction. */
export function gradeFinished(
  checks: readonly ProcedureCheck[],
  value: EvaluationCase,
  run: SuiteRun,
): CheckReport {
  if (run.state !== 'completed') {
    const results = checks.map((check) => ({
      kind: check.kind,
      passed: false,
      detail: `the job ended ${run.state}`,
    }));
    return { score: 0, corrections: results.length, results };
  }
  return runChecks(checks, {
    output: run.output,
    actions: run.actions,
    ...(value.input ? { input: value.input } : {}),
    ...(value.expected ? { expected: value.expected } : {}),
  });
}
