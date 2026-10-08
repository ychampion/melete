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
import {
  decodeVector,
  type EmbeddingProvider,
  LEXICAL_RECIPE,
  normalized,
  validateVector,
} from './views.ts';

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
  /**
   * Include what memory learned in conversations that were private when they
   * were captured. Only for the person's own view and for requests that stay
   * on their own model; left out, those items are never returned.
   */
  privateOrigin?: boolean;
  /** The agent answering may not read memory: nothing is looked up or returned. */
  withheld?: boolean;
  /** Told, with a short code, when semantic recall could not be used and recall stayed lexical. */
  onError?: (code: string) => void;
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
  // A typed key names one detail exactly; only words in a sentence are stemmed.
  const exact = memoryKey.safeParse(query.trim()).success;
  return terms.length ? terms.map(exact ? tsqueryTerm : stemTerm).join(' | ') : null;
}
/** Endings a word drops to match its other forms: "allergies", "allergic" and "allergy". */
const ENDINGS = /(?:ations?|ities|ies|ing|ic|es|ed|y|s)$/u;
/**
 * A plain word of five letters or more is matched by its stem as a prefix, so
 * "do I have allergies" finds "I am allergic to cashews" when recall has only
 * words to go on. Shorter words, numbers and addresses match as written.
 */
export function stemTerm(term: string): string {
  if (term.length < 5 || !/^\p{L}+$/u.test(term)) return tsqueryTerm(term);
  const stem = term.replace(ENDINGS, '');
  return `${tsqueryTerm(stem.length >= 4 ? stem : term)}:*`;
}
/** The meaningful words of a request, lower-cased and split as the index splits them. */
export function lexicalTerms(query: string): string[] {
  const candidate = query.trim();
  const text = memoryKey.safeParse(candidate).success ? candidate.replace(/[.:]/g, ' ') : query;
  const terms = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/)) {
    // A possessive names the same thing ("Maya's" is Maya); what is left of a
    // word keeps its inner punctuation, so an address, a link or a decimal is
    // read by the same parser, and split the same way, as the index was.
    const word = raw.replace(/['’]s$/u, '').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    for (const part of word.split(/['’]/u))
      if (part.length > 1 && !STOPWORDS.has(part) && terms.size < MAX_QUERY_TERMS) terms.add(part);
  }
  return [...terms];
}
/** One term as a `to_tsquery` operand, which the parser then splits as the index was split. */
export const tsqueryTerm = (term: string) => `'${term.replace(/['\\]/g, '')}'`;

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
/** The most parts of one request embedded on their own, beside the whole of it. */
export const QUERY_PARTS = 4;
/**
 * The separate questions of a request, asked one after another on a line. A
 * message that asks several things ("which sibling lives in Colorado? which
 * nut should I avoid?") is, as one vector, closest to the part worded most
 * like a memory, and the floor that closest match sets drops the answers to
 * the other parts. Each part is also ranked on its own. A request of one
 * question (a message and the chat's title on the next line among them) gives
 * just the whole, and costs one embedding as before.
 */
