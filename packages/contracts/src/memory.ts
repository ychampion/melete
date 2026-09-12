/** Postgres authorities and rebuildable memory views. Scope is never request metadata. */
import { z } from 'zod';
import { prefixedId, timestamp } from './common.ts';
import { knowledgeFrontmatter } from './knowledge.ts';
import { styleViolations } from './style.ts';

const counter = z.number().int().nonnegative();
const positive = z.number().int().positive();
const boundedIdentity = z.string().min(1).max(240);
export const sourceId = prefixedId('src');
// Preserve the inspection surface's stable record identity across revisions.
export const claimId = prefixedId('k');
export const memoryAudience = z.enum(['private', 'space', 'public']);
export const sourceState = z.enum(['active', 'suppressed', 'deleted', 'revoked']);

// --------------------------------------------------------------------------
// The typed key registry (E2)
// --------------------------------------------------------------------------

/**
 * The key shapes a claim may occupy. The registry lives here, in the schema, and
 * grows only by a reviewed commit: extraction proposes a key from this list, it
 * never invents a shape. The database allows one active head per (space, key,
 * audience), so a key is the unit a contradiction is declared over.
 */
export const MEMORY_KEY_SHAPES = [
  'event.<slug>.date',
  'event.<slug>.location',
  'contact.<slug>.email',
  'contact.<slug>.phone',
  'pref.<domain>.<name>',
  'constraint.<job>.<name>',
] as const;
export type MemoryKeyShape = (typeof MEMORY_KEY_SHAPES)[number];
const SLUG = '[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?';
export const MEMORY_KEY_PATTERN = new RegExp(
  `^(?:event\\.${SLUG}\\.(?:date|location)|contact\\.${SLUG}\\.(?:email|phone)|pref\\.${SLUG}\\.${SLUG}|constraint\\.${SLUG}\\.${SLUG})$`,
);
export const memoryKey = z
  .string()
  .max(200)
  .regex(MEMORY_KEY_PATTERN, 'must be a registered memory key shape');
export type MemoryKey = z.infer<typeof memoryKey>;
export const isMemoryKey = (value: string): boolean => MEMORY_KEY_PATTERN.test(value);
/** The grammar Tier 0 must be able to re-derive a value of this key from evidence. */
export const memoryKeyValueType = z.enum(['date', 'location', 'email', 'phone', 'text']);
export type MemoryKeyValueType = z.infer<typeof memoryKeyValueType>;
export function memoryKeyValue(key: string): MemoryKeyValueType {
  if (!isMemoryKey(key)) return 'text';
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (key.startsWith('event.')) return leaf === 'date' ? 'date' : 'location';
  if (key.startsWith('contact.')) return leaf === 'email' ? 'email' : 'phone';
  return 'text';
}
export function memoryKeyShape(key: string): MemoryKeyShape | null {
  if (!isMemoryKey(key)) return null;
  const leaf = key.slice(key.lastIndexOf('.') + 1);
  if (key.startsWith('event.'))
    return leaf === 'date' ? 'event.<slug>.date' : 'event.<slug>.location';
  if (key.startsWith('contact.'))
    return leaf === 'email' ? 'contact.<slug>.email' : 'contact.<slug>.phone';
  return key.startsWith('pref.') ? 'pref.<domain>.<name>' : 'constraint.<job>.<name>';
}

// --------------------------------------------------------------------------
// Trust class (E4) and stable handles (E1)
// --------------------------------------------------------------------------

/** Where a value came from. A claim's class is the minimum over its sources. */
export const ORIGIN_TRUST = [
  'owner',
  'verified_connector',
  'external_content',
  'inferred',
  /** Never produced by memory; the broker's honest default when nobody answers. */
  'unknown',
] as const;
export const originTrust = z.enum(ORIGIN_TRUST);
export type OriginTrust = z.infer<typeof originTrust>;
export const ORIGIN_TRUST_RANK: Record<OriginTrust, number> = {
  unknown: 0,
  owner: 3,
  verified_connector: 2,
  external_content: 1,
  inferred: 0,
};
/** A claim is only as trustworthy as its weakest source. */
export function minimumOriginTrust(values: readonly OriginTrust[]): OriginTrust {
  return values.reduce<OriginTrust>(
    (weakest, value) => (ORIGIN_TRUST_RANK[value] < ORIGIN_TRUST_RANK[weakest] ? value : weakest),
    'owner',
  );
}
/** Classes an external effect may use without a fresh approval that displays the origin. */
export const isActionableTrust = (value: OriginTrust): boolean =>
  value === 'owner' || value === 'verified_connector';

