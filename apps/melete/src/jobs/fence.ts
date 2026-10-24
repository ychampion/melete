import { type CapabilityClaims, type Receipt, receipt as receiptContract } from '@melete/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { databaseNow } from '../db/clock.ts';
import { action, attempt, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { requirePrincipalCapability } from '../principals/authority.ts';
import { verifyCapability } from './capability.ts';
import { assertCurrentGenerations, requireGenerations } from './generations.ts';
import type { JobService } from './service.ts';

type CurrentRecords = {
  job: typeof job.$inferSelect;
  attempt: typeof attempt.$inferSelect;
};

/**
 * Only runtime record operations may share these reads: they change events,
 * attempt cursors and turn text, never space or membership authority. The
 * authority reader keeps its space and membership share locks until commit.
 * Every job, attempt and claimed identity is still checked for each operation.
 */
export class FenceReads {
  private readonly authority = new Map<string, ReturnType<typeof requirePrincipalCapability>>();

  constructor(private readonly transaction: Transaction) {}

  requireAuthority(
    tx: Transaction,
    row: CurrentRecords['job'],
    claims: CapabilityClaims,
    legacyPersonal: boolean,
  ): ReturnType<typeof requirePrincipalCapability> {
    if (tx !== this.transaction) throw new Error('Fence reads belong to another transaction.');
    // Object properties distinguish an absent legacy claim from an explicit
    // null, and every authority input participates in the identity.
    const key = JSON.stringify({
      spaceId: row.spaceId,
      principalId: row.principalId,
      claimedPrincipal: claims.principal_id,
      membershipGeneration: claims.membership_generation,
      legacyPersonal,
    });
    let read = this.authority.get(key);
    if (!read) {
      read = requirePrincipalCapability(tx, row, claims, legacyPersonal).then(
        (access) => {
          // The installation's singleton owner identity is never changed or
          // removed. Before setup creates it, a null fallback is not stable.
          if (access.ownerId === null) this.authority.delete(key);
          return access;
        },
        (error: unknown) => {
          this.authority.delete(key);
          throw error;
        },
      );
      this.authority.set(key, read);
    }
    return read;
  }
}

/** The job fence applies before reading or trusting an attempt. */
function requireCurrentJob(
  row: CurrentRecords['job'] | undefined,
  claims: CapabilityClaims,
  settling: boolean,
): asserts row is CurrentRecords['job'] {
  if (
    !row ||
    row.id !== claims.job_id ||
    row.spaceId !== claims.space_id ||
    row.leaseEpoch !== claims.epoch ||
    (row.state !== 'running' &&
      !(settling && ['waiting_for_approval', 'needs_reconciliation'].includes(row.state)))
  ) {
    throw new ServiceError('stale_epoch', 'This attempt no longer holds the job lease.');
  }
}

/** Admission stays running-only; settlement may drain a still-current leased attempt. */
export async function requireCurrentAttempt(
  tx: Transaction,
  claims: CapabilityClaims,
  options: { settling?: boolean } = {},
) {
  const [row] = await tx.select().from(job).where(eq(job.id, claims.job_id)).for('update');
  requireCurrentJob(row, claims, Boolean(options.settling));
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
  return requireCurrentAttemptFrom(tx, claims, { job: row, attempt: active }, options);
}

/**
 * Validate records read in this transaction after it locked the job. Runtime
 * recording needs those same rows even for a late result; checking them again
 * must retain every fence without sending both reads through the loop twice.
 */
export async function requireCurrentAttemptFrom(
  tx: Transaction,
  claims: CapabilityClaims,
  records: { job: CurrentRecords['job']; attempt: CurrentRecords['attempt'] | undefined },
  options: { settling?: boolean } = {},
  reads?: FenceReads,
) {
  const row = records.job;
  requireCurrentJob(row, claims, Boolean(options.settling));
  const active = records.attempt;
  if (
    active?.id !== claims.attempt_id ||
    active.jobId !== row.id ||
    active.epoch !== claims.epoch ||
    active.endedAt !== null ||
    !active?.leaseExpiresAt ||
    active.leaseExpiresAt.getTime() <= (await databaseNow(tx)).getTime() ||
    active.leaseStatus !== 'active'
  ) {
    throw new ServiceError('stale_epoch', 'This attempt lease has expired.');
  }
  if (row.revision !== claims.revision || active.revision !== claims.revision) {
    throw new ServiceError('revision_mismatch', 'The job changed after this attempt started.');
  }
  const access = await (reads
    ? reads.requireAuthority(tx, row, claims, active.principalId === null)
    : requirePrincipalCapability(tx, row, claims, active.principalId === null));
  if (
    active.principalId !== null &&
    (active.principalId !== claims.principal_id ||
      active.membershipGeneration !== claims.membership_generation)
  )
    throw new ServiceError('scope_denied', 'The attempt principal binding changed.', 403);
  // Authority already holds a share lock on this space row until commit.
  const checkGenerations = reads ? assertCurrentGenerations : requireGenerations;
  await checkGenerations(
    tx,
    row.spaceId,
    {
      policy_generation: active.policyGeneration,
      connection_generations: active.connectionGenerations,
    },
    access.space.policyGeneration,
  );
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
      execution.leaseExpiresAt.getTime() <= (await databaseNow(tx)).getTime();
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
