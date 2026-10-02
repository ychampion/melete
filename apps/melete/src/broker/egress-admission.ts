/**
 * Admission for writes the egress relay originates.
 *
 * A command in the agent's computer that changes something with a connected
 * account does it with an ordinary request; the relay holds that request open
 * and brings it here. It goes through the same proposal and admission as any
 * connector action: the tool's scope, an intent key over the job, its
 * revision, the connection, the tool and the canonical request, the effect
 * class `write_external`, auto-review's person tier, standing rules, origin
 * checks, the budget and the receipt. The only difference is who dispatches:
 * the relay forwards the request it holds, once.
 *
 * What the person approves is bound to that exact request. If they answer
 * while the request is held, it goes through inside the same command. If not,
 * the command is told to wait, the action stays waiting for approval with
 * this attempt, and after approval the agent runs the same command again: the
 * relay classifies the request again, finds the approved action by its intent
 * key, and dispatches it once. A third run finds it done, and an answer that
 * was lost after forwarding is never sent again.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type CapabilityClaims,
  canonicalizePayload,
  type EffectProposalResponse,
  type JsonObject,
} from '@melete/contracts';
import {
  type ClassifiedWrite,
  type CredentialAdapterId,
  egressWriteTool,
} from '../egress/adapters/types.ts';
import { type ForwardResult, relaying } from '../egress/connector.ts';
import type { EgressAttribution } from '../egress/tokens.ts';
import { BrokerFault } from './errors.ts';
import type { BrokerService } from './service.ts';

export type EgressWriteInput = {
  attribution: EgressAttribution;
  connectionId: string;
  adapter: CredentialAdapterId;
  write: ClassifiedWrite;
  /** How long the request may be held for an answer; zero asks and returns at once. */
  holdMs: number;
  /** Sends the held request upstream. Called at most once, and only once admitted. */
  forward: () => Promise<ForwardResult>;
  /** The computer hung up: stop holding. */
  signal?: AbortSignal;
  /** Whether the command is still running; once it is not, nothing more is sent for it. */
  live?: () => boolean;
};

export type EgressWriteOutcome =
  | { kind: 'sent'; actionId: string; result: ForwardResult }
  | { kind: 'waiting'; actionId: string; message: string }
  | { kind: 'refused'; status: 403 | 409; message: string; actionId: string | null };

export type EgressAdmission = (input: EgressWriteInput) => Promise<EgressWriteOutcome>;

/** The canonical payload of a write: the adapter's request, what the card shows, and how far it reaches. */
export function egressPayload(write: ClassifiedWrite): JsonObject {
  return {
    ...write.payload,
    operation: write.operation,
    destructive: write.destructive,
    summary: { title: write.summary.title, facts: write.summary.facts },
  };
}

/**
 * The claims the command's own attempt holds, read back from the attempt the
 * command's token names. Admission then checks them exactly as it checks the
 * attempt's own: the epoch, the revision, the principal and the membership.
 * The scopes are the connection's own, as a live, principal-bound attempt
 * would see them.
 */
