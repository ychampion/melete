import {
  claimHandleOf,
  type JobConstraints,
  type KnowledgeExcerpt,
  memoryKey,
  type RecallItem,
  type RecallRequest,
  type RecallResult,
  recallRequest,
  type SpaceGeneration,
} from '@melete/contracts';
import { eligibleRevision, references, revisionFromRow, sourceExcerpts } from './claims.ts';
import { disputedKeys } from './contradictions.ts';
import {
  generation,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  stableId,
} from './db.ts';
import { cosine, type EmbeddingProvider, LEXICAL_RECIPE, validateVector } from './views.ts';

export type Candidate = { claim_id: string; revision: number; score: number };
export type ReadAudience = {
  scope: MemoryScope;
  audiences: string[];
  jobRevision: number;
  constraints: JobConstraints | null;
  purpose: string;
  publicCompartment: boolean;
};
export async function effectiveAudience(
  tx: MemoryTx,
  scope: MemoryScope,
  jobId?: string,
): Promise<ReadAudience> {
  let constraints: JobConstraints | null = null;
  let jobRevision = 0;
  if (jobId) {
    const [job] =
      await tx`select revision, constraints from job where id = ${jobId} and space_id = ${scope.spaceId}`;
    if (!job) throw new MemoryError('scope_denied');
    constraints = job.constraints as JobConstraints;
    jobRevision = job.revision;
  }
  const publicCompartment = constraints?.public_compartment === true;
  const audiences = publicCompartment
    ? []
    : scope.role === 'owner'
      ? ['private', 'space', 'public']
      : ['space', 'public'];
  return {
    scope,
    audiences,
    jobRevision,
    constraints,
    purpose: jobId ? 'responsibility' : 'owner-inspection',
    publicCompartment,
  };
}
export type RecallOptions = {
  embedding?: EmbeddingProvider;
  includeProfile?: boolean;
  /** A candidate-only hook for bounded comparison tests; all IDs still cross the authority gate. */
  lexical?: (
    tx: MemoryTx,
    scope: MemoryScope,
    request: RecallRequest,
    manifestGeneration: number,
    audience: ReadAudience,
  ) => Promise<Candidate[]>;
  deadlineMs?: number;
};
export const recipeFor = (options: RecallOptions) =>
  options.embedding
    ? `${LEXICAL_RECIPE}+${options.embedding.model}@${options.embedding.version}:${options.embedding.dimensions}:${options.embedding.recipe}`
    : LEXICAL_RECIPE;
export function cacheIdentity(
  audience: ReadAudience,
  snapshot: SpaceGeneration,
  request: RecallRequest,
  recipe: string,
) {
  return stableId(
    audience.scope.spaceId,
    audience.scope.ownerId,
    audience.scope.role,
    [...audience.audiences].sort().join(','),
    snapshot.policy_generation,
    snapshot.data_revision,
    snapshot.access_generation,
    audience.jobRevision,
    audience.purpose,
    JSON.stringify(request),
    recipe,
  );
}
export function asKnowledge(item: RecallItem): KnowledgeExcerpt {
  const citations = item.sources
    .map(
      (source, i) =>
        `[${source.source_id}@${source.source_version}:${source.start}-${source.end}] ${item.excerpts[i] ?? ''}`,
    )
    .join('\n');
  const flags = [
    `origin ${item.origin_trust}`,
    item.key ? `key ${item.key}` : 'no key',
    item.disputed ? 'DISPUTED: do not act externally on this key without approval' : 'undisputed',
  ].join('; ');
  return {
    path: `memory/claims/${item.claim_id}/revisions/${item.revision}`,
    handle: item.handle,
    key: item.key,
    origin_trust: item.origin_trust,
    disputed: item.disputed,
    excerpt: `${item.domain_key}: ${item.content}\n${item.kind}; ${item.factual_status}; ${item.status}\n${flags}\nValid ${item.valid_from} to ${item.valid_until ?? 'open'}; recorded ${item.recorded_at}; superseded ${item.superseded_at ?? 'no'}\n${citations}`,
    provenance: {
      id: item.claim_id,
      asserted_by:
        item.kind === 'user_statement' || item.kind === 'preference' || item.kind === 'exception'
          ? 'user'
          : item.kind === 'inferred'
            ? 'agent'
            : 'document',
      observed_at: item.recorded_at,
      status: item.status,
    },
  };
}
export const TOKEN_COUNTER = 'utf8-bytes-quarter-v1' as const;
/**
 * Tokens for a value as delivered, estimated as a quarter of its UTF-8 bytes:
 * the estimate the model gateway charges input by. Counting every byte as a
 * token left room for two or three memories in a budget meant for a dozen.
 */
