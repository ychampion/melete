import type { IndexManifest } from '@melete/contracts';
import { eligibleRevision, sourceExcerpts } from './claims.ts';
import {
  generation,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
} from './db.ts';

export const LEXICAL_RECIPE = 'simple-lexical-v1';
export const MAX_INDEX_ROWS = 2000;
export type EmbeddingProvider = {
  model: string;
  version: string;
  dimensions: number;
  recipe: string;
  embed(text: string[], signal: AbortSignal): Promise<number[][]>;
};
export type IndexableRevision = {
  claim_id: string;
  revision: number;
  text: string;
  kind: string;
  status: string;
};
export function validateVector(vector: number[], dimensions: number) {
  if (vector.length !== dimensions || !vector.every(Number.isFinite))
    throw new MemoryError('embedding_space_mismatch');
}
export function cosine(a: number[], b: number[]) {
  validateVector(b, a.length);
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export async function indexableRows(
  tx: MemoryTx,
  scope: MemoryScope,
): Promise<IndexableRevision[]> {
  const rows =
    await tx`select c.id as claim_id, r.revision, c.domain_key, r.kind, r.status, b.content
    from memory_claims c join memory_revisions r on r.claim_id = c.id join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.space_id = ${scope.spaceId} and not c.hidden and r.status <> 'retracted' order by c.id, r.revision limit ${MAX_INDEX_ROWS + 1}`;
  if (rows.length > MAX_INDEX_ROWS) throw new MemoryError('index_build_budget');
  const eligible: IndexableRevision[] = [];
  for (const row of rows) {
    if (!(await eligibleRevision(tx, scope, row.claim_id, row.revision))) continue;
    eligible.push({
      claim_id: row.claim_id,
      revision: row.revision,
      text: `${(row.domain_key as string).replace(/[.:]/g, ' ')} ${row.content} ${(await sourceExcerpts(tx, row.claim_id, row.revision)).join(' ')}`,
      kind: row.kind,
      status: row.status,
    });
  }
  return eligible;
}
/** Embedding work is outside the transaction. The manifest moves only after a fresh validation. */
export async function buildViews(
  sql: MemorySql,
  scope: MemoryScope,
  embedding?: EmbeddingProvider,
): Promise<IndexManifest> {
  const snapshot = await sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope);
    return { generation: generation(space), rows: await indexableRows(tx, scope) };
  });
  const vectors = embedding
    ? await embedding.embed(
        snapshot.rows.map((row) => row.text),
        AbortSignal.timeout(15000),
      )
    : [];
  if (embedding) {
    if (
      !Number.isInteger(embedding.dimensions) ||
      embedding.dimensions < 1 ||
      embedding.dimensions > 4096 ||
      vectors.length !== snapshot.rows.length
    )
      throw new MemoryError('embedding_space_mismatch');
    for (const vector of vectors) validateVector(vector, embedding.dimensions);
  }
  return sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope);
    if (
      space.data_revision !== snapshot.generation.data_revision ||
      space.access_generation !== snapshot.generation.access_generation ||
      space.policy_generation !== snapshot.generation.policy_generation
    )
      throw new MemoryError('stale_index_build');
    const [old] =
      await tx`select * from memory_index_manifest where space_id = ${scope.spaceId} for update`;
    const nextGeneration = (old?.generation ?? 0) + 1;
    for (let i = 0; i < snapshot.rows.length; i++) {
      const row = snapshot.rows[i];
      if (!row) continue;
      await tx`insert into memory_index_entries (space_id, generation, claim_id, revision, tokens)
        values (${scope.spaceId}, ${nextGeneration}, ${row.claim_id}, ${row.revision}, to_tsvector('simple', ${row.text}))`;
      if (embedding)
        await tx`insert into memory_dense_entries (space_id, generation, claim_id, revision, model, version, dimensions, recipe, vector)
        values (${scope.spaceId}, ${nextGeneration}, ${row.claim_id}, ${row.revision}, ${embedding.model}, ${embedding.version}, ${embedding.dimensions}, ${embedding.recipe}, ${JSON.stringify(vectors[i] ?? [])}::text::jsonb)`;
    }
    const embeddingInfo = embedding
      ? { model: embedding.model, version: embedding.version, dimensions: embedding.dimensions }
      : null;
    await tx`update memory_index_manifest set generation = ${nextGeneration}, coverage_revision = ${space.data_revision}, method = 'lexical',
      recipe = ${LEXICAL_RECIPE}, embedding = ${embeddingInfo ? JSON.stringify(embeddingInfo) : null}::text::jsonb where space_id = ${scope.spaceId}`;
    const profile = snapshot.rows
      .filter((row) => row.kind === 'preference' && ['active', 'disputed'].includes(row.status))
      .slice(0, 8)
      .map((row) => ({ claim_id: row.claim_id, revision: row.revision }));
    // Drizzle makes JSON serializers transparent on a shared postgres.js handle.
    // Passing text explicitly works with both a raw pool and that shared handle.
    await tx`insert into memory_profile (space_id, data_revision, items, stale) values (${scope.spaceId}, ${space.data_revision}, ${JSON.stringify(profile)}::text::jsonb, false)
      on conflict (space_id) do update set data_revision = excluded.data_revision, items = excluded.items, stale = false`;
    await tx`delete from memory_index_entries where space_id = ${scope.spaceId} and generation <> ${nextGeneration}`;
    await tx`delete from memory_dense_entries where space_id = ${scope.spaceId} and generation <> ${nextGeneration}`;
    await tx`update memory_outbox set completed_at = clock_timestamp() where space_id = ${scope.spaceId} and kind = 'index' and target_id::integer <= ${space.data_revision}`;
    return {
      space_id: scope.spaceId,
      generation: nextGeneration,
      coverage_revision: space.data_revision as number,
      method: 'lexical',
      recipe: LEXICAL_RECIPE,
      embedding: embeddingInfo,
    };
  });
}
/** Durable work IDs make retries harmless; failed indexing leaves evidence and claims intact. */
export async function runViewWork(
  sql: MemorySql,
  scope: MemoryScope,
  embedding?: EmbeddingProvider,
) {
  const [pending] =
    await sql`select id from memory_outbox where space_id = ${scope.spaceId} and kind = 'index' and completed_at is null limit 1`;
  if (!pending) return false;
  try {
    await buildViews(sql, scope, embedding);
    return true;
  } catch (error) {
    await sql`update memory_outbox set failures = failures + 1, error_code = 'index_build_failed' where id = ${pending.id}`;
    throw error;
  }
}
