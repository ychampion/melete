import { randomBytes } from 'node:crypto';
import {
  type Action,
  action,
  type CapabilityClaims,
  type JobBudget,
  type JobConstraints,
} from '@melete/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { BrokerFault } from './errors.ts';

export type Query = Sql | TransactionSql;
export type LockedJob = {
  id: string;
  space_id: string;
  state: string;
  revision: number;
  lease_epoch: number;
  budget: JobBudget;
  constraints: JobConstraints;
};

/** ULID bytes keep every generated record inside the frozen prefixed-id schemas. */
export function recordId(prefix: string): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value = (BigInt(Date.now()) << 80n) | BigInt(`0x${randomBytes(10).toString('hex')}`);
  let encoded = '';
  for (let i = 0; i < 26; i++) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

export async function lockJob(tx: Query, id: string): Promise<LockedJob> {
  const [job] = await tx<LockedJob[]>`select * from job where id = ${id} for update`;
  if (!job) throw new BrokerFault('stale_epoch', 'Job is not available');
  return job;
}

export async function checkAttempt(
  tx: Query,
  job: LockedJob,
  claims: CapabilityClaims,
): Promise<void> {
  if (
    job.lease_epoch !== claims.epoch ||
    ['cancelled', 'failed', 'completed'].includes(job.state) ||
    claims.exp <= Math.floor(Date.now() / 1000)
  )
    throw new BrokerFault('stale_epoch');
  if (job.revision !== claims.revision) throw new BrokerFault('revision_mismatch');
  if (job.space_id !== claims.space_id) throw new BrokerFault('scope_denied');
  const [attempt] =
    await tx`select job_id, epoch, outcome from attempt where id = ${claims.attempt_id}`;
  if (
    !attempt ||
    attempt.job_id !== job.id ||
    attempt.epoch !== claims.epoch ||
    attempt.outcome !== null
  ) {
    throw new BrokerFault('stale_epoch');
  }
}

export function actionFromRow(row: Record<string, unknown>): Action {
  const normalized = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      // Drizzle's shared postgres.js client returns timestamp text; normalize at the read boundary.
      value !== null &&
      ['created_at', 'dispatched_at', 'resolved_at', 'retry_after_at'].includes(key)
        ? new Date(value as string | Date).toISOString()
        : value,
    ]),
  );
  return action.parse(normalized);
}

export async function loadAction(tx: Query, id: string, lock = false): Promise<Action> {
  const rows = lock
    ? await tx`select * from action where id = ${id} for update`
    : await tx`select * from action where id = ${id}`;
  if (!rows[0]) throw new BrokerFault('action_not_found');
  return actionFromRow(rows[0]);
}

export async function appendEvent(
  tx: Query,
  jobId: string,
  attemptId: string | null,
  type: string,
  payload: Record<string, unknown>,
  dedupKey = `broker:${recordId('evt')}`,
): Promise<void> {
  await tx`insert into event (job_id, attempt_id, type, payload, dedup_key)
    values (${jobId}, ${attemptId}, ${type}, ${JSON.stringify(payload)}::jsonb, ${dedupKey})
    on conflict (dedup_key) do nothing`;
}
