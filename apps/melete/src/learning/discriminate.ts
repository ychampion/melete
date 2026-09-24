/**
 * Whether a candidate's checks can tell a better answer from a worse one.
 *
 * A candidate authors its own checks, so a check that passes everything is the
 * easy way to look like an improvement. Before a candidate may be evaluated,
 * trusted code runs its checks over four answers whose verdicts are already
 * known: the answer the owner objected to must fail at least one, the answer
 * the correction produced must pass all of them, and an empty answer and a
 * content-free one must each fail at least one. A set of checks that cannot do
 * that measures nothing, and its evaluation would be theatre.
 *
 * This is pure. The caller supplies the recorded outputs and the action rows,
 * and stores the result on the candidate.
 */
import type { ProcedureCheck, ProcedureDiscrimination } from '@melete/contracts';
import type { CaseInput } from './case-input.ts';
import { type ActionFact, type CheckReport, runChecks } from './checks.ts';

/** Plausible in shape and empty of content: what a lazy answer to anything looks like. */
export const JUNK_OUTPUT = 'Here is the result you asked for.';

export type DiscriminationInput = {
  prior: string | null;
  corrected: string | null;
  priorActions?: readonly ActionFact[];
  correctedActions?: readonly ActionFact[];
  /** The rows the request carried, when it carried any: part of the request, not of an answer. */
  input?: CaseInput;
};

const failed = (report: CheckReport) => report.corrections;

export function discriminate(
  checks: readonly ProcedureCheck[],
  input: DiscriminationInput,
): ProcedureDiscrimination {
  // Every arm answers the same request, so all four answers are graded against
  // whatever that request carried with it.
  const carried = input.input ? { input: input.input } : {};
  const empty = failed(runChecks(checks, { output: '', ...carried }));
  const junk = failed(runChecks(checks, { output: JUNK_OUTPUT, ...carried }));
  const record = (
    status: ProcedureDiscrimination['status'],
    detail: string,
    prior: number | null,
    corrected: number | null,
  ): ProcedureDiscrimination => ({
    status,
    detail,
    prior_failed: prior,
    corrected_failed: corrected,
    empty_failed: empty,
    junk_failed: junk,
  });
  // An owner may still try a procedure with nothing to check; automated evaluation may not.
  if (!checks.length) return record('none', 'no_checks', null, null);
  if (input.prior === null) return record('failed', 'prior_output_unavailable', null, null);
  if (input.corrected === null) return record('failed', 'corrected_output_unavailable', null, null);
  const prior = failed(
    runChecks(checks, { output: input.prior, actions: input.priorActions, ...carried }),
  );
  const corrected = failed(
    runChecks(checks, { output: input.corrected, actions: input.correctedActions, ...carried }),
  );
  if (prior === 0) return record('failed', 'prior_output_passes', prior, corrected);
  if (corrected > 0) return record('failed', 'corrected_output_fails', prior, corrected);
  if (empty === 0) return record('failed', 'empty_output_passes', prior, corrected);
  if (junk === 0) return record('failed', 'junk_output_passes', prior, corrected);
  return record('passed', 'discriminates', prior, corrected);
}
