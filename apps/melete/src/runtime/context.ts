import {
  type AttemptBundle,
  CONTEXT_LIMITS,
  type ContextAwareRuntimeAdapter,
  isRetrievable,
  type KnowledgeExcerpt,
  knowledgeExcerpt,
  type RuntimeAdapter,
} from '@melete/contracts';
import { loadSpace, openIndex } from '@melete/knowledge';
import type { SpaceResolver } from '../knowledge/spaces.ts';
import { withMemoryRuntime } from '../memory/context.ts';
import { lockSpace, MemoryError, type MemoryScope, type MemorySql } from '../memory/db.ts';
import { lockEventOrder } from '../memory/invalidate.ts';

type ContextOptions = {
  sql: MemorySql;
  spaces: SpaceResolver;
  scopeForJob: (jobId: string) => Promise<MemoryScope>;
};

async function legacyKnowledge(
  options: ContextOptions,
  scope: MemoryScope,
  bundle: AttemptBundle,
): Promise<KnowledgeExcerpt[]> {
  // The outer memory adapter replaces constraints with durable job state.
  if (bundle.job.constraints.public_compartment === true) return [];
  const space = await options.spaces.byId(scope.spaceId);
  if (!space) throw new MemoryError('knowledge_space_unavailable');
  const { index } = openIndex(space.paths);
  try {
    const hits = index.query(bundle.job.objective.slice(0, 2000), { limit: 20 });
    const records = new Map(
      loadSpace(space.paths).records.map((record) => [record.frontmatter.id, record]),
    );
    const claimed = await options.sql`select id from memory_claims where space_id = ${scope.spaceId}
      and id = any(${hits.map((hit) => hit.id)})`;
    const derived = await options.sql`select distinct output_id from memory_derivations
      where space_id = ${scope.spaceId} and output_kind = 'markdown'
        and output_id = any(${hits.map((hit) => hit.path)})`;
    const claimIds = new Set(claimed.map((row) => String(row.id)));
    const derivedPaths = new Set(derived.map((row) => String(row.output_id)));
    const now = new Date().toISOString().slice(0, 10);
    const selected: KnowledgeExcerpt[] = [];
    for (const hit of hits) {
      const record = records.get(hit.id);
      if (!record) continue;
      const meta = record.frontmatter;
      // Memory inspection files are derived views. Their text can only enter
      // an attempt through the Postgres eligibility and provenance checks.
      if (
        'memory_revision' in meta ||
        claimIds.has(meta.id) ||
        derivedPaths.has(record.path) ||
        meta.space !== space.name ||
        !isRetrievable(meta.status) ||
        meta.valid_from > now ||
        (meta.valid_until !== null && meta.valid_until <= now)
      )
        continue;
      const excerpt = knowledgeExcerpt.parse({
        path: record.path,
        excerpt: `${meta.title}\n${hit.excerpt}\nSource: ${meta.source.ref}`,
        key: null,
        // A Markdown assertion is inspectable source text, not a checked
        // memory claim. Even an edited asserted_by field cannot raise trust.
        origin_trust: 'external_content',
        disputed: meta.status === 'disputed',
        provenance: {
          id: meta.id,
          asserted_by: meta.asserted_by,
          observed_at: meta.observed_at,
          status: meta.status,
        },
      });
      if (
        Buffer.byteLength(JSON.stringify([...bundle.knowledge, ...selected, excerpt]), 'utf8') >
        CONTEXT_LIMITS.knowledge_tokens
      )
        continue;
      selected.push(excerpt);
    }
    return selected;
  } finally {
    index.close();
  }
}

async function recordSelection(
  sql: MemorySql,
  scope: MemoryScope,
  bundle: AttemptBundle,
  selected: KnowledgeExcerpt[],
) {
  await sql.begin(async (tx) => {
    await lockEventOrder(tx);
    await lockSpace(tx, scope, false);
    const [current] = await tx`select a.context_snapshot_ref from attempt a
      join job j on j.id = a.job_id join memory_contexts c on c.id = a.context_snapshot_ref
      where a.id = ${bundle.attempt.id} and j.id = ${bundle.attempt.job_id}
        and j.space_id = ${scope.spaceId} and a.ended_at is null
        and a.epoch = j.lease_epoch and a.epoch = ${bundle.attempt.epoch}
        and j.revision = ${bundle.attempt.revision} and c.invalidated_at is null
        and c.job_revision = j.revision for update of a, j`;
    if (!current) throw new MemoryError('stale_attempt');
    const payload = {
      kind: 'legacy_knowledge_context',
      record_ids: selected.map((item) => item.provenance.id),
      byte_length: Buffer.byteLength(JSON.stringify(selected), 'utf8'),
      memory_context_ref: String(current.context_snapshot_ref),
    };
    // This service event owns a separate key; it never consumes a runtime
    // local_seq or collides with the engine's first frame at sequence zero.
    const [event] = await tx`insert into event (job_id, attempt_id, epoch, type, payload, dedup_key)
      values (${bundle.attempt.job_id}, ${bundle.attempt.id}, ${bundle.attempt.epoch}, 'notice',
        ${JSON.stringify(payload)}::text::jsonb, ${`${bundle.attempt.id}:legacy-knowledge-context`})
      on conflict do nothing returning seq`;
    if (event) await tx`select pg_notify('melete_events', ${String(event.seq)})`;
  });
}

/** Memory owns eligibility and invalidation; legacy records remain bounded source excerpts. */
export function withDeploymentContext(
  runtime: RuntimeAdapter,
  options: ContextOptions,
): ContextAwareRuntimeAdapter {
  const legacy: RuntimeAdapter = {
    capabilities: () => runtime.capabilities(),
    async start(bundle, sink, signal) {
      const scope = await options.scopeForJob(bundle.attempt.job_id);
      const selected = await legacyKnowledge(options, scope, bundle);
      await recordSelection(options.sql, scope, bundle, selected);
      // Keep the array the memory wrapper registered for discard. Copying it
      // would leave private excerpts readable after that wrapper invalidates it.
      bundle.knowledge.push(...selected);
      return runtime.start(bundle, sink, signal);
    },
  };
  const memory = withMemoryRuntime(legacy, options.sql, options.scopeForJob);
  return {
    ...memory,
    contextInvalidated: (control) =>
      (runtime as ContextAwareRuntimeAdapter).contextInvalidated?.(control),
  };
}
