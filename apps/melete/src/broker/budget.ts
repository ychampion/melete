import type { BudgetKind, CapabilityClaims } from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from './errors.ts';
import { checkAttempt, type LockedJob, lockJob, type Query, recordId } from './records.ts';

export type ReservationRequest = { kind: BudgetKind; amount: number };
export type Reservation = { id: string; kind: BudgetKind; reserved: number };

type BudgetPosition = { limit: number; attemptLimit: number; jobUsed: number; attemptUsed: number };

/** One kind's limits and what the ledger already charges. Caller holds the job row lock. */
async function positionLocked(
  tx: Query,
  job: LockedJob,
  claims: CapabilityClaims,
  kind: BudgetKind,
  modelCall: boolean,
): Promise<BudgetPosition> {
  const limit =
    kind === 'tokens'
      ? job.budget.max_output_tokens
      : kind === 'usd_est'
        ? job.budget.max_usd_est
        : modelCall
          ? job.budget.max_turns
          : job.budget.max_actions;
  const attemptLimit =
    kind === 'tokens'
      ? Math.min(limit, claims.budget.max_output_tokens)
      : kind === 'usd_est'
        ? Math.min(limit, claims.budget.max_usd_est)
        : modelCall
          ? limit
          : Math.min(limit, claims.budget.max_actions);
  if (!Number.isFinite(limit) || !Number.isFinite(attemptLimit))
    throw new BrokerFault('budget_exceeded');
  const [sum] = await tx`select
    coalesce(sum(coalesce(settled, reserved)), 0)::float8 as job_used,
    coalesce(sum(case when attempt_id = ${claims.attempt_id} then coalesce(settled, reserved) else 0 end), 0)::float8 as attempt_used
    from budget_ledger where job_id = ${job.id} and kind = ${kind}
    and (not exists(select 1 from job j where j.id = ${job.id} and j.kind in ('chat', 'routine'))
      or attempt_id in (select a.id from attempt a join job j on j.id = a.job_id where j.id = ${job.id} and a.turn_id = j.current_turn_id))
    and (${kind !== 'calls'} or (action_id is null) = ${modelCall})`;
  return {
    limit,
    attemptLimit,
    jobUsed: Number(sum?.job_used),
    attemptUsed: Number(sum?.attempt_used),
  };
}

/**
 * Whole output tokens a model call could still reserve. Advisory: it sizes a
 * limit the gateway fills in, and the reservation is checked again when made.
 */
export async function remainingOutputTokensLocked(
  tx: Query,
  job: LockedJob,
  claims: CapabilityClaims,
): Promise<number> {
  const position = await positionLocked(tx, job, claims, 'tokens', true);
  return Math.max(
    0,
    Math.floor(
      Math.min(position.limit - position.jobUsed, position.attemptLimit - position.attemptUsed),
    ),
  );
}

/** Caller holds the job row lock through policy checks, reservation, and admission. */
export async function reserveLocked(
  tx: Query,
  job: LockedJob,
  claims: CapabilityClaims,
  actionId: string | null,
  requests: ReservationRequest[],
): Promise<Reservation[]> {
  const modelCall = actionId === null;
  const totals = new Map<BudgetKind, number>();
  for (const request of requests) {
    if (!Number.isFinite(request.amount) || request.amount < 0)
      throw new BrokerFault('budget_exceeded');
    totals.set(request.kind, (totals.get(request.kind) ?? 0) + request.amount);
  }
  for (const [kind, amount] of totals) {
    const position = await positionLocked(tx, job, claims, kind, modelCall);
    if (
      position.jobUsed + amount > position.limit ||
      position.attemptUsed + amount > position.attemptLimit
    ) {
      throw new BrokerFault('budget_exceeded');
    }
  }
  const reservations: Reservation[] = [];
  for (const [kind, amount] of totals) {
    const id = recordId('led');
    await tx`insert into budget_ledger (id, job_id, attempt_id, action_id, kind, reserved)
      values (${id}, ${job.id}, ${claims.attempt_id}, ${actionId}, ${kind}, ${amount})`;
    reservations.push({ id, kind, reserved: amount });
  }
  return reservations;
}

export class BudgetService {
  constructor(readonly sql: Sql) {}

  async reserve(
    claims: CapabilityClaims,
    requests: ReservationRequest[],
    actionId: string | null = null,
  ) {
    return this.sql.begin(async (tx) => {
      const job = await lockJob(tx, claims.job_id);
      await checkAttempt(tx, job, claims);
      if (actionId) {
        const [action] = await tx`select id from action where id = ${actionId}
          and job_id = ${job.id} and attempt_id = ${claims.attempt_id}`;
        if (!action) throw new BrokerFault('action_not_found');
      }
      return reserveLocked(tx, job, claims, actionId, requests);
    });
  }

  /** Settlement releases only the unused portion; null retains an unknown charge. */
  async settle(id: string, actual: number | null): Promise<void> {
    if (actual !== null && (!Number.isFinite(actual) || actual < 0))
      throw new BrokerFault('budget_exceeded');
    await this.sql.begin(async (tx) => {
      const [ledger] = await tx`select job_id from budget_ledger where id = ${id}`;
      if (!ledger) throw new BrokerFault('budget_exceeded', 'Reservation not found');
      await lockJob(tx, ledger.job_id);
      if (actual !== null) {
        // Never overwrite a settled fact with a retried or conflicting acknowledgement.
        const [existing] = await tx`select settled from budget_ledger where id = ${id} for update`;
        if (existing?.settled !== null && Number(existing?.settled) !== actual) {
          throw new BrokerFault('budget_exceeded', 'Reservation is already settled');
        }
        await tx`update budget_ledger set settled = ${actual} where id = ${id} and settled is null`;
      }
    });
  }
}