export const knowledgeTokens = (value: unknown) =>
  Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 4);
/** The larger of the delivered excerpt and the recall item, with citations and framing. */
export function itemTokens(item: RecallItem) {
  return Math.max(knowledgeTokens(asKnowledge(item)), knowledgeTokens(item)) + 2;
}

/** Words that say nothing about which memory a request needs. */
const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could do does for from had has have he her his how i if in ' +
    'into is it its me my of on or our please she so that the their them then there these they ' +
    'this to up us was we were what when where which who why will with would you your'
  ).split(' '),
);
const MAX_QUERY_TERMS = 32;

/**
 * A request is a sentence, not a list of words a memory must all contain. The
 * lexical query matches any meaningful word of it (ranked by how many match and
 * how closely), with the same word boundaries as the key-bearing index: a key
 * or dotted name is split into its parts, and an address stays whole.
 * Returns a `to_tsquery` expression, or null when nothing is left to match.
 */
export function lexicalQuery(query: string): string | null {
  const terms = lexicalTerms(query);
  // Terms hold only letters, digits and @._+-, so quoting each one is enough.
  return terms.length ? terms.map((term) => `'${term}'`).join(' | ') : null;
}
/** The meaningful words of a request, lower-cased and split as the index splits them. */
export function lexicalTerms(query: string): string[] {
  const candidate = query.trim();
  const text = memoryKey.safeParse(candidate).success ? candidate.replace(/[.:]/g, ' ') : query;
  const terms = new Set<string>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}@._+-]*/gu) ?? []) {
    const parts = word.includes('@') ? [word.replace(/[._+-]+$/, '')] : word.split(/[._+-]+/);
    for (const part of parts)
      if (part.length > 1 && !STOPWORDS.has(part) && terms.size < MAX_QUERY_TERMS) terms.add(part);
  }
  return [...terms];
}