/** `k_…@7`. Recall items, derivation edges and `uses` manifests all name a revision this way. */
export const claimHandle = z
  .string()
  .regex(/^k_[0-7][0-9A-HJKMNP-TV-Z]{25}@[1-9][0-9]{0,8}$/, 'must be a claim_id@revision handle');
/** `src_…@2`. The version is opaque to everything but the ledger that issued it. */
export const sourceHandle = z
  .string()
  .regex(/^src_[0-7][0-9A-HJKMNP-TV-Z]{25}@[^\s@]{1,240}$/, 'must be a source_id@version handle');
export const memoryHandle = z.union([claimHandle, sourceHandle]);
export type MemoryHandle = z.infer<typeof memoryHandle>;
export const claimHandleOf = (id: string, revision: number): string => `${id}@${revision}`;
export const sourceHandleOf = (id: string, version: string): string => `${id}@${version}`;
export type ParsedHandle =
  | { kind: 'claim'; claim_id: string; revision: number }
  | { kind: 'source'; source_id: string; source_version: string };
export function parseMemoryHandle(handle: string): ParsedHandle | null {
  const at = handle.lastIndexOf('@');
  if (at <= 0) return null;
  const id = handle.slice(0, at);
  const version = handle.slice(at + 1);
  if (claimHandle.safeParse(handle).success)
    return { kind: 'claim', claim_id: id, revision: Number(version) };
  if (sourceHandle.safeParse(handle).success)
    return { kind: 'source', source_id: id, source_version: version };
  return null;
}

export const sourceType = z.enum([
  'message',
  'document',
  'observation',
  'receipt',
  'assistant',
  'owner_edit',
]);
export const sourceRef = z.strictObject({
  source_id: sourceId,
  source_version: boundedIdentity,
  start: counter,
  end: positive,
});
export const supportingSpan = sourceRef.extend({ quote: z.string().min(1).max(16000) });
export type SupportingSpan = z.infer<typeof supportingSpan>;
export type SourceRef = z.infer<typeof sourceRef>;
/** Additional provenance for the derived Markdown surface; legacy fields remain compatible. */
export const memoryKnowledgeFrontmatter = knowledgeFrontmatter.extend({
  memory_revision: positive,
  protected: z.boolean(),
  recorded_at: timestamp,
  exact_valid_from: timestamp,
  exact_valid_until: timestamp.nullable(),
  superseded_at: timestamp.nullable(),
  source_refs: z.array(sourceRef).min(1),
  supersedes_revisions: z.array(positive),
  /** Shown in the Markdown view so a reader sees where a claim came from. */
  origin_trust: originTrust,
  key: memoryKey.nullable().default(null),
  /** True while the key has an open contradiction and one owner question is queued. */
  disputed: z.boolean().default(false),
});
export type MemoryKnowledgeFrontmatter = z.infer<typeof memoryKnowledgeFrontmatter>;
export const sourceEvent = z.strictObject({
  source_id: sourceId,
  source_version: boundedIdentity,
  owner_id: prefixedId('own'),
  space_id: prefixedId('sp'),
  publisher: boundedIdentity,
  stream: boundedIdentity,
  source_identity: boundedIdentity,
  stream_sequence: positive,
  source_type: sourceType,
  content_ref: z.string().nullable(),
  event_at: timestamp,
  ingested_at: timestamp,
  audience: memoryAudience,
  state: sourceState,
  eligibility_generation: counter,
  /**
   * Who wrote the bytes, declared by the connector that imported them. A message
   * the owner typed and a message somebody else sent are the same source type and
   * a very different trust class, and only the importer knows which is which.
   */
  author: z.enum(['owner', 'external']).default('owner'),
  /** Derived from the source type and the author; a claim takes the minimum over its sources. */
  origin_trust: originTrust,
});
export type SourceEvent = z.infer<typeof sourceEvent>;
export const sourceEvidenceResponse = z.strictObject({ source: sourceEvent, text: z.string() });

