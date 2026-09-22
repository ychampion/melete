/**
 * Whose words an objective is.
 *
 * A procedure step may quote only what the correcting owner wrote. The correction
 * itself always qualifies. A job's objective qualifies only when it is a request
 * that same principal typed.
 *
 * The decision is made once, where the text is written down, and recorded on the
 * job. A job is `derived` unless the entry point that creates it is one where the
 * person types the objective (a submitted request, a chat not started from a
 * plan, a plan's own title) and says so. A routine runs an instruction long after
 * it was written, a milestone is composed from plan text, and a job that handles
 * a company's mail quotes that mail in its objective: none of those is the
 * person typing now, and a new caller that forgets to say is not either.
 *
 * It is not inferred later from the job's kind, because text travels: a
 * corrective job copies its parent's objective verbatim and would otherwise look
 * like a fresh request typed by the owner, and an evaluation arm runs a
 * model-authored variant under the owner's own principal. Each of those carries
 * the origin of the text it was given, so a routine's words stay a routine's
 * words however many jobs they pass through. A job recorded before this column
 * existed has no origin and is never quotable.
 */

export const OBJECTIVE_ORIGINS = ['owner_request', 'derived'] as const;
export type ObjectiveOrigin = (typeof OBJECTIVE_ORIGINS)[number];

/** The recorded origin, and the person: both, or the objective is not quotable. */
export function objectiveIsOwnerText(
  job: { objectiveOrigin: string | null; principalId: string | null },
  actor: string,
): boolean {
  if (job.objectiveOrigin !== 'owner_request') return false;
  return job.principalId !== null && job.principalId === actor;
}