export async function lexicalCandidates(
  tx: MemoryTx,
  scope: MemoryScope,
  request: RecallRequest,
  manifestGeneration: number,
  audience: ReadAudience,
): Promise<Candidate[]> {
  const at = request.at ?? new Date().toISOString();
  const query = lexicalQuery(request.query);
  if (!query) return [];
  const rows =
    await tx`select i.claim_id, i.revision, ts_rank_cd(i.tokens, to_tsquery('simple', ${query})) as score
    from memory_index_entries i join memory_claims c on c.id = i.claim_id join memory_revisions r on r.claim_id = i.claim_id and r.revision = i.revision
    where i.space_id = ${scope.spaceId} and i.generation = ${manifestGeneration} and not c.hidden and c.audience = any(${audience.audiences})
      and r.status <> 'retracted' and i.tokens @@ to_tsquery('simple', ${query})
      and (${request.mode === 'historical'} or (c.head_revision = r.revision and r.status in ('active','disputed') and r.kind <> 'historical' and r.valid_from <= ${at} and (r.valid_until is null or r.valid_until > ${at})))
      and (${request.mode !== 'historical' || !request.at} or (r.valid_from <= ${at} and (r.valid_until is null or r.valid_until > ${at})))
    order by score desc, i.claim_id, i.revision desc limit ${request.path === 'investigative' ? 200 : 100}`;
  return rows.map((row) => ({
    claim_id: row.claim_id,
    revision: row.revision,
    score: Number(row.score),
  }));
}
async function supplementalCandidates(
  tx: MemoryTx,
  scope: MemoryScope,
  request: RecallRequest,
  coverage: number,
  audience: ReadAudience,
): Promise<Candidate[]> {
  const at = request.at ?? new Date().toISOString();
  const query = lexicalQuery(request.query);
  if (!query) return [];
  const rows = await tx`select c.id as claim_id, r.revision, c.domain_key, b.content
    from memory_claims c join memory_revisions r on r.claim_id = c.id join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.space_id = ${scope.spaceId} and not c.hidden and c.audience = any(${audience.audiences}) and r.status <> 'retracted' and r.data_revision > ${coverage}
      and (${request.mode === 'historical'} or (c.head_revision = r.revision and r.status in ('active','disputed') and r.kind <> 'historical' and r.valid_from <= ${at} and (r.valid_until is null or r.valid_until > ${at})))
      and (${request.mode !== 'historical' || !request.at} or (r.valid_from <= ${at} and (r.valid_until is null or r.valid_until > ${at})))
    order by r.data_revision desc limit ${request.path === 'investigative' ? 201 : 101}`;
  const fresh: { claim_id: string; revision: number; text: string }[] = [];
  let characters = 0;
  for (const row of rows) {
    if (!(await eligibleRevision(tx, scope, row.claim_id, row.revision))) continue;
    const text = `${(row.domain_key as string).replace(/[.:]/g, ' ')} ${row.content} ${(await sourceExcerpts(tx, row.claim_id, row.revision)).join(' ')}`;
    characters += text.length;
    if (characters > 200000) break;
    fresh.push({ claim_id: row.claim_id, revision: row.revision, text });
  }
  const matches =
    await tx`select claim_id, revision, 0.5 as score from jsonb_to_recordset(${JSON.stringify(fresh)}::text::jsonb) as fresh(claim_id text, revision integer, text text)
    where to_tsvector('simple', text) @@ to_tsquery('simple', ${query})`;
  return matches.map((row) => ({
    claim_id: row.claim_id,
    revision: row.revision,
    score: Number(row.score),
  }));
}
export async function itemAt(
  tx: MemoryTx,
  scope: MemoryScope,
  candidate: Candidate,
  request: RecallRequest,
  disputed: ReadonlySet<string> = new Set(),
): Promise<RecallItem | null> {
  if (!(await eligibleRevision(tx, scope, candidate.claim_id, candidate.revision))) return null;
  const [row] =
    await tx`select r.*, c.domain_key, c.key, c.head_revision, b.content from memory_revisions r join memory_claims c on c.id = r.claim_id
    join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision where r.claim_id = ${candidate.claim_id} and r.revision = ${candidate.revision} and c.space_id = ${scope.spaceId}`;
  if (!row) return null;
  const at = new Date(request.at ?? Date.now()).getTime();
  if (
    request.mode === 'current' &&
    (row.head_revision !== row.revision ||
      !['active', 'disputed'].includes(row.status) ||
      row.kind === 'historical')
  )
    return null;
  if (
    (request.mode === 'current' || request.at) &&
    (new Date(row.valid_from).getTime() > at ||
      (row.valid_until && new Date(row.valid_until).getTime() <= at))
  )
    return null;
  const revision = await revisionFromRow(tx, row);
  const excerpts: string[] = [];
  for (const ref of await references(tx, candidate.claim_id, candidate.revision)) {
    const [body] =
      await tx`select content from memory_source_content where source_id = ${ref.source_id}`;
    if (!body) return null;
    excerpts.push((body.content as string).slice(ref.start, ref.end));
  }
  const key = (row.key as string | null) ?? null;
  return {
    claim_id: revision.claim_id,
    revision: revision.revision,
    handle: claimHandleOf(revision.claim_id, revision.revision),
    domain_key: row.domain_key,
    key,
    origin_trust: revision.origin_trust,
    disputed: key !== null && disputed.has(key),
    content: row.content,
    kind: revision.kind,
    factual_status: revision.factual_status,
    status: revision.status,
    valid_from: revision.valid_from,
    valid_until: revision.valid_until,
    recorded_at: revision.recorded_at,
    superseded_at: revision.superseded_at,
    sources: revision.sources,
    excerpts,
  };
}
const empty = (
  request: RecallRequest,
  recipe: string,
  status: RecallResult['status'],
  reason: RecallResult['coverage']['reason'],
): RecallResult => ({
  status,
  snapshot: null,
  index_generation: null,
  items: [],
  disputed_keys: [],
  coverage: {
    indexed_revision: 0,
    authoritative_revision: 0,
    supplemented: 0,
    truncated: false,
    reason,
  },
  recipe,
  token_budget: { limit: request.max_tokens, used: 0, counter: TOKEN_COUNTER },
});