export const claimKind = z.enum([
  'user_statement',
  'document_assertion',
  'checked_fact',
  'inferred',
  'preference',
  'exception',
  'historical',
]);
export const factualStatus = z.enum(['attributed', 'checked', 'tentative', 'disputed']);
export const claimStatus = z.enum(['active', 'superseded', 'historical', 'retracted', 'disputed']);
export const claim = z.strictObject({
  id: claimId,
  space_id: prefixedId('sp'),
  domain_key: boundedIdentity,
  /**
   * The registry key this claim occupies, when it occupies one. At most one
   * un-hidden claim per (space, key, audience) exists, which is what makes "one
   * active head per key" a database constraint rather than a convention.
   */
  key: memoryKey.nullable().default(null),
  audience: memoryAudience,
  head_revision: positive,
  hidden: z.boolean(),
});
export type Claim = z.infer<typeof claim>;
export const claimRevision = z.strictObject({
  claim_id: claimId,
  revision: positive,
  content: z.string().max(16000).nullable(),
  kind: claimKind,
  factual_status: factualStatus,
  status: claimStatus,
  protected: z.boolean(),
  valid_from: timestamp,
  valid_until: timestamp.nullable(),
  recorded_at: timestamp,
  superseded_at: timestamp.nullable(),
  data_revision: positive,
  sources: z.array(sourceRef),
  /** The minimum trust class over this revision's sources. Never raised by a model. */
  origin_trust: originTrust.default('inferred'),
});
export type ClaimRevision = z.infer<typeof claimRevision>;
export const derivation = z.strictObject({
  space_id: prefixedId('sp'),
  input_kind: z.enum(['source', 'claim', 'job']),
  input_id: boundedIdentity,
  input_version: boundedIdentity,
  /** `artifact`, `plan_step` and `action` are the consequential outputs of E1. */
  output_kind: z.enum([
    'claim',
    'context',
    'prepared',
    'index',
    'markdown',
    'artifact',
    'plan_step',
    'action',
  ]),
  output_id: boundedIdentity,
  output_version: boundedIdentity,
});
export type Derivation = z.infer<typeof derivation>;

export const spaceGeneration = z.strictObject({
  space_id: prefixedId('sp'),
  policy_generation: counter,
  data_revision: counter,
  access_generation: counter,
  eligibility_generation: counter,
  restore_ready: z.boolean(),
});
export type SpaceGeneration = z.infer<typeof spaceGeneration>;
export const memoryWork = z.strictObject({
  id: boundedIdentity,
  source_id: sourceId,
  policy_version: boundedIdentity,
  segment_start: counter,
  segment_end: positive,
  status: z.enum(['pending', 'leased', 'review', 'done', 'rejected']),
  fence: counter,
  lease_until: timestamp.nullable(),
  continuation: counter.nullable(),
});
export type MemoryWork = z.infer<typeof memoryWork>;
export const suppression = z.strictObject({
  id: prefixedId('sup'),
  space_id: prefixedId('sp'),
  source_id: sourceId.nullable(),
  start: counter.nullable(),
  end: positive.nullable(),
  eligibility_cutoff: counter,
  operation: z.enum(['forget', 'delete', 'revoke', 'clear']),
  recorded_at: timestamp,
});
export type Suppression = z.infer<typeof suppression>;
export const indexManifest = z.strictObject({
  space_id: prefixedId('sp'),
  generation: counter,
  coverage_revision: counter,
  method: z.literal('lexical'),
  recipe: boundedIdentity,
  embedding: z
    .strictObject({ model: boundedIdentity, version: boundedIdentity, dimensions: positive })
    .nullable(),
});
export type IndexManifest = z.infer<typeof indexManifest>;

