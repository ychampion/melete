import { type CapabilityClaims, type Receipt, receipt as receiptContract } from '@melete/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { action, attempt, connection, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { requirePrincipalCapability } from '../principals/authority.ts';
import { verifyCapability } from './capability.ts';
import { requireGenerations } from './generations.ts';
import type { JobService } from './service.ts';

/** Admission stays running-only; settlement may drain a still-current leased attempt. */
export async function requireCurrentAttempt(
  tx: Transaction,
  claims: CapabilityClaims,
  options: { settling?: boolean } = {},
) {
  const [row] = await tx.select().from(job).where(eq(job.id, claims.job_id)).for('update');
  if (
    !row ||
    row.spaceId !== claims.space_id ||
    row.leaseEpoch !== claims.epoch ||
    (row.state !== 'running' &&
      !(options.settling && ['waiting_for_approval', 'needs_reconciliation'].includes(row.state)))
  ) {
    throw new ServiceError('stale_epoch', 'This attempt no longer holds the job lease.');
  }
  const [active] = await tx
    .select()
    .from(attempt)
    .where(
      and(
        eq(attempt.id, claims.attempt_id),
        eq(attempt.jobId, row.id),
        eq(attempt.epoch, claims.epoch),
        isNull(attempt.endedAt),
      ),
    );
  if (
    !active?.leaseExpiresAt ||
    active.leaseExpiresAt.getTime() <= Date.now() ||
    active.leaseStatus !== 'active'
  ) {
    throw new ServiceError('stale_epoch', 'This attempt lease has expired.');
  }
  if (row.revision !== claims.revision || active.revision !== claims.revision) {
    throw new ServiceError('revision_mismatch', 'The job changed after this attempt started.');
  }
  await requirePrincipalCapability(tx, row, claims, active.principalId === null);
  if (
    active.principalId !== null &&
    (active.principalId !== claims.principal_id ||
      active.membershipGeneration !== claims.membership_generation)
  )
    throw new ServiceError('scope_denied', 'The attempt principal binding changed.', 403);
  await requireGenerations(tx, row.spaceId, {
    policy_generation: active.policyGeneration,
    connection_generations: active.connectionGenerations,
  });
  return { job: row, attempt: active };
}

/** A connector must have been present in this attempt's account snapshot. */
export async function requireConnectionGeneration(
  tx: Transaction,
  claims: CapabilityClaims,
  connectionId: string,
) {
  const current = await requireCurrentAttempt(tx, claims);
  const [source] = await tx.select().from(connection).where(eq(connection.id, connectionId));
  if (
    !source ||
    source.spaceId !== claims.space_id ||
    source.status !== 'active' ||
    current.attempt.connectionGenerations[connectionId] !== source.generation
  )
    throw new ServiceError(
      'context_invalidated',
      'The connection is unavailable in this attempt generation.',
    );
  return source;
}

export function withConnectionCapability<T>(
  jobs: JobService,
  token: string,
  key: string,
  connectionId: string,
  operation: (tx: Transaction, claims: CapabilityClaims) => Promise<T>,
): Promise<T> {
  return withCapability(jobs, token, key, async (tx, claims) => {
    await requireConnectionGeneration(tx, claims, connectionId);
    return operation(tx, claims);
  });
}

/** Adapters for broker tools use this wrapper, never a check followed by another transaction. */
export function withCapability<T>(
  jobs: JobService,
  token: string,
  key: string,
  operation: (tx: Transaction, claims: CapabilityClaims) => Promise<T>,
): Promise<T> {
  const claims = verifyCapability(token, key);
  return jobs.transaction(async (tx) => {
    await requireCurrentAttempt(tx, claims);
    return operation(tx, claims);
  });
}

/** Trusted connector delivery can record an old dispatch, but cannot reopen the job. */
export async function recordReceipt(
  jobs: JobService,
  attemptId: string,
  input: Receipt,
): Promise<Receipt> {
  const value = receiptContract.parse(input);
  return jobs.transaction(async (tx) => {
    const [effect] = await tx.select().from(action).where(eq(action.id, value.action_id));
    if (
      !effect ||
      effect.attemptId !== attemptId ||
      effect.connectionId !== value.connection_id ||
      !effect.dispatchedAt
    ) {
      throw new ServiceError(
        'action_not_found',
        'A receipt must identify an already dispatched action.',
        404,
      );
    }
    const row = await jobs.lock(tx, effect.jobId);
    const [execution] = await tx.select().from(attempt).where(eq(attempt.id, attemptId));
    if (!row || !execution) throw new ServiceError('action_not_found', 'Attempt not found.', 404);
    const late =
      row.leaseEpoch !== execution.epoch ||
      row.revision !== execution.revision ||
      row.state !== 'running' ||
      execution.endedAt !== null ||
      !execution.leaseExpiresAt ||
      execution.leaseExpiresAt.getTime() <= Date.now();
    const receipt = { ...value, late };
    const existing = receiptContract.safeParse(effect.receipt);
    if (existing.success) return existing.data;
    await tx.update(action).set({ receipt }).where(eq(action.id, effect.id));
    await appendEvent(tx, {
      jobId: effect.jobId,
      attemptId,
      type: 'notice',
      payload: { kind: 'receipt', ...receipt },
      dedupKey: `${effect.id}:receipt`,
    });
    return receipt;
  });
}