async function relayClaims(
  broker: BrokerService,
  attribution: EgressAttribution,
  connectionId: string,
): Promise<CapabilityClaims> {
  if (!attribution.jobId || !attribution.attemptId)
    throw new BrokerFault(
      'scope_denied',
      'This command is not part of a conversation, so its changes cannot be asked for.',
    );
  // The attempt that proposed the command, or, when the command was approved
  // and carried out by a later attempt of the same job, that live attempt: an
  // action keeps the attempt that proposed it. Only an attempt at the job's
  // current revision takes over: one at an older revision never does.
  const [row] = await broker.sql`select j.id as job_id, j.space_id, j.budget, a.id as attempt_id,
      a.epoch, a.revision, a.principal_id, a.membership_generation
    from attempt a join job j on j.id = a.job_id
    where j.id = ${attribution.jobId} and a.outcome is null
      and (a.id = ${attribution.attemptId}
        or (a.epoch = j.lease_epoch and a.revision = j.revision))
    order by (a.id = ${attribution.attemptId}) desc, a.epoch desc limit 1`;
  if (!row) throw new BrokerFault('stale_epoch', 'The work that ran this command has ended.');
  const [connection] = await broker.sql`select scopes from connection
    where id = ${connectionId} and space_id = ${row.space_id} and status = 'active'`;
  if (!connection)
    throw new BrokerFault('unknown_connection', 'This account is no longer connected.');
  const budget = row.budget as Record<string, number>;
  return {
    ...(row.principal_id
      ? {
          principal_id: String(row.principal_id),
          membership_generation: Number(row.membership_generation ?? 0),
        }
      : {}),
    job_id: String(row.job_id),
    attempt_id: String(row.attempt_id),
    space_id: String(row.space_id),
    epoch: Number(row.epoch),
    revision: Number(row.revision),
    scopes: connection.scopes as string[],
    budget: {
      max_actions: Number(budget.max_actions ?? 0),
      max_output_tokens: Number(budget.max_output_tokens ?? 0),
      max_usd_est: Number(budget.max_usd_est ?? 0),
    },
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

const STILL_WAITING = new Set(['proposed', 'needs_approval']);

export function egressAdmission(
  broker: BrokerService,
  options: { pollMs?: number } = {},
): EgressAdmission {
  const pollMs = options.pollMs ?? 1_000;
  return async (input) => {
    const kind = egressWriteTool(input.adapter);
    const payload = egressPayload(input.write);
    const hash = canonicalizePayload(payload).hash;
    let claims: CapabilityClaims;
    try {
      claims = await relayClaims(broker, input.attribution, input.connectionId);
    } catch (error) {
      if (error instanceof BrokerFault)
        return { kind: 'refused', status: 403, message: error.message, actionId: null };
      throw error;
    }
    const propose = async () => {
      const { value, forwarded } = await relaying(hash, input.forward, () =>
        broker.propose(claims, { kind, connection_id: input.connectionId, payload }),
      );
      return { view: value, forwarded };
    };
    let attempt: { view: EffectProposalResponse; forwarded: ForwardResult | undefined };
    try {
      attempt = await propose();
    } catch (error) {
      if (error instanceof BrokerFault)
        return { kind: 'refused', status: 403, message: error.message, actionId: null };
      throw error;
    }
    if (attempt.forwarded)
      return { kind: 'sent', actionId: attempt.view.action_id, result: attempt.forwarded };
    const actionId = attempt.view.action_id;
    let status: string = attempt.view.status;
    // Held while the person can still answer inside this command.
    const deadline = Date.now() + Math.max(0, input.holdMs);
    while (STILL_WAITING.has(status) && Date.now() < deadline && !input.signal?.aborted) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      const [row] = await broker.sql`select status from action where id = ${actionId}`;
      status = String(row?.status ?? 'failed');
      if (status !== 'approved') continue;
      // Approved, but the command hung up or ended meanwhile: it is sent on the next run.
      if (input.signal?.aborted || input.live?.() === false) break;
      try {
        attempt = await propose();
      } catch (error) {
        if (error instanceof BrokerFault)
          return { kind: 'refused', status: 403, message: error.message, actionId };
        throw error;
      }
      if (attempt.forwarded) return { kind: 'sent', actionId, result: attempt.forwarded };
      status = attempt.view.status;
    }
    if (STILL_WAITING.has(status)) {
      const title = String((payload.summary as { title?: unknown }).title ?? 'this change');
      return {
        kind: 'waiting',
        actionId,
        message: `Waiting for your approval in Melete: ${title}. Run the same command again once it is approved.`,
      };
    }
    if (status === 'denied')
      return {
        kind: 'refused',
        status: 403,
        message: 'This change was denied in Melete. It was not sent, and it will not be.',
        actionId,
      };
    // Done, failed, or uncertain: the recorded disposition, never a second send.
    const settled = attempt.view.status === status ? attempt.view : null;
    return {
      kind: 'refused',
      status: 409,
      message:
        settled?.message ??
        `This change is ${status} in Melete, and it was not sent again from this command.`,
      actionId,
    };
  };
}
