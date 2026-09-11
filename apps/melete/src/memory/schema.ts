/** New tables only. Content can be erased without destroying operational envelopes. */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { owner, space } from '../db/schema.ts';

const instant = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });
const created = () => instant('created_at').notNull().defaultNow();
export const memorySpaces = pgTable('memory_spaces', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => space.id),
  ownerId: text('owner_id')
    .notNull()
    .references(() => owner.id),
  policyGeneration: integer('policy_generation').notNull().default(1),
  dataRevision: integer('data_revision').notNull().default(0),
  accessGeneration: integer('access_generation').notNull().default(1),
  eligibilityGeneration: integer('eligibility_generation').notNull().default(1),
  restoreReady: boolean('restore_ready').notNull().default(false),
  requireReview: boolean('require_review').notNull().default(false),
  revoked: boolean('revoked').notNull().default(false),
});
export const memoryStreams = pgTable(
  'memory_streams',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    publisher: text('publisher').notNull(),
    stream: text('stream').notNull(),
    committedSequence: integer('committed_sequence').notNull().default(0),
    consumedSequence: integer('consumed_sequence').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.publisher, t.stream] })],
);
export const memorySources = pgTable(
  'memory_sources',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    ownerId: text('owner_id').notNull(),
    publisher: text('publisher').notNull(),
    stream: text('stream').notNull(),
    sourceIdentity: text('source_identity').notNull(),
    sourceVersion: text('source_version').notNull(),
    streamSequence: integer('stream_sequence').notNull(),
    sourceType: text('source_type').notNull(),
    eventAt: instant('event_at').notNull(),
    ingestedAt: instant('ingested_at').notNull().defaultNow(),
    audience: text('audience').notNull(),
    state: text('state').notNull().default('active'),
    eligibilityGeneration: integer('eligibility_generation').notNull(),
    contentLength: integer('content_length').notNull(),
    // Declared by the importer. A message the owner typed and a message somebody
    // else sent are the same source type and a very different trust class.
    author: text('author').notNull().default('owner'),
    originTrust: text('origin_trust').notNull().default('inferred'),
    // The zone Tier 0 resolves relative dates against, captured at import time.
    timeZone: text('time_zone'),
  },
  (t) => [
    uniqueIndex('memory_source_identity').on(
      t.spaceId,
      t.publisher,
      t.stream,
      t.sourceIdentity,
      t.sourceVersion,
    ),
    uniqueIndex('memory_source_sequence').on(t.spaceId, t.publisher, t.stream, t.streamSequence),
    check('memory_source_state', sql`${t.state} in ('active','suppressed','deleted','revoked')`),
    check('memory_source_author', sql`${t.author} in ('owner','external')`),
    check(
      'memory_source_trust',
      sql`${t.originTrust} in ('owner','verified_connector','external_content','inferred')`,
    ),
  ],
);
export const memorySourceContent = pgTable('memory_source_content', {
  sourceId: text('source_id')
    .primaryKey()
    .references(() => memorySources.id),
  content: text('content').notNull(),
});
export const memoryWorkTable = pgTable(
  'memory_work',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    sourceId: text('source_id')
      .notNull()
      .references(() => memorySources.id),
    policyVersion: text('policy_version').notNull(),
    segmentStart: integer('segment_start').notNull(),
    segmentEnd: integer('segment_end').notNull(),
    status: text('status').notNull().default('pending'),
    fence: integer('fence').notNull().default(0),
    leaseUntil: instant('lease_until'),
    continuation: integer('continuation'),
    calls: integer('calls').notNull().default(0),
    reservedUsd: text('reserved_usd').notNull().default('0'),
    errorCode: text('error_code'),
    createdAt: created(),
  },
  (t) => [index('memory_work_pending').on(t.spaceId, t.status, t.leaseUntil)],
);
export const memoryOutbox = pgTable('memory_outbox', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  kind: text('kind').notNull(),
  targetId: text('target_id').notNull(),
  deliveredAt: instant('delivered_at'),
  completedAt: instant('completed_at'),
  failures: integer('failures').notNull().default(0),
  errorCode: text('error_code'),
  createdAt: created(),
});
export const memoryClaims = pgTable(
  'memory_claims',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    domainKey: text('domain_key').notNull(),
    // The registry key, when this claim occupies one.
    key: text('key'),
    audience: text('audience').notNull(),
    headRevision: integer('head_revision').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
  },
  (t) => [
    uniqueIndex('memory_claim_domain_head')
      .on(t.spaceId, t.audience, t.domainKey)
      .where(sql`not ${t.hidden}`),
    // One claim per key, and one active-or-disputed revision per claim below,
    // compose into the property: at most one active head per (space, key,
    // audience). A second head is refused by the database, not by a convention.
    uniqueIndex('memory_claim_key_head')
      .on(t.spaceId, t.audience, t.key)
      .where(sql`${t.key} is not null and not ${t.hidden}`),
  ],
);
export const memoryRevisions = pgTable(
  'memory_revisions',
  {
    claimId: text('claim_id')
      .notNull()
      .references(() => memoryClaims.id),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    factualStatus: text('factual_status').notNull(),
    status: text('status').notNull(),
    protected: boolean('protected').notNull().default(false),
    validFrom: instant('valid_from').notNull(),
    validUntil: instant('valid_until'),
    recordedAt: instant('recorded_at').notNull().defaultNow(),
    supersededAt: instant('superseded_at'),
    dataRevision: integer('data_revision').notNull(),
    // The minimum over this revision's sources. A model never raises it.
    originTrust: text('origin_trust').notNull().default('inferred'),
    // Recorded, never read as a status.
    confidence: text('confidence'),
  },
  (t) => [
    primaryKey({ columns: [t.claimId, t.revision] }),
    check(
      'memory_revision_trust',
      sql`${t.originTrust} in ('owner','verified_connector','external_content','inferred')`,
    ),
    uniqueIndex('memory_one_active_revision')
      .on(t.claimId)
      .where(sql`${t.status} in ('active','disputed')`),
    check('memory_valid_window', sql`${t.validUntil} is null or ${t.validUntil} >= ${t.validFrom}`),
  ],
);
export const memoryRevisionContent = pgTable(
  'memory_revision_content',
  {
    claimId: text('claim_id')
      .notNull()
      .references(() => memoryClaims.id),
    revision: integer('revision').notNull(),
    content: text('content').notNull(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.revision] })],
);
export const memoryReferences = pgTable(
  'memory_references',
  {
    claimId: text('claim_id')
      .notNull()
      .references(() => memoryClaims.id),
    revision: integer('revision').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => memorySources.id),
    sourceVersion: text('source_version').notNull(),
    start: integer('start').notNull(),
    end: integer('end').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.claimId, t.revision, t.sourceId, t.start, t.end] }),
    check('memory_span', sql`${t.start} >= 0 and ${t.end} > ${t.start}`),
  ],
);
export const memoryDerivations = pgTable(
  'memory_derivations',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    inputKind: text('input_kind').notNull(),
    inputId: text('input_id').notNull(),
    inputVersion: text('input_version').notNull(),
    outputKind: text('output_kind').notNull(),
    outputId: text('output_id').notNull(),
    outputVersion: text('output_version').notNull(),
  },
  (t) => [
    primaryKey({
      columns: [
        t.spaceId,
        t.inputKind,
        t.inputId,
        t.inputVersion,
        t.outputKind,
        t.outputId,
        t.outputVersion,
      ],
    }),
  ],
);
export const memorySuppressions = pgTable('memory_suppressions', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  sourceId: text('source_id'),
  publisher: text('publisher'),
  stream: text('stream'),
  sourceIdentity: text('source_identity'),
  start: integer('start'),
  end: integer('end'),
  eligibilityCutoff: integer('eligibility_cutoff').notNull(),
  operation: text('operation').notNull(),
  recordedAt: instant('recorded_at').notNull().defaultNow(),
});
export const memoryManifest = pgTable('memory_index_manifest', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => memorySpaces.spaceId),
  generation: integer('generation').notNull().default(0),
  coverageRevision: integer('coverage_revision').notNull().default(0),
  method: text('method').notNull().default('lexical'),
  recipe: text('recipe').notNull().default('simple-lexical-v1'),
  embedding: jsonb('embedding'),
});
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
export const memoryIndexEntries = pgTable(
  'memory_index_entries',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    generation: integer('generation').notNull(),
    claimId: text('claim_id').notNull(),
    revision: integer('revision').notNull(),
    tokens: tsvector('tokens').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.generation, t.claimId, t.revision] }),
    index('memory_lexical_tokens').using('gin', t.tokens),
  ],
);
export const memoryContexts = pgTable('memory_contexts', {
  styleViolations: jsonb('style_violations').$type<string[]>().notNull().default([]),
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  jobId: text('job_id').notNull(),
  attemptId: text('attempt_id').notNull().unique(),
  jobRevision: integer('job_revision').notNull(),
  policyGeneration: integer('policy_generation').notNull(),
  dataRevision: integer('data_revision').notNull(),
  accessGeneration: integer('access_generation').notNull(),
  audience: jsonb('audience').notNull(),
  purpose: text('purpose').notNull(),
  items: jsonb('items').notNull(),
  recipe: text('recipe').notNull(),
  tokenBudget: jsonb('token_budget').notNull(),
  recallStatus: text('recall_status').notNull(),
  // Outputs this attempt produced with no manifest. They keep the conservative
  // rule, and naming them here is how a reader knows the exact rule did not apply.
  unattributed: jsonb('unattributed').notNull().default([]),
  disputedKeys: jsonb('disputed_keys').notNull().default([]),
  invalidatedAt: instant('invalidated_at'),
  createdAt: created(),
});
export const memoryPrepared = pgTable('memory_prepared', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  jobId: text('job_id'),
  kind: text('kind').notNull(),
  items: jsonb('items').notNull(),
  content: text('content'),
  dataRevision: integer('data_revision').notNull(),
  stale: boolean('stale').notNull().default(false),
});
export const memoryInvalidations = pgTable('memory_invalidations', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  type: text('type').notNull(),
  jobId: text('job_id').notNull(),
  attemptId: text('attempt_id'),
  claimIds: jsonb('claim_ids').notNull(),
  dataRevision: integer('data_revision').notNull(),
  createdAt: created(),
});
export const memoryProposals = pgTable('memory_proposals', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => memorySpaces.spaceId),
  workId: text('work_id').notNull(),
  fence: integer('fence').notNull(),
  payload: jsonb('payload'),
  status: text('status').notNull().default('pending'),
  createdAt: created(),
});
export const memoryProfile = pgTable('memory_profile', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => memorySpaces.spaceId),
  dataRevision: integer('data_revision').notNull(),
  items: jsonb('items').notNull(),
  stale: boolean('stale').notNull().default(false),
});