/**
 * What an attempt recalls by: the person's newest words first, then the job's
 * objective. A conversation's objective is its title, so recalling by it alone
 * would answer every later message with what the first one was about.
 */
export function attemptRecallQuery(bundle: {
  job: { objective: string };
  inputs: { new_user_messages: { content: string }[] };
}): string {
  const said = bundle.inputs.new_user_messages.map((message) => message.content).reverse();
  return [...said, bundle.job.objective].join('\n').slice(0, 2000);
}
export const PROFILE_SIZE = 8;
/**
 * The preferences every attempt carries, newest first, read from the claims
 * themselves. The profile view is rebuilt behind every write, so reading it
 * would drop every preference from attempts that start before the rebuild, or
 * for good when a rebuild keeps failing.
 */
export async function profileCandidates(
  tx: MemoryTx,
  scope: MemoryScope,
  audiences: readonly string[],
): Promise<Candidate[]> {
  if (!audiences.length) return [];
  const rows = await tx`select c.id as claim_id, r.revision from memory_claims c
    join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    where c.space_id = ${scope.spaceId} and not c.hidden and c.audience = any(${[...audiences]})
      and r.kind = 'preference' and r.status in ('active','disputed')
      and r.valid_from <= clock_timestamp() and (r.valid_until is null or r.valid_until > clock_timestamp())
    order by r.data_revision desc, c.id limit ${PROFILE_SIZE}`;
  return rows.map((row) => ({ claim_id: row.claim_id, revision: row.revision, score: 1 }));
}
/** A bounded read revalidates every item under the same lock that protects corrections. */
export async function recall(
  sql: MemorySql,
  scope: MemoryScope,
  raw: unknown,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const request = recallRequest.parse(raw);
  const recipe = recipeFor(options);
  let snapshot: SpaceGeneration | null = null;
  let indexGeneration: number | null = null;
  let indexed = 0;
  const started = Date.now();
  const deadlineMs = Math.min(
    options.deadlineMs ?? (request.path === 'investigative' ? 1500 : 500),
    3000,
  );
  let queryVector: number[] | null = null;
  // Embedding sees only the caller's query, never a mixed/private candidate pool.
  if (options.embedding) {
    try {
      queryVector =
        (
          await options.embedding.embed(
            [request.query],
            AbortSignal.timeout(Math.max(1, deadlineMs)),
          )
        )[0] ?? null;
      if (!queryVector) throw new MemoryError('embedding_space_mismatch');
      validateVector(queryVector, options.embedding.dimensions);
    } catch {
      return empty(request, recipe, 'unavailable', 'index_failure');
    }
  }
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('statement_timeout', ${String(Math.max(1, deadlineMs))}, true)`;
      const space = await lockSpace(tx, scope, false);
      snapshot = generation(space);
      const audience = await effectiveAudience(tx, scope, request.job_id);
      const [manifest] =
        await tx`select * from memory_index_manifest where space_id = ${scope.spaceId}`;
      if (!manifest) throw new MemoryError('index_failure');
      indexGeneration = manifest.generation;
      indexed = manifest.coverage_revision;
      if (audience.publicCompartment)
        return {
          ...empty(request, recipe, 'complete', 'public_compartment'),
          snapshot,
          index_generation: indexGeneration,
        };
      // The keys an open contradiction covers, read once under the same lock.
      const disputed = new Set(await disputedKeys(tx, scope.spaceId, audience.audiences));
      const lexical = await (options.lexical ?? lexicalCandidates)(
        tx,
        scope,
        request,
        manifest.generation,
        audience,
      );
      const supplement = await supplementalCandidates(tx, scope, request, indexed, audience);
      const dense: Candidate[] = [];
      if (options.embedding && queryVector) {
        const info = manifest.embedding as {
          model: string;
          version: string;
          dimensions: number;
        } | null;
        if (
          !info ||
          info.model !== options.embedding.model ||
          info.version !== options.embedding.version ||
          info.dimensions !== options.embedding.dimensions
        )
          throw new MemoryError('embedding_space_mismatch');
        const rows =
          await tx`select d.* from memory_dense_entries d join memory_claims c on c.id = d.claim_id
          where d.space_id = ${scope.spaceId} and d.generation = ${manifest.generation} and not c.hidden and c.audience = any(${audience.audiences}) limit 2001`;
        if (rows.length > 2000) throw new MemoryError('index_failure');
        for (const row of rows) {
          const candidate = { claim_id: row.claim_id, revision: row.revision, score: 0 };
          // Access and temporal authority precede dense ranking too.
          if (!(await itemAt(tx, scope, candidate, request, disputed))) continue;
          if (
            row.model !== info.model ||
            row.version !== info.version ||
            row.dimensions !== info.dimensions ||
            row.recipe !== options.embedding.recipe
          )
            throw new MemoryError('embedding_space_mismatch');
          const score = cosine(queryVector, row.vector as number[]);
          if (score > 0) dense.push({ ...candidate, score });
        }
        dense.sort((a, b) => b.score - a.score);
      }
      const merged = new Map<string, Candidate>();
      // Independent candidate sets are merged before ranking; lexical-only matches are retained.
      for (const set of [lexical, dense.slice(0, 100), supplement])
        set.forEach((candidate, rank) => {
          const key = `${candidate.claim_id}:${candidate.revision}`;
          const prior = merged.get(key);
          merged.set(key, { ...candidate, score: (prior?.score ?? 0) + 1 / (60 + rank) });
        });
      if (options.includeProfile && request.mode === 'current')
        for (const item of await profileCandidates(tx, scope, audience.audiences))
          merged.set(`${item.claim_id}:${item.revision}`, { ...item, score: 1 });
      const items: RecallItem[] = [];
      let used = 0;
      let truncated = supplement.length > (request.path === 'investigative' ? 200 : 100);
      for (const candidate of [...merged.values()].sort(
        (a, b) => b.score - a.score || a.claim_id.localeCompare(b.claim_id),
      )) {
        if (Date.now() - started > deadlineMs) throw new MemoryError('recall_timeout');
        const item = await itemAt(tx, scope, candidate, request, disputed);
        if (!item) continue;
        const tokens = itemTokens(item);
        if (used + tokens > request.max_tokens || items.length >= request.limit) {
          truncated = true;
          continue;
        }
        items.push(item);
        used += tokens;
      }
      const lag = indexed < space.data_revision;
      return {
        status: lag || truncated ? 'degraded' : 'complete',
        snapshot,
        index_generation: indexGeneration,
        items,
        disputed_keys: [...disputed],
        coverage: {
          indexed_revision: indexed,
          authoritative_revision: space.data_revision as number,
          supplemented: supplement.length,
          truncated,
          reason: lag ? 'index_lag' : truncated ? 'budget' : 'ready',
        },
        recipe,
        token_budget: { limit: request.max_tokens, used, counter: TOKEN_COUNTER },
      } as RecallResult;
    });
  } catch (error) {
    if (error instanceof MemoryError && error.code === 'scope_denied') throw error;
    const code =
      error instanceof MemoryError
        ? error.code
        : error && typeof error === 'object' && 'code' in error
          ? error.code
          : '';
    const reason =
      code === 'restore_pending'
        ? 'restore_pending'
        : code === 'recall_timeout' || code === '57014'
          ? 'timeout'
          : 'index_failure';
    const result = empty(request, recipe, 'unavailable', reason);
    return {
      ...result,
      snapshot,
      index_generation: indexGeneration,
      coverage: {
        ...result.coverage,
        indexed_revision: indexed,
        authoritative_revision: (snapshot as SpaceGeneration | null)?.data_revision ?? 0,
      },
    };
  }
}
