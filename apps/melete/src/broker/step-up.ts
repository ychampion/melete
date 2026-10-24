/**
 * The person's own confirmation for a money move.
 *
 * A money move is allowed only with a step-up made for it: the signed-in
 * person proves it is them (their password; a passkey later) and is handed a
 * token bound to themselves, one approval, its action and the exact payload
 * hash. The token lasts two minutes, is kept only as a hash, and is spent by
 * the one Allow it was made for, in the same transaction that records the
 * Allow. Admission and every dispatch check again that the approval carries a
 * spent step-up for these bytes, by the person who answered, so an Allow
 * written any other way (a typed "yes", the agent's own claim, a standing
 * rule, a reviewer, another service path) moves nothing.
 */
import { createHash, randomBytes } from 'node:crypto';
import { type Query, recordId } from './records.ts';

/** How long a confirmation may wait before it is spent. */
export const STEP_UP_TTL_MS = 2 * 60_000;

/** What a refusal says when a money move has no confirmation it can count. */
export const STEP_UP_NEEDED =
  'This moves money, so it needs you to confirm it is you, with your password, when you allow it.';

export type StepUpMethod = 'password' | 'passkey' | 'oidc';

/** How a token is kept: only its digest. */
export const stepUpDigest = (token: string) => createHash('sha256').update(token).digest('hex');
const digest = stepUpDigest;

/**
 * Record a confirmation the caller has just verified, and return its token.
 * The caller proves the person; this binds what they proved it for.
 */
export async function issueStepUp(
  tx: Query,
  input: {
    principalId: string;
    approvalId: string;
    actionId: string;
    payloadHash: string;
    method: StepUpMethod;
  },
): Promise<{ token: string; expires_at: string }> {
  const token = randomBytes(32).toString('base64url');
  const [row] = await tx`insert into step_up (id, token_hash, principal_id, approval_id,
      action_id, payload_hash, method, expires_at)
    values (${recordId('stp')}, ${digest(token)}, ${input.principalId}, ${input.approvalId},
      ${input.actionId}, ${input.payloadHash}, ${input.method},
      clock_timestamp() + make_interval(secs => ${STEP_UP_TTL_MS / 1000}))
    returning expires_at`;
  return { token, expires_at: new Date(row?.expires_at as string | Date).toISOString() };
}

/**
 * Spend a token for exactly this answer: one update that succeeds only for an
 * unspent, unexpired token made by this person for this approval, action and
 * payload. Returns its id, or null when it does not count (replayed, expired,
 * someone else's, or made for something else).
 */
export async function spendStepUp(
  tx: Query,
  input: {
    token: string | undefined;
    principalId: string | null | undefined;
    approvalId: string;
    actionId: string;
    payloadHash: string;
  },
): Promise<string | null> {
  if (!input.token || !input.principalId) return null;
  const [row] = await tx`update step_up set used_at = clock_timestamp()
    where token_hash = ${digest(input.token)} and principal_id = ${input.principalId}
      and approval_id = ${input.approvalId} and action_id = ${input.actionId}
      and payload_hash = ${input.payloadHash}
      and used_at is null and expires_at > clock_timestamp()
    returning id`;
  return row ? String(row.id) : null;
}

/**
 * Whether this approval's Allow was given with a confirmation spent for it:
 * the same approval, action and payload, by the person recorded as deciding.
 */
export async function stepUpHolds(
  tx: Query,
  approvalId: string | null | undefined,
  action: { id: string; payload_hash: string },
): Promise<boolean> {
  if (!approvalId) return false;
  const [row] = await tx`select 1 from approval p join step_up s on s.id = p.step_up_id
    where p.id = ${approvalId} and p.action_id = ${action.id} and p.decision = 'approved'
      and p.payload_hash = ${action.payload_hash} and s.approval_id = p.id
      and s.action_id = p.action_id and s.payload_hash = p.payload_hash
      and s.principal_id = p.decided_by and s.used_at is not null`;
  return Boolean(row);
}