/**
 * E1. One row per consequential output, with the manifest of handles it used.
 * `attributed` false means the manifest was empty: this output falls back to the
 * conservative rule and is listed on its context record as unattributed.
 */
export const memoryOutputs = pgTable(
  'memory_outputs',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    jobId: text('job_id').notNull(),
    attemptId: text('attempt_id'),
    kind: text('kind').notNull(),
    outputId: text('output_id').notNull(),
    outputVersion: text('output_version').notNull(),
    location: text('location'),
    attributed: boolean('attributed').notNull().default(false),
    stale: boolean('stale').notNull().default(false),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('memory_output_identity').on(t.spaceId, t.kind, t.outputId, t.outputVersion),
    index('memory_output_job').on(t.spaceId, t.jobId),
    check('memory_output_kind', sql`${t.kind} in ('artifact','plan_step','action')`),
  ],
);
/** The manifest itself, one row per handle, so "who cited this revision" is an index lookup. */
export const memoryOutputUses = pgTable(
  'memory_output_uses',
  {
    outputRowId: text('output_row_id')
      .notNull()
      .references(() => memoryOutputs.id),
    handle: text('handle').notNull(),
    handleKind: text('handle_kind').notNull(),
    claimId: text('claim_id'),
    revision: integer('revision'),
    sourceId: text('source_id'),
    sourceVersion: text('source_version'),
  },
  (t) => [
    primaryKey({ columns: [t.outputRowId, t.handle] }),
    index('memory_output_uses_claim').on(t.claimId, t.revision),
    check('memory_output_handle_kind', sql`${t.handleKind} in ('claim','source')`),
  ],
);
/** E1. What the next attempt is told after a correction moved a handle it had used. */
export const memoryRepairBriefs = pgTable(
  'memory_repair_briefs',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    jobId: text('job_id').notNull(),
    key: text('key'),
    changedHandle: text('changed_handle').notNull(),
    replacementHandle: text('replacement_handle'),
    oldValue: text('old_value').notNull(),
    newValue: text('new_value').notNull(),
    affected: jsonb('affected').notNull(),
    state: text('state').notNull().default('pending'),
    createdAt: created(),
  },
  (t) => [
    index('memory_repair_pending').on(t.spaceId, t.jobId, t.state),
    check('memory_repair_state', sql`${t.state} in ('pending','delivered')`),
  ],
);
/** E2. A key with two candidate heads. The alternative is committed, never dropped. */
export const memoryContradictions = pgTable(
  'memory_contradictions',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    key: text('key').notNull(),
    audience: text('audience').notNull(),
    claimId: text('claim_id').notNull(),
    head: text('head').notNull(),
    alternative: text('alternative').notNull(),
    state: text('state').notNull().default('open'),
    questionId: text('question_id'),
    recordedAt: instant('recorded_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_contradiction_open')
      .on(t.spaceId, t.audience, t.key)
      .where(sql`${t.state} = 'open'`),
    check('memory_contradiction_state', sql`${t.state} in ('open','resolved')`),
  ],
);
/**
 * E2/E7. One queued question per contradicted key. `because` holds the two
 * revision handles that disagree; a question with an empty `because` is refused
 * here rather than sent.
 */
