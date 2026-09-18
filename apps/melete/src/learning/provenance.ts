/**
 * Whose words an objective is.
 *
 * A procedure step may quote only what the correcting owner wrote. The correction
 * itself always qualifies. A job's objective qualifies only when it is a request
 * that same principal typed.
 *
 * The decision is made once, where the text is written down, and recorded on the
 * job. It is not inferred later from the job's kind, because text travels: a
 * corrective job copies its parent's objective verbatim and would otherwise look
 * like a fresh request typed by the owner, and an evaluation arm runs a
 * model-authored variant under the owner's own principal. Each of those carries
 * the origin of the text it was given, so a routine's words stay a routine's
 * words however many jobs they pass through. A job recorded before this column
 * existed has no origin and is never quotable.
 */

/** Job kinds whose objective is the text of a request, as typed into it. */
export const DIRECT_REQUEST_KINDS = ['responsibility', 'chat', 'plan'] as const;
export const OBJECTIVE_ORIGINS = ['owner_request', 'derived'] as const;
export type ObjectiveOrigin = (typeof OBJECTIVE_ORIGINS)[number];

/**
 * What to record for a job being created from scratch. A routine runs an
 * instruction on a schedule long after it was written, a milestone objective is
 * composed from plan text, and a chat started from a plan carries that plan's
 * objective: none of those is the person typing now.
 */
export function recordedObjectiveOrigin(job: {
  kind?: string | null;
  planId?: string | null;
}): ObjectiveOrigin {
  const kind = job.kind ?? 'responsibility';
  if (!(DIRECT_REQUEST_KINDS as readonly string[]).includes(kind)) return 'derived';
  return kind === 'chat' && job.planId ? 'derived' : 'owner_request';
}

/** The recorded origin, and the person: both, or the objective is not quotable. */
export function objectiveIsOwnerText(
  job: { objectiveOrigin: string | null; principalId: string | null },
  actor: string,
): boolean {
  if (job.objectiveOrigin !== 'owner_request') return false;
  return job.principalId !== null && job.principalId === actor;
}
