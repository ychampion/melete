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
import { profileCandidates } from './recall.ts';

export const LEXICAL_RECIPE = 'simple-lexical-v1';
export const MAX_INDEX_ROWS = 2000;
/** Whose memory an embedding call reads, so its cost is charged to that person. */
export type EmbeddingCall = {
  spaceId: string;
  /** The conversation the text came from, when it came from one. */
  jobId?: string | null;
  /** The person who caused the call, when the caller knows them. */
  actor?: string | null;
};
export type EmbeddingProvider = {
  model: string;
  version: string;
  dimensions: number;
  recipe: string;
  /**
   * The model runs on the person's own machine or network. Only such a model
   * may read what memory learned in a private conversation; a cloud embedder
   * never sees it, and that memory is recalled lexically.
   */
  local?: boolean;
  /** `purpose` tells a model that embeds questions and passages differently which this is. */
  embed(
    text: string[],
    signal: AbortSignal,
    options?: { purpose?: 'query' | 'document'; call?: EmbeddingCall },
  ): Promise<number[][]>;
  /**
   * What of each text may be sent for this space: the details the privacy
   * settings detect swapped for their kind, or null when nothing from the
   * space may leave (a space the person marked private). Left out, texts are
   * sent as given, which only a local model should do.
   */
  screen?(spaceId: string, texts: string[]): Promise<string[] | null>;
};
/** How many texts one embedding request carries. */
export const EMBED_BATCH = 64;
export type IndexableRevision = {
  claim_id: string;
  revision: number;
  text: string;
  kind: string;
  status: string;
  /** Learned from a conversation that was private when it was captured. */
  private: boolean;
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
  const learnedPrivately = new Set(
    (
      await tx`select distinct ref.claim_id, ref.revision from memory_references ref
        join memory_sources s on s.id = ref.source_id
        where s.space_id = ${scope.spaceId} and s.private_origin is not null`
    ).map((row) => `${row.claim_id}:${row.revision}`),
  );
  const eligible: IndexableRevision[] = [];
  for (const row of rows) {
    if (!(await eligibleRevision(tx, scope, row.claim_id, row.revision))) continue;
    eligible.push({
      claim_id: row.claim_id,
      revision: row.revision,
      text: `${(row.domain_key as string).replace(/[.:]/g, ' ')} ${row.content} ${(await sourceExcerpts(tx, row.claim_id, row.revision)).join(' ')}`,
      kind: row.kind,
      status: row.status,
      private: learnedPrivately.has(`${row.claim_id}:${row.revision}`),
    });
  }
  return eligible;
}
/** The vectors already made for this space under this embedding, by claim revision. */
async function keptVectors(
  sql: MemorySql,
  scope: MemoryScope,
  embedding: EmbeddingProvider,
): Promise<Map<string, number[]>> {
  const rows = await sql`select claim_id, revision, vector from memory_dense_entries
    where space_id = ${scope.spaceId} and model = ${embedding.model} and version = ${embedding.version}
      and dimensions = ${embedding.dimensions} and recipe = ${embedding.recipe}`;
  const kept = new Map<string, number[]>();
  for (const row of rows) {
    const vector = row.vector as number[];
    if (Array.isArray(vector) && vector.length === embedding.dimensions)
      kept.set(`${row.claim_id}:${row.revision}`, vector);
  }
  return kept;
}
/**
 * Vectors for the revisions this build indexes. A revision embedded by an
 * earlier build keeps its vector, so each write embeds only what it added and
 * a space indexed before embeddings were configured is filled in on its next
 * build. What a cloud embedder may not read (memory learned in a private
 * conversation, or anything in a space marked private) gets no vector and is
 * recalled lexically. A provider that fails or refuses leaves the rest for the
 * next build; a vector of the wrong shape fails the build.
 */
async function vectorsFor(
  sql: MemorySql,
  scope: MemoryScope,
  rows: IndexableRevision[],
  embedding: EmbeddingProvider,
): Promise<Map<string, number[]>> {
  if (
    !Number.isInteger(embedding.dimensions) ||
    embedding.dimensions < 1 ||
    embedding.dimensions > 4096
  )
    throw new MemoryError('embedding_space_mismatch');
  const kept = await keptVectors(sql, scope, embedding);
  const vectors = new Map<string, number[]>();
  const missing: IndexableRevision[] = [];
  for (const row of rows) {
    const key = `${row.claim_id}:${row.revision}`;
    const vector = kept.get(key);
    if (vector) vectors.set(key, vector);
    else if (embedding.local || !row.private) missing.push(row);
  }
  if (!missing.length) return vectors;
  const texts = embedding.screen
    ? await embedding.screen(
        scope.spaceId,
        missing.map((row) => row.text),
      )
    : missing.map((row) => row.text);
  if (!texts || texts.length !== missing.length) return vectors;
  const signal = AbortSignal.timeout(15000);
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const batch = missing.slice(start, start + EMBED_BATCH);
    let made: number[][];
    try {
      made = await embedding.embed(texts.slice(start, start + EMBED_BATCH), signal, {
        purpose: 'document',
        call: { spaceId: scope.spaceId },
      });
    } catch (error) {
      if (error instanceof MemoryError && error.code === 'embedding_space_mismatch') throw error;
      // Not this time: the lexical index is still built, and the next build tries again.
      break;
    }
    if (made.length !== batch.length) throw new MemoryError('embedding_space_mismatch');
    batch.forEach((row, i) => {
      const vector = made[i] ?? [];
      validateVector(vector, embedding.dimensions);
      vectors.set(`${row.claim_id}:${row.revision}`, vector);
    });
  }
  return vectors;
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
    ? await vectorsFor(sql, scope, snapshot.rows, embedding)
    : new Map<string, number[]>();
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
      const vector = vectors.get(`${row.claim_id}:${row.revision}`);
      if (embedding && vector)
        await tx`insert into memory_dense_entries (space_id, generation, claim_id, revision, model, version, dimensions, recipe, vector)
        values (${scope.spaceId}, ${nextGeneration}, ${row.claim_id}, ${row.revision}, ${embedding.model}, ${embedding.version}, ${embedding.dimensions}, ${embedding.recipe}, ${JSON.stringify(vector)}::text::jsonb)`;
    }
    const embeddingInfo = embedding
      ? { model: embedding.model, version: embedding.version, dimensions: embedding.dimensions }
      : null;
    await tx`update memory_index_manifest set generation = ${nextGeneration}, coverage_revision = ${space.data_revision}, method = 'lexical',
      recipe = ${LEXICAL_RECIPE}, embedding = ${embeddingInfo ? JSON.stringify(embeddingInfo) : null}::text::jsonb where space_id = ${scope.spaceId}`;
    // The inspection copy of what recall reads from the claims themselves.
    const profile = (await profileCandidates(tx, scope, ['private', 'space', 'public'])).map(
      ({ claim_id, revision }) => ({ claim_id, revision }),
    );
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