export const memoryQuestions = pgTable(
  'memory_questions',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    key: text('key').notNull(),
    question: text('question').notNull(),
    because: jsonb('because').notNull(),
    ifIgnored: text('if_ignored').notNull(),
    state: text('state').notNull().default('queued'),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('memory_question_queued').on(t.spaceId, t.key).where(sql`${t.state} = 'queued'`),
    check('memory_question_state', sql`${t.state} in ('queued','answered','withdrawn')`),
    check('memory_question_because', sql`jsonb_array_length(${t.because}) > 0`),
  ],
);
/** E3. A proposal that failed structural validation, with the reason it failed. */
export const memoryRejections = pgTable(
  'memory_rejections',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    workId: text('work_id').notNull(),
    index: integer('proposal_index').notNull(),
    key: text('key'),
    reason: text('reason').notNull(),
    detail: text('detail').notNull(),
    recordedAt: instant('recorded_at').notNull().defaultNow(),
  },
  (t) => [index('memory_rejection_space').on(t.spaceId, t.recordedAt)],
);

/** A bounded optional dense comparison index; every vector belongs to one manifest generation. */
export const memoryDenseEntries = pgTable(
  'memory_dense_entries',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => memorySpaces.spaceId),
    generation: integer('generation').notNull(),
    claimId: text('claim_id').notNull(),
    revision: integer('revision').notNull(),
    model: text('model').notNull(),
    version: text('version').notNull(),
    dimensions: integer('dimensions').notNull(),
    recipe: text('recipe').notNull(),
    vector: jsonb('vector').notNull(),
  },
  (t) => [primaryKey({ columns: [t.spaceId, t.generation, t.claimId, t.revision] })],
);
