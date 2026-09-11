import { type CapabilityClaims, type Receipt, receipt as receiptContract } from '@melete/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { action, attempt, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { verifyCapability } from './capability.ts';
import type { JobService } from './service.ts';

/** Broker admission holds this job lock until its action and budget reservation commit. */
export async function requireCurrentAttempt(tx: Transaction, claims: CapabilityClaims) {
  const [row] = await tx.select().from(job).where(eq(job.id, claims.job_id)).for('update');
  if (
    !row ||
    row.spaceId !== claims.space_id ||
    row.leaseEpoch !== claims.epoch ||
    row.state !== 'running'
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
  return { job: row, attempt: active };
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
