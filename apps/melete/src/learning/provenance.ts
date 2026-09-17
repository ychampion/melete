/**
 * Whose words an objective is.
 *
 * A procedure step may quote only what the correcting owner wrote. The correction
 * itself always qualifies. A job's objective qualifies only when it is a request
 * that same principal typed: a routine runs an instruction on a schedule long after
 * it was written, a milestone objective is composed from plan text, a chat started
 * from a plan carries that plan's objective, and in a shared space another member
 * may have written the objective the owner is correcting. In all of those cases the
 * objective still decides where a procedure applies, but it is never quoted.
 */

/** Job kinds whose objective is the text of a request, as typed. */
export const DIRECT_REQUEST_KINDS = ['responsibility', 'chat', 'plan'] as const;

export function objectiveIsOwnerText(
  job: { kind: string; principalId: string | null; planId: string | null },
  actor: string,
): boolean {
  if (!(DIRECT_REQUEST_KINDS as readonly string[]).includes(job.kind)) return false;
  if (job.kind === 'chat' && job.planId) return false;
  return job.principalId !== null && job.principalId === actor;
}
