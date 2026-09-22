import { EVENT_ORDER_LOCK } from '../db/transaction.ts';
import { enqueue, type MemoryScope, type MemorySql, type MemoryTx, stableId } from './db.ts';

/** Process-local aborts supplement the durable fence; they are never the authority. */
const liveAttempts = new Map<string, { controller: AbortController; discard: () => void }>();
export function registerMemoryAttempt(
  attemptId: string,
  controller: AbortController,
  discard: () => void,
) {
  liveAttempts.set(attemptId, { controller, discard });
  return () => liveAttempts.delete(attemptId);
}
export async function notifyInvalidated(sql: MemorySql, spaceId: string) {
  const rows =
    await sql`select attempt_id from memory_contexts where space_id = ${spaceId} and invalidated_at is not null`;
  for (const row of rows) {
    const live = liveAttempts.get(row.attempt_id);
    if (live) {
      live.discard();
      live.controller.abort('context_invalidated');
      liveAttempts.delete(row.attempt_id);
    }
  }
}

/**
 * Job events carry the sequence stream clients read in order, so a transaction
 * that may write them takes the service's event order lock, and takes it before
 * any memory lock: the broker holds it while it reads memory for an admission.
 */
export async function lockEventOrder(tx: MemoryTx) {
  await tx`select pg_advisory_xact_lock(${EVENT_ORDER_LOCK})`;
}

/** Exact delivered dependencies, or conservative invalidation where a job has no dependency record. */
export async function invalidateDependencies(
  tx: MemoryTx,
  scope: MemoryScope,
  claimIds: string[],
  dataRevision: number,
  all = false,
) {
  await lockEventOrder(tx);
  const contexts = await tx`update memory_contexts c set invalidated_at = clock_timestamp()
    where c.space_id = ${scope.spaceId} and c.invalidated_at is null and (${all} or exists (
      select 1 from jsonb_array_elements(c.items) item where item->>'claim_id' = any(${claimIds}))) returning job_id, attempt_id`;
  const prepared =
    await tx`update memory_prepared p set stale = true, content = null where p.space_id = ${scope.spaceId} and (
    ${all} or jsonb_array_length(p.items) = 0 or exists (select 1 from jsonb_array_elements(p.items) item where item->>'claim_id' = any(${claimIds}))) returning job_id`;
  await tx`update memory_profile set stale = true where space_id = ${scope.spaceId}`;
  const knownJobs = [
    ...new Set(
      [...contexts, ...prepared]
        .map((row) => row.job_id)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  // A job that has never run an attempt was handed no memory, and an owner
  // command is never claimed by a runtime; waking either would start work
  // nobody asked for, or strand the command in a queue nothing reads.
  const jobs =
    await tx`select j.id from job j where j.space_id = ${scope.spaceId} and j.state not in ('completed','failed','cancelled')
    and j.kind <> 'command' and exists (select 1 from attempt a where a.job_id = j.id) and (
    ${all} or j.id = any(${knownJobs}) or (not exists (select 1 from memory_contexts c where c.job_id = j.id)
      and not exists (select 1 from memory_prepared p where p.job_id = j.id))) for update`;
  for (const job of jobs) {
    // Revision and epoch invalidate existing approval bindings without changing admitted effects.
    await tx`update job set revision = revision + 1, lease_epoch = lease_epoch + 1, state_version = state_version + 1, updated_at = clock_timestamp(),
      state = case when state = 'needs_reconciliation' or exists (select 1 from action where job_id = ${job.id} and status in ('admitted','dispatched','unknown','unresolved')) then 'needs_reconciliation' else 'queued' end,
      next_wake_at = clock_timestamp() where id = ${job.id}`;
    await tx`update attempt set outcome = 'fenced', ended_at = clock_timestamp() where job_id = ${job.id} and ended_at is null`;
    const id = stableId(scope.spaceId, 'dependencies_invalidated', job.id, dataRevision);
    await tx`insert into memory_invalidations (id, space_id, type, job_id, claim_ids, data_revision)
      values (${id}, ${scope.spaceId}, 'dependencies_invalidated', ${job.id}, ${JSON.stringify(claimIds)}::text::jsonb, ${dataRevision}) on conflict do nothing`;
    // The frozen event enum already supports notice. The service can consume the typed memory event in payload.
    const payload = {
      type: 'dependencies_invalidated',
      job_id: job.id,
      attempt_id: null,
      claim_ids: claimIds,
      data_revision: dataRevision,
    };
    await tx`insert into event (job_id, type, payload, dedup_key) values (${job.id}, 'notice', ${JSON.stringify(payload)}::text::jsonb, ${id}) on conflict do nothing`;
    await enqueue(tx, scope.spaceId, 'job_recompute', job.id);
  }
  for (const context of contexts) {
    const id = stableId(scope.spaceId, 'context_invalidated', context.attempt_id, dataRevision);
    await tx`insert into memory_invalidations (id, space_id, type, job_id, attempt_id, claim_ids, data_revision)
      values (${id}, ${scope.spaceId}, 'context_invalidated', ${context.job_id}, ${context.attempt_id}, ${JSON.stringify(claimIds)}::text::jsonb, ${dataRevision}) on conflict do nothing`;
    const payload = {
      type: 'context_invalidated',
      job_id: context.job_id,
      attempt_id: context.attempt_id,
      claim_ids: claimIds,
      data_revision: dataRevision,
    };
    await tx`insert into event (job_id, attempt_id, type, payload, dedup_key) values (${context.job_id}, ${context.attempt_id}, 'notice', ${JSON.stringify(payload)}::text::jsonb, ${id}) on conflict do nothing`;
  }
  return contexts.map((context) => context.attempt_id as string);
}