export function queryParts(query: string): string[] {
  const whole = query.trim();
  if (!whole) return [];
  const parts = whole
    .split(/(?<=[?!])[^\S\n]+|[^\S\n]*(?:…|\.{3})[^\S\n]*|;[^\S\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part && part !== whole && lexicalTerms(part).length > 0);
  const distinct = [...new Set(parts)].slice(0, QUERY_PARTS);
  return distinct.length > 1 ? [whole, ...distinct] : [whole];
}
/** The most semantic candidates one recall ranks beside the lexical ones. */
export const DENSE_CANDIDATES = 100;
/**
 * A semantic candidate's least similarity, as a share of the closest one's.
 * Measured on held-out paraphrases with the default model, the memory asked
 * for was never below 0.86 of the closest, and most unrelated ones were.
 */
export const DENSE_RELATIVE_FLOOR = 0.85;
/** How long a recall waits for its query's embedding before recalling lexically. */
export const QUERY_EMBED_MS = 2000;
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
/** The most vectors one space's semantic recall loads; past it, recall stays lexical. */
export const DENSE_ROW_CAP = 2000;
/** How long loading a space's vectors may take before recall goes ahead lexically. */
export const DENSE_LOAD_MS = 1500;
/** How many of the closest vectors are checked for eligibility, at most. */
const DENSE_SHORTLIST = 300;

/** One space's vectors for one index generation, scaled to length one, side by side. */
type DenseMatrix = {
  claimIds: string[];
  revisions: number[];
  dimensions: number;
  vectors: Float32Array;
  /** The whole request first, then each of its parts that could be embedded. */
  queries: Float32Array[];
};
type Loaded = Omit<DenseMatrix, 'queries'>;

/**
 * Loaded vectors, by space, generation and embedding. Every write moves the
 * generation, so an entry is never stale: an old one is simply not asked for.
 */
const loadedVectors = new Map<string, Loaded>();
const LOADED_SPACES = 16;

const logDense = (code: string) => process.stderr.write(`memory: recall_lexical:${code}\n`);

async function loadVectors(
  sql: MemorySql,
  spaceId: string,
  generation: number,
  embedding: EmbeddingProvider,
): Promise<Loaded> {
  const key = `${spaceId}\u0000${generation}\u0000${embedding.model}@${embedding.version}:${embedding.dimensions}:${embedding.recipe}`;
  const hit = loadedVectors.get(key);
  if (hit) {
    loadedVectors.delete(key);
    loadedVectors.set(key, hit);
    return hit;
  }
  const rows = await sql.begin(async (tx) => {
    await tx`select set_config('statement_timeout', ${String(DENSE_LOAD_MS)}, true)`;
    return tx`select claim_id, revision, model, version, dimensions, recipe, vector from memory_dense_entries
      where space_id = ${spaceId} and generation = ${generation} limit ${DENSE_ROW_CAP + 1}`;
  });
  if (rows.length > DENSE_ROW_CAP) throw new MemoryError('dense_over_cap');
  const d = embedding.dimensions;
  const loaded: Loaded = {
    claimIds: [],
    revisions: [],
    dimensions: d,
    vectors: new Float32Array(rows.length * d),
  };
  for (const row of rows) {
    // Vectors of another embedding are never compared, whatever a row says.
    if (
      row.model !== embedding.model ||
      row.version !== embedding.version ||
      row.dimensions !== d ||
      row.recipe !== embedding.recipe
    )
      throw new MemoryError('embedding_space_mismatch');
    const vector = normalized(decodeVector(row.vector, d) ?? []);
    if (!vector) continue;
    loaded.vectors.set(vector, loaded.claimIds.length * d);
    loaded.claimIds.push(String(row.claim_id));
    loaded.revisions.push(Number(row.revision));
  }
  loadedVectors.set(key, loaded);
  while (loadedVectors.size > LOADED_SPACES) {
    const oldest = loadedVectors.keys().next().value;
    if (oldest === undefined) break;
    loadedVectors.delete(oldest);
  }
  return loaded;
}

/**
 * The request's vector and the space's vectors, or why semantic recall cannot
 * be used now. Null `matrix` with no reason means it is not wanted: the
 * request is empty or may not leave (a space marked private).
 */
async function prepareDense(
  sql: MemorySql,
  scope: MemoryScope,
  request: RecallRequest,
  embedding: EmbeddingProvider,
): Promise<{ matrix: DenseMatrix | null; generation: number | null; unavailable?: string }> {
  if (!request.query.trim()) return { matrix: null, generation: null };
  try {
    const [manifest] =
      await sql`select generation, embedding from memory_index_manifest where space_id = ${scope.spaceId}`;
    const info = manifest?.embedding as {
      model?: string;
      version?: string;
      dimensions?: number;
    } | null;
    // Not built with this embedding (yet): the provider is not asked at all.
    if (
      !manifest ||
      !info ||
      info.model !== embedding.model ||
      info.version !== embedding.version ||
      info.dimensions !== embedding.dimensions
    )
      return { matrix: null, generation: null, unavailable: 'dense_not_built' };
    const generation = Number(manifest.generation);
    const vectors = loadVectors(sql, scope.spaceId, generation, embedding);
    // A rejection is read below; this keeps it from going unhandled meanwhile.
    vectors.catch(() => {});
    const parts = queryParts(request.query);
    const screened = embedding.screen
      ? await embedding.screen(scope.spaceId, parts, request.job_id ?? null)
      : parts;
    const text = screened?.[0];
    if (!text) return { matrix: null, generation };
    const signal = AbortSignal.timeout(QUERY_EMBED_MS);
    const call = {
      spaceId: scope.spaceId,
      jobId: request.job_id ?? null,
      actor: scope.principalId ?? null,
    };
    // The whole request on its own, as it was prefetched; its parts in one more call.
    const rest = (screened ?? []).slice(1).filter((part): part is string => Boolean(part));
    const [whole, split] = await Promise.allSettled([
      embedding.embed([text], signal, { purpose: 'query', call }),
      rest.length ? embedding.embed(rest, signal, { purpose: 'query', call }) : [],
    ]);
    if (whole.status === 'rejected') throw whole.reason;
    const made = whole.value[0];
    if (!made) throw new MemoryError('embedding_space_mismatch');
    validateVector(made, embedding.dimensions);
    const query = normalized(made);
    if (!query) return { matrix: null, generation };
    const queries = [query];
    // A part that could not be embedded is left to the whole and to the words.
    if (split.status === 'fulfilled' && split.value.length === rest.length)
      for (const vector of split.value) {
        if (vector.length !== embedding.dimensions) continue;
        const part = normalized(vector);
        if (part) queries.push(part);
      }
    return { matrix: { ...(await vectors), queries }, generation };
  } catch (error) {
    const code =
      error instanceof MemoryError
        ? error.code
        : error && typeof error === 'object' && 'code' in error && error.code === '57014'
          ? 'dense_timeout'
          : error instanceof Error && error.name === 'TimeoutError'
            ? 'embedding_timeout'
            : 'dense_failed';
    return { matrix: null, generation: null, unavailable: code };
  }
}

/**
 * The closest eligible revisions to one query vector, best first. Scored in
 * memory; only the shortlist is read back, its audience checked in one query,
 * and each kept one revalidated like any other candidate. Only what is nearly
 * as close as the closest eligible one is kept.
 */
async function rankOne(
  tx: MemoryTx,
  scope: MemoryScope,
  request: RecallRequest,
  matrix: DenseMatrix,
  query: Float32Array,
  audiences: readonly string[],
  kept: ReadonlySet<string> | null,
  disputed: ReadonlySet<string>,
  eligible: Map<string, boolean>,
): Promise<Candidate[]> {
  const d = matrix.dimensions;
  const scored: Candidate[] = [];
  for (let row = 0; row < matrix.claimIds.length; row++) {
    let score = 0;
    const offset = row * d;
    for (let i = 0; i < d; i++) score += (matrix.vectors[offset + i] ?? 0) * (query[i] ?? 0);
    if (score > 0)
      scored.push({
        claim_id: matrix.claimIds[row] ?? '',
        revision: matrix.revisions[row] ?? 0,
        score,
      });
  }
  scored.sort((a, b) => b.score - a.score || a.claim_id.localeCompare(b.claim_id));
  const shortlist = scored
    .filter((candidate) => !kept?.has(`${candidate.claim_id}:${candidate.revision}`))
    .slice(0, DENSE_SHORTLIST);
  if (!shortlist.length || !audiences.length) return [];
  const visible = new Set(
    (
      await tx`select id from memory_claims where space_id = ${scope.spaceId}
        and id = any(${shortlist.map((candidate) => candidate.claim_id)}::text[])
        and not hidden and audience = any(${[...audiences]})`
    ).map((row) => String(row.id)),
  );
  const ranked: Candidate[] = [];
  let floor = 0;
  for (const candidate of shortlist) {
    if (ranked.length >= DENSE_CANDIDATES || candidate.score < floor) break;
    if (!visible.has(candidate.claim_id)) continue;
    const key = `${candidate.claim_id}:${candidate.revision}`;
    let ok = eligible.get(key);
    if (ok === undefined) {
      ok = Boolean(await itemAt(tx, scope, candidate, request, disputed));
      eligible.set(key, ok);
    }
    if (!ok) continue;
    // The floor is set by the closest one this read may return.
    if (!ranked.length) floor = candidate.score * DENSE_RELATIVE_FLOOR;
    ranked.push(candidate);
  }
  return ranked;
}

/**
 * The closest eligible revisions to the request and to each of its parts,
 * taken in turn: the whole request's closest, then each part's closest, then
 * the next of each. A part's answer is kept by its own floor, not the whole's.
 */
async function rankDense(
  tx: MemoryTx,
  scope: MemoryScope,
  request: RecallRequest,
  matrix: DenseMatrix,
  audiences: readonly string[],
  kept: ReadonlySet<string> | null,
  disputed: ReadonlySet<string>,
): Promise<Candidate[]> {
  const eligible = new Map<string, boolean>();
  const lists: Candidate[][] = [];
  for (const query of matrix.queries)
    lists.push(
      await rankOne(tx, scope, request, matrix, query, audiences, kept, disputed, eligible),
    );
  const ranked: Candidate[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let rank = 0; rank < longest && ranked.length < DENSE_CANDIDATES; rank++)
    for (const list of lists) {
      const candidate = list[rank];
      if (!candidate) continue;
      const key = `${candidate.claim_id}:${candidate.revision}`;
      if (seen.has(key) || ranked.length >= DENSE_CANDIDATES) continue;
      seen.add(key);
      ranked.push(candidate);
    }
  return ranked;
}

/** A bounded read revalidates every item under the same lock that protects corrections. */
export async function recall(
  sql: MemorySql,
  scope: MemoryScope,
  raw: unknown,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const request = recallRequest.parse(raw);
  let recipe = recipeFor(options);
  let snapshot: SpaceGeneration | null = null;
  let indexGeneration: number | null = null;
  let indexed = 0;
  const deadlineMs = Math.min(
    options.deadlineMs ?? (request.path === 'investigative' ? 1500 : 500),
    3000,
  );
  // Semantic recall is prepared before the read, outside its transaction and
  // its deadline: the request embedded, and the space's vectors loaded (or
  // taken from the cache). Anything that goes wrong here, or is too big,
  // leaves recall lexical, never empty.
  const dense =
    options.embedding && !options.withheld
      ? await prepareDense(sql, scope, request, options.embedding)
      : null;
  let denseUnavailable = dense?.unavailable !== undefined;
  if (dense?.unavailable) (options.onError ?? logDense)(dense.unavailable);
  if (!dense?.matrix) recipe = LEXICAL_RECIPE;
  // The deadline is the read's own: the embedding call above has its own timeout.
  const started = Date.now();
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
      if (options.withheld)
        return {
          ...empty(request, recipe, 'complete', 'withheld'),
          snapshot,
          index_generation: indexGeneration,
        };
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
      // Claim revisions learned from a private conversation, left out unless asked for.
      const kept = options.privateOrigin
        ? null
        : new Set(
            (
              await tx`select distinct ref.claim_id, ref.revision from memory_references ref
                join memory_sources s on s.id = ref.source_id
                where s.space_id = ${scope.spaceId} and s.private_origin is not null`
            ).map((row) => `${row.claim_id}:${row.revision}`),
          );
      const semantic: Candidate[] = [];
      if (dense?.matrix) {
        if (dense.generation !== manifest.generation) {
          // The index moved on since the vectors were read: words alone this time.
          recipe = LEXICAL_RECIPE;
          denseUnavailable = true;
          (options.onError ?? logDense)('dense_generation_moved');
        } else
          semantic.push(
            ...(await rankDense(
              tx,
              scope,
              request,
              dense.matrix,
              audience.audiences,
              kept,
              disputed,
            )),
          );
      }
      const merged = new Map<string, Candidate>();
      // Independent candidate sets are merged before ranking; lexical-only matches are retained.
      for (const set of [lexical, semantic, supplement])
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
        if (!item || kept?.has(`${item.claim_id}:${item.revision}`)) continue;
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
        status: lag || truncated || denseUnavailable ? 'degraded' : 'complete',
        snapshot,
        index_generation: indexGeneration,
        items,
        disputed_keys: [...disputed],
        coverage: {
          indexed_revision: indexed,
          authoritative_revision: space.data_revision as number,
          supplemented: supplement.length,
          truncated,
          reason: lag
            ? 'index_lag'
            : truncated
              ? 'budget'
              : denseUnavailable
                ? 'dense_unavailable'
                : 'ready',
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
