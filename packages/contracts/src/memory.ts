/** Postgres authorities and rebuildable memory views. Scope is never request metadata. */
import { z } from 'zod';
import { prefixedId, timestamp } from './common.ts';
import { knowledgeFrontmatter } from './knowledge.ts';

const counter = z.number().int().nonnegative();
const positive = z.number().int().positive();
const boundedIdentity = z.string().min(1).max(240);
export const sourceId = prefixedId('src');
// Preserve the inspection surface's stable record identity across revisions.
export const claimId = prefixedId('k');
export const memoryAudience = z.enum(['private', 'space', 'public']);
export const sourceState = z.enum(['active', 'suppressed', 'deleted', 'revoked']);
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
});
export type ClaimRevision = z.infer<typeof claimRevision>;
export const derivation = z.strictObject({
  space_id: prefixedId('sp'),
  input_kind: z.enum(['source', 'claim', 'job']),
  input_id: boundedIdentity,
  input_version: boundedIdentity,
  output_kind: z.enum(['claim', 'context', 'prepared', 'index', 'markdown']),
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
  domain_key: boundedIdentity,
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
    z.strictObject({ claim_id: claimId, revision: positive, sources: z.array(sourceRef) }),
  ),
  recipe: boundedIdentity,
  token_budget: recallResult.shape.token_budget,
  recall_status: recallResult.shape.status,
  invalidated_at: timestamp.nullable(),
  created_at: timestamp,
});
export type ContextRecord = z.infer<typeof contextRecord>;

const proposedClaim = {
  domain_key: boundedIdentity,
  content: z.string().min(1).max(16000),
  kind: claimKind,
  factual_status: factualStatus,
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