export const recallRequest = z.strictObject({
  job_id: prefixedId('job').optional(),
  query: z.string().max(2000),
  mode: z.enum(['current', 'historical']).default('current'),
  at: timestamp.optional(),
  path: z.enum(['ordinary', 'investigative']).default('ordinary'),
  max_tokens: positive.max(2000).default(2000),
  limit: positive.max(50).default(10),
});
export type RecallRequest = z.infer<typeof recallRequest>;
export const recallItem = z.strictObject({
  claim_id: claimId,
  revision: positive,
  /** `claim_id@revision`. What a `uses` manifest cites and what a derivation edge records. */
  handle: claimHandle,
  domain_key: boundedIdentity,
  key: memoryKey.nullable().default(null),
  origin_trust: originTrust.default('inferred'),
  /** True when this key has an open contradiction: do not act externally on it without approval. */
  disputed: z.boolean().default(false),
  content: z.string(),
  kind: claimKind,
  factual_status: factualStatus,
  status: claimStatus,
  valid_from: timestamp,
  valid_until: timestamp.nullable(),
  recorded_at: timestamp,
  superseded_at: timestamp.nullable(),
  sources: z.array(sourceRef),
  excerpts: z.array(z.string()),
});
export type RecallItem = z.infer<typeof recallItem>;
export const recallResult = z.strictObject({
  status: z.enum(['complete', 'degraded', 'unavailable']),
  snapshot: spaceGeneration.nullable(),
  index_generation: counter.nullable(),
  items: z.array(recallItem),
  /** Keys with an open contradiction. The runtime must not act externally on one unapproved. */
  disputed_keys: z.array(memoryKey).default([]),
  coverage: z.strictObject({
    indexed_revision: counter,
    authoritative_revision: counter,
    supplemented: counter,
    truncated: z.boolean(),
    reason: z.enum([
      'ready',
      'index_lag',
      'budget',
      'timeout',
      'index_failure',
      'restore_pending',
      'public_compartment',
    ]),
  }),
  recipe: boundedIdentity,
  token_budget: z.strictObject({
    limit: positive,
    used: counter,
    counter: z.literal('utf8-bytes-upper-bound-v1'),
  }),
});
export type RecallResult = z.infer<typeof recallResult>;
export const contextRecord = z.strictObject({
  /** Diagnostics recorded by the service, including an empty array when none were observed. */
  /**
   * What the deterministic reply-style check saw in this attempt's own outgoing
   * text. Recorded, never enforced: a violation is a measurement of drift, and
   * blocking an answer because it opened with the wrong word would be a worse
   * failure than the word.
   */
  style_violations: styleViolations,
  id: prefixedId('ctx'),
  space_id: prefixedId('sp'),
  job_id: prefixedId('job'),
  attempt_id: prefixedId('att'),
  job_revision: counter,
  policy_generation: counter,
  data_revision: counter,
  access_generation: counter,
  audience: z.array(memoryAudience),
  purpose: z.string(),
  items: z.array(
    z.strictObject({
      claim_id: claimId,
      revision: positive,
      handle: claimHandle,
      key: memoryKey.nullable().default(null),
      origin_trust: originTrust.default('inferred'),
      sources: z.array(sourceRef),
    }),
  ),
  /**
   * Outputs this attempt produced with no `uses` manifest. They keep the
   * conservative invalidation rule, and saying so here is how a reader knows the
   * precise rule did not apply to them.
   */
  unattributed: z.array(boundedIdentity).default([]),
  disputed_keys: z.array(memoryKey).default([]),
  recipe: boundedIdentity,
  token_budget: recallResult.shape.token_budget,
  recall_status: recallResult.shape.status,
  invalidated_at: timestamp.nullable(),
  created_at: timestamp,
});
export type ContextRecord = z.infer<typeof contextRecord>;

