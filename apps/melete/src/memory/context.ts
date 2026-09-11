import {
  type AttemptBundle,
  type ContextRecord,
  claimHandleOf,
  contextRecord,
  type RecallResult,
  type RuntimeAdapter,
  recallRequest,
} from '@melete/contracts';
import { eligibleRevision } from './claims.ts';
import { iso, lockSpace, MemoryError, type MemoryScope, type MemorySql, newId } from './db.ts';
import { notifyInvalidated, registerMemoryAttempt } from './invalidate.ts';
import { markRepairBriefsDelivered, pendingRepairBriefs } from './outputs.ts';
import { asKnowledge, effectiveAudience, type RecallOptions, recall } from './recall.ts';

export async function recordAttemptContext(
  sql: MemorySql,
  scope: MemoryScope,
  attemptId: string,
  jobId: string,
  result: RecallResult,
): Promise<ContextRecord> {
  return sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope, false);
    const audience = await effectiveAudience(tx, scope, jobId);
    const [attempt] =
      await tx`select a.epoch, a.ended_at, j.lease_epoch, j.revision from attempt a join job j on j.id = a.job_id
      where a.id = ${attemptId} and j.id = ${jobId} and j.space_id = ${scope.spaceId} for update of a, j`;
    if (!attempt || attempt.ended_at || attempt.epoch !== attempt.lease_epoch)
      throw new MemoryError('stale_attempt');
    if (
      result.snapshot &&
      (space.data_revision !== result.snapshot.data_revision ||
        space.policy_generation !== result.snapshot.policy_generation ||
        space.access_generation !== result.snapshot.access_generation)
    )
      throw new MemoryError('stale_context');
    if (audience.publicCompartment && result.items.length) throw new MemoryError('scope_denied');
    for (const item of result.items)
      if (!(await eligibleRevision(tx, scope, item.claim_id, item.revision)))
        throw new MemoryError('stale_context');
    const [prior] = await tx`select id from memory_contexts where attempt_id = ${attemptId}`;
    if (prior) throw new MemoryError('context_already_recorded');
    const context: ContextRecord = {
      id: newId('ctx'),
      space_id: scope.spaceId,
      job_id: jobId,
      attempt_id: attemptId,
      job_revision: audience.jobRevision,
      policy_generation: space.policy_generation as number,
      data_revision: space.data_revision as number,
      access_generation: space.access_generation as number,
      audience: audience.audiences as ContextRecord['audience'],
      purpose: audience.purpose,
      items: result.items.map((item) => ({
        claim_id: item.claim_id,
        revision: item.revision,
        handle: claimHandleOf(item.claim_id, item.revision),
        key: item.key,
        origin_trust: item.origin_trust,
        sources: item.sources,
      })),
      unattributed: [],
      disputed_keys: result.disputed_keys,
      recipe: result.recipe,
      token_budget: result.token_budget,
      recall_status: result.status,
      invalidated_at: null,
      created_at: new Date().toISOString(),
    };
    await tx`insert into memory_contexts (id, space_id, job_id, attempt_id, job_revision, policy_generation, data_revision, access_generation, audience, purpose, items, recipe, token_budget, recall_status, disputed_keys)
      values (${context.id}, ${scope.spaceId}, ${jobId}, ${attemptId}, ${context.job_revision}, ${context.policy_generation}, ${context.data_revision}, ${context.access_generation},
      ${JSON.stringify(context.audience)}::text::jsonb, ${context.purpose}, ${JSON.stringify(context.items)}::text::jsonb, ${context.recipe}, ${JSON.stringify(context.token_budget)}::text::jsonb, ${context.recall_status},
      ${JSON.stringify(context.disputed_keys)}::text::jsonb)`;
    await tx`update attempt set context_snapshot_ref = ${context.id} where id = ${attemptId}`;
    await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
      values (${scope.spaceId}, 'job', ${jobId}, ${String(audience.jobRevision)}, 'context', ${context.id}, '1') on conflict do nothing`;
    for (const item of context.items) {
      await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'claim', ${item.claim_id}, ${String(item.revision)}, 'context', ${context.id}, '1') on conflict do nothing`;
      for (const source of item.sources)
        await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
        values (${scope.spaceId}, 'source', ${source.source_id}, ${source.source_version}, 'context', ${context.id}, '1') on conflict do nothing`;
    }
    return context;
  });
}
/** Call before a consequential use; a normal unrelated fact does not invalidate this context. */
export async function assertContextCurrent(sql: MemorySql, scope: MemoryScope, attemptId: string) {
  return sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope, false);
    const [row] =
      await tx`select c.*, j.revision as actual_job_revision, j.lease_epoch, a.epoch, a.ended_at from memory_contexts c
      join job j on j.id = c.job_id join attempt a on a.id = c.attempt_id where c.attempt_id = ${attemptId} and c.space_id = ${scope.spaceId}`;
    if (
      !row ||
      row.invalidated_at ||
      row.ended_at ||
      row.epoch !== row.lease_epoch ||
      row.job_revision !== row.actual_job_revision ||
      row.access_generation !== space.access_generation ||
      row.policy_generation !== space.policy_generation
    )
      throw new MemoryError('context_invalidated');
    for (const item of row.items as ContextRecord['items']) {
      if (!(await eligibleRevision(tx, scope, item.claim_id, item.revision)))
        throw new MemoryError('context_invalidated');
      const [head] = await tx`select head_revision from memory_claims where id = ${item.claim_id}`;
      if (head?.head_revision !== item.revision) throw new MemoryError('context_invalidated');
    }
    const context = contextRecord.parse({
      id: row.id,
      space_id: row.space_id,
      job_id: row.job_id,
      attempt_id: row.attempt_id,
      job_revision: row.job_revision,
      policy_generation: row.policy_generation,
      access_generation: row.access_generation,
      data_revision: row.data_revision,
      audience: row.audience,
      purpose: row.purpose,
      items: row.items,
      recipe: row.recipe,
      token_budget: row.token_budget,
      recall_status: row.recall_status,
      unattributed: row.unattributed,
      disputed_keys: row.disputed_keys,
      invalidated_at: null,
      created_at: iso(row.created_at),
    });
    return context;
  });
}
export async function assembleAttemptKnowledge(
  sql: MemorySql,
  scope: MemoryScope,
  attemptId: string,
  jobId: string,
  query: string,
  options: RecallOptions = {},
) {
  for (let retry = 0; retry < 3; retry++) {
    const result = await recall(
      sql,
      scope,
      recallRequest.parse({ job_id: jobId, query: query.slice(0, 2000) }),
      {
        ...options,
        includeProfile: true,
      },
    );
    try {
      const context = await recordAttemptContext(sql, scope, attemptId, jobId, result);
      return { knowledge: result.items.map(asKnowledge), context, recall: result };
    } catch (error) {
      if (!(error instanceof MemoryError) || error.code !== 'stale_context' || retry === 2)
        throw error;
    }
  }
  throw new MemoryError('stale_context');
}

/** Existing runtime contract stays unchanged; aborted context is discarded rather than resumed. */
export function withMemoryRuntime(
  runtime: RuntimeAdapter,
  sql: MemorySql,
  scopeForJob: (jobId: string) => Promise<MemoryScope>,
  options: RecallOptions = {},
): RuntimeAdapter {
  return {
    capabilities: () => runtime.capabilities(),
    async start(bundle, sink, signal) {
      const scope = await scopeForJob(bundle.attempt.job_id);
      const prepared = await assembleAttemptKnowledge(
        sql,
        scope,
        bundle.attempt.id,
        bundle.attempt.job_id,
        bundle.job.objective,
        options,
      );
      const [job] =
        await sql`select constraints, revision from job where id = ${bundle.attempt.job_id} and space_id = ${scope.spaceId}`;
      if (
        !job ||
        job.revision !== bundle.attempt.revision ||
        prepared.context.job_revision !== bundle.attempt.revision
      )
        throw new MemoryError('stale_attempt');
      // E1. What a correction broke since the last attempt, named precisely: the
      // handle that moved, the value before and after, and the outputs that cited
      // it. This is the reason the next attempt does not start from zero.
      const briefs = await pendingRepairBriefs(sql, scope, bundle.attempt.job_id);
      // Accepted action constraints come directly from job state, outside optional memory trimming.
      const next: AttemptBundle = {
        ...bundle,
        job: { ...bundle.job, constraints: job.constraints },
        inputs: { ...bundle.inputs, repair_briefs: briefs },
        knowledge: prepared.knowledge,
      };
      const controller = new AbortController();
      const unregister = registerMemoryAttempt(bundle.attempt.id, controller, () => {
        next.knowledge.length = 0;
      });
      const timer = setInterval(() => {
        void notifyInvalidated(sql, scope.spaceId).catch(() =>
          controller.abort('context_check_unavailable'),
        );
      }, 100);
      timer.unref();
      try {
        await assertContextCurrent(sql, scope, bundle.attempt.id);
        const outcome = await runtime.start(
          next,
          {
            async emit(event) {
              await assertContextCurrent(sql, scope, bundle.attempt.id);
              await sink.emit(event);
            },
          },
          AbortSignal.any([signal, controller.signal]),
        );
        await assertContextCurrent(sql, scope, bundle.attempt.id);
        // Delivered only once the attempt actually finished holding them.
        await markRepairBriefsDelivered(
          sql,
          scope,
          briefs.map((brief) => brief.id),
        );
        return outcome;
      } finally {
        clearInterval(timer);
        unregister();
        next.knowledge.length = 0;
      }
    },
  };
}