const proposedClaim = {
  domain_key: boundedIdentity,
  /**
   * The registry key the extractor believes this claim occupies. Tier 1 may
   * propose one; it may not invent a shape, and a key outside the registry is a
   * rejection with a reason rather than a claim on a made-up key.
   */
  key: z.string().max(200).optional(),
  content: z.string().min(1).max(16000),
  kind: claimKind,
  factual_status: factualStatus,
  /**
   * Accepted as a hint and recorded, never as a status. No value here makes a
   * claim `checked`; only a Tier-0 extractor can do that.
   */
  confidence: z.number().min(0).max(1).optional(),
  valid_from: timestamp,
  valid_until: timestamp.nullable(),
  sources: z.array(supportingSpan).min(1).max(16),
};
export const extractionProposal = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), expected_revision: z.null(), ...proposedClaim }),
  z.strictObject({
    op: z.literal('supersede'),
    claim_id: claimId,
    expected_revision: positive,
    ...proposedClaim,
  }),
  z.strictObject({
    op: z.literal('retract'),
    claim_id: claimId,
    expected_revision: positive,
    sources: z.array(supportingSpan).min(1).max(16),
  }),
  z.strictObject({ op: z.literal('no-op'), sources: z.array(supportingSpan).max(16) }),
]);
export type ExtractionProposal = z.infer<typeof extractionProposal>;
export const extractionChangeSet = z.strictObject({
  proposals: z.array(extractionProposal).max(32),
});
export const ingestSourceRequest = z.strictObject({
  stream: boundedIdentity,
  source_identity: boundedIdentity,
  source_version: boundedIdentity,
  source_type: sourceType.exclude(['owner_edit']),
  event_at: timestamp,
  /** Declared by the importer: the owner wrote this, or somebody else did. */
  author: z.enum(['owner', 'external']).default('owner'),
  /** The owner's zone, so Tier 0 resolves "Friday" against the right day. */
  time_zone: z.string().min(1).max(120).optional(),
  text: z.string().min(1).max(1000000),
});
export type IngestSourceRequest = z.infer<typeof ingestSourceRequest>;
export const ingestSourceResponse = z.strictObject({
  source: sourceEvent,
  duplicate: z.boolean(),
  committed_sequence: positive,
});
export const correctionRequest = z.strictObject({
  claim_id: claimId,
  expected_revision: positive,
  text: z.string().min(1).max(16000),
  content: z.string().min(1).max(16000),
  valid_from: timestamp,
  valid_until: timestamp.nullable().default(null),
  idempotency_key: boundedIdentity,
});
export type CorrectionRequest = z.infer<typeof correctionRequest>;
export const forgetRequest = z.strictObject({
  claim_id: claimId.optional(),
  all: z.literal(true).optional(),
});
export const claimListResponse = z.strictObject({
  claims: z.array(claim.extend({ current: claimRevision })),
});
export const claimHistoryResponse = z.strictObject({ claim, revisions: z.array(claimRevision) });
export const memoryOperationResponse = z.strictObject({
  generation: spaceGeneration,
  cleanup: z.enum(['pending', 'complete']),
});
export type MemoryOperationResponse = z.infer<typeof memoryOperationResponse>;
export const memoryInvalidationEvent = z.strictObject({
  type: z.enum(['context_invalidated', 'dependencies_invalidated']),
  job_id: prefixedId('job'),
  attempt_id: prefixedId('att').nullable(),
  claim_ids: z.array(claimId),
  data_revision: counter,
});

/** Additive knowledge review API; the stored proposal never independently authorizes a claim. */
export const knowledgeProposalView = z.strictObject({
  id: boundedIdentity,
  path: z.string(),
  diff: z.string(),
  status: z.enum(['pending', 'applied', 'discarded']),
});
export const knowledgeProposalList = z.strictObject({ proposals: z.array(knowledgeProposalView) });
export const ownerKnowledgeEdit = z.strictObject({
  expected_revision: positive,
  frontmatter: knowledgeFrontmatter,
  body: z.string().min(1).max(16000),
  idempotency_key: boundedIdentity,
});
