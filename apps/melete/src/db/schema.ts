/**
 * The Postgres schema. One table per entity in the contracts package; the
 * migration SQL under apps/melete/drizzle is generated from this file and
 * committed, so a fresh install applies exactly the schema that was reviewed.
 */
import type { DeferredQuestion, RepairTraceEntry } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const owner = pgTable(
  'owner',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    passkey: jsonb('passkey'),
    createdAt: created(),
  },
  () => [uniqueIndex('owner_singleton_idx').on(sql`(true)`)],
);

/** Login identities are independent of the installation's singleton setup guard. */
export const principal = pgTable('principal', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'),
  passkey: jsonb('passkey'),
  createdAt: created(),
});

export const space = pgTable('space', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  policyGeneration: integer('policy_generation').notNull().default(0),
  kind: text('kind').notNull().default('personal'),
  ownerPrincipalId: text('owner_principal_id').references(() => principal.id),
  audience: text('audience').notNull().default('owner'),
  gitPath: text('git_path').notNull(),
  /** Stamped by the fence that begins a removal. A stamped space serves nothing. */
  removedAt: timestamp('removed_at', { withTimezone: true }),
  /**
   * How many removals this space has been through, counting from the one the
   * fence starts. A backup from before a removal carries a smaller number,
   * which is how the startup replay tells the state a removal record is about
   * from state made after it.
   */
  removalEpoch: integer('removal_epoch').notNull().default(0),
  createdAt: created(),
});

/** Revocations retain their row so a regrant never resurrects an old capability. */
export const spaceMembership = pgTable(
  'space_membership',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    generation: integer('generation').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.spaceId] }),
    check('membership_role', sql`${t.role} in ('owner', 'member')`),
    check('membership_generation', sql`${t.generation} >= 0`),
  ],
);

/** The sites a space's browser is signed in to: a name and a time, never a cookie. */
export const browserSiteProfile = pgTable(
  'browser_site_profile',
  {
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    domain: text('domain').notNull(),
    label: text('label').notNull(),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastUsed: timestamp('last_used', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.domain] }),
    check('browser_site_domain_lower', sql`${t.domain} = lower(${t.domain})`),
  ],
);

/**
 * Sealed with MELETE_MASTER_KEY. Nothing outside the connectors module reads
 * this table, and no API response carries a row from it.
 */
export const secret = pgTable('secret', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  ciphertext: text('ciphertext').notNull(),
  createdAt: created(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
});

/**
 * A model provider the owner signed in to, one row per provider for the whole
 * installation. The tokens are one sealed box bound to the provider name and
 * the row's generation. The generation moves on every rotation, so a refresh
 * that read an older generation cannot overwrite a newer one.
 */
export const providerCredential = pgTable('provider_credential', {
  provider: text('provider').primaryKey(),
  ownerId: text('owner_id')
    .notNull()
    .references(() => owner.id, { onDelete: 'cascade' }),
  /** The sealed record's own id, which the box binds alongside the provider and generation. */
  secretId: text('secret_id'),
  /** Empty once a refresh was refused for good; the row then only says why. */
  ciphertext: text('ciphertext'),
  generation: integer('generation').notNull().default(0),
  /** `active`, or `sign_in_required` after the provider refused a refresh. */
  status: text('status').notNull().default('active'),
  reason: text('reason'),
  account: text('account'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }),
  createdAt: created(),
});

export const connection = pgTable(
  'connection',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    label: text('label').notNull(),
    secretRef: text('secret_ref').references(() => secret.id, { onDelete: 'set null' }),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    configuration: jsonb('configuration').$type<Record<string, unknown>>().notNull().default({}),
    setupState: text('setup_state').notNull().default('connected'),
    status: text('status').notNull().default('active'),
    generation: integer('generation').notNull().default(0),
    health: text('health').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index('connection_space_idx').on(t.spaceId)],
);

export const agent = pgTable('agent', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  role: text('role').notNull(),
  colour: text('colour').notNull(),
  surface: text('surface').notNull(),
  eyeColour: text('eye_colour').notNull(),
  tone: text('tone').notNull(),
  standingInstruction: text('standing_instruction').notNull(),
  /** Null reaches every connection in the space, including ones added later; a list narrows it. */
  allowedConnectionIds: jsonb('allowed_connection_ids').$type<string[] | null>(),
  asksBeforeActing: boolean('asks_before_acting').notNull().default(true),
  faceImage: text('face_image'),
  createdAt: created(),
});

export const job = pgTable(
  'job',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    principalId: text('principal_id').references(() => principal.id),
    objective: text('objective').notNull(),
    /**
     * Whose words the objective is, decided where it was written down rather than
     * inferred later from `kind`: a corrective job and an evaluation arm both carry
     * the origin of the text they were given. Null on rows written before this.
     */
    objectiveOrigin: text('objective_origin'),
    kind: text('kind').notNull().default('responsibility'),
    agentId: text('agent_id').references(() => agent.id, { onDelete: 'restrict' }),
    currentTurnId: text('current_turn_id'),
    planId: text('plan_id'),
    experienceParentId: text('experience_parent_id'),
    experienceCommandKey: text('experience_command_key').unique(),
    experienceCategory: text('experience_category'),
    pauseRequested: boolean('pause_requested').notNull().default(false),
    paused: boolean('paused').notNull().default(false),
    experienceCursor: bigint('experience_cursor', { mode: 'number' }).notNull().default(0),
    experienceGroup: jsonb('experience_group').$type<string[]>().notNull().default([]),
    constraints: jsonb('constraints').notNull().default({}),
    state: text('state').notNull().default('queued'),
    revision: integer('revision').notNull().default(0),
    // The fence. Every attempt start bumps it; the broker refuses a stale epoch.
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    // Due time lives here, not only in the queue, so a lost timer is recoverable.
    nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),
    wait: jsonb('wait').notNull().default({ kind: 'none' }),
    substrateDisposition: text('substrate_disposition').notNull().default('timer_or_event'),
    schedulingClass: text('scheduling_class').notNull().default('interactive'),
    importance: text('importance').notNull().default('routine'),
    unreadResults: integer('unread_results').notNull().default(0),
    unreadThreshold: integer('unread_threshold').notNull().default(3),
    cadenceMultiplier: integer('cadence_multiplier').notNull().default(1),
    attentionStatus: text('attention_status').notNull().default('normal'),
    attentionBaseWakeAt: timestamp('attention_base_wake_at', { withTimezone: true }),
    scheduleSkipRemaining: integer('schedule_skip_remaining').notNull().default(0),
    lastResultHash: text('last_result_hash'),
    lastAttentionAttemptId: text('last_attention_attempt_id'),
    // Questions this job wanted to ask but did not, because a wake asks one.
    deferredQuestions: jsonb('deferred_questions')
      .$type<DeferredQuestion[]>()
      .notNull()
      .default([]),
    budget: jsonb('budget').notNull().default({}),
    createdBy: text('created_by').notNull().default('owner'),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    stateVersion: integer('state_version').notNull().default(0),
  },
  (t) => [
    index('job_space_state_idx').on(t.spaceId, t.state),
    // The recovery scan reads this every 60 seconds.
    index('job_next_wake_idx').on(t.nextWakeAt),
  ],
);

export const attempt = pgTable(
  'attempt',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    epoch: integer('epoch').notNull(),
    principalId: text('principal_id').references(() => principal.id),
    membershipGeneration: integer('membership_generation'),
    turnId: text('turn_id'),
    runtimeVersion: text('runtime_version').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    modelActual: text('model_actual'),
    usage: jsonb('usage').notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    outcome: text('outcome'),
    outcomeDetail: jsonb('outcome_detail'),
    contextSnapshotRef: text('context_snapshot_ref'),
    policyGeneration: integer('policy_generation').notNull().default(0),
    connectionGenerations: jsonb('connection_generations')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    revision: integer('revision').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    leaseStatus: text('lease_status').notNull().default('active'),
    substrateDisposition: text('substrate_disposition')
      .notNull()
      .default('local_process_interrupted'),
    runtimeCursor: integer('runtime_cursor').notNull().default(-1),
    inputCursor: bigint('input_cursor', { mode: 'number' }).notNull().default(0),
  },
  (t) => [uniqueIndex('attempt_job_epoch_idx').on(t.jobId, t.epoch)],
);

export const action = pgTable(
  'action',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempt.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    effectClass: text('effect_class').notNull(),
    canonicalPayload: jsonb('canonical_payload').notNull(),
    // The identity of the effect. Approval binds to it; a retry reuses it.
    payloadHash: text('payload_hash').notNull(),
    // sha256(job, revision, connection, kind, payload hash). One action per
    // key: a re-proposal after a crash finds this row instead of making a
    // second one. Null only on rows written before the column existed.
    intentKey: text('intent_key'),
    status: text('status').notNull().default('proposed'),
    authorizationRef: text('authorization_ref'),
    budgetReservation: text('budget_reservation'),
    idempotencyKey: text('idempotency_key').notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receipt: jsonb('receipt'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    reconciliation: jsonb('reconciliation'),
    // What the repair policy did, in order, with the hash of the bytes each
    // attempt put on the wire. Empty for an action that never met a fault.
    repairTrace: jsonb('repair_trace').$type<RepairTraceEntry[]>().notNull().default([]),
    // One counter per fault class met, so a class that keeps recurring is
    // visible without reading a log.
    repairCounters: jsonb('repair_counters').$type<Record<string, number>>().notNull().default({}),
    // Where the last dispatch came to rest. `completed` is the only value that
    // means the effect happened; every other one is a safe stop.
    repairDisposition: text('repair_disposition'),
    // Set when a destination asked to be left alone. The job then waits on a
    // timer rather than on a worker, so nothing spins against a rate limit.
    retryAfterAt: timestamp('retry_after_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    index('action_job_status_idx').on(t.jobId, t.status),
    uniqueIndex('action_idempotency_idx').on(t.idempotencyKey),
    // Postgres lets a unique index hold many nulls, so pre-existing rows are
    // untouched while every new proposal is one effect exactly once.
    uniqueIndex('action_intent_key_idx').on(t.intentKey),
  ],
);

/**
 * A drift mapping is a proposal, never a live change.
 *
 * When a destination renames a field under a working call, re-discovery writes
 * a row here with the mapping it would use and the test that mapping must pass.
 * A candidate becomes `applied` only after its test passes and only for the
 * action that raised it; anything ambiguous becomes `rejected` and the action
 * stops instead. Nothing reads this table to change behaviour on its own.
 */
export const repairCandidate = pgTable(
  'repair_candidate',
  {
    id: text('id').primaryKey(),
    actionId: text('action_id')
      .notNull()
      .references(() => action.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id').notNull(),
    kind: text('kind').notNull(),
    faultKind: text('fault_kind').notNull(),
    state: text('state').notNull().default('candidate'),
    observedSchema: jsonb('observed_schema'),
    /** Old field name to new field name. Nothing else is expressible. */
    proposedMapping: jsonb('proposed_mapping')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    test: jsonb('test').notNull(),
    evaluation: jsonb('evaluation'),
    /** True only for a rename whose every value survives unchanged. */
    safe: boolean('safe').notNull().default(false),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('repair_candidate_action_idx').on(t.actionId, t.state),
    index('repair_candidate_job_idx').on(t.jobId),
    // One candidate per action and mapping: re-running discovery updates the
    // proposal it already made instead of stacking near-identical guesses.
    uniqueIndex('repair_candidate_mapping_idx').on(t.actionId, t.proposedMapping),
  ],
);

export const approval = pgTable(
  'approval',
  {
    id: text('id').primaryKey(),
    actionId: text('action_id')
      .notNull()
      .references(() => action.id, { onDelete: 'cascade' }),
    jobRevision: integer('job_revision').notNull(),
    payloadHash: text('payload_hash').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decision: text('decision'),
    substrateDisposition: text('substrate_disposition').notNull().default('timer_or_event'),
    decidedBy: text('decided_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    // The doubts the person was shown. A decision is bound to this set, so an
    // approval given before an origin was known cannot be spent after.
    originWarnings: jsonb('origin_warnings').notNull().default([]),
  },
  // One live approval per action and payload: re-asking for the same bytes
  // reuses the record instead of stacking duplicates in the inbox.
  (t) => [uniqueIndex('approval_action_hash_idx').on(t.actionId, t.payloadHash)],
);

export const event = pgTable(
  'event',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    jobId: text('job_id').references(() => job.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').references(() => attempt.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    // Null on pre-protocol events: migration must not invent a historical lease.
    epoch: integer('epoch'),
    payload: jsonb('payload').notNull().default({}),
    // Duplicate delivery of the same runtime event writes one row, not two.
    dedupKey: text('dedup_key').notNull(),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('event_dedup_idx').on(t.dedupKey),
    index('event_job_seq_idx').on(t.jobId, t.seq),
  ],
);

export const artifact = pgTable(
  'artifact',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    /**
     * The job whose work this is. `job_id` is nulled when a job row goes away;
     * this one is not a foreign key precisely so it survives that, because it is
     * what "update this with the latest data" resolves against.
     */
    sourceJobId: text('source_job_id'),
    /** `work` is the job's own workspace; `artifacts` is the space directory. */
    area: text('area').notNull().default('work'),
    path: text('path').notNull(),
    kind: text('kind').notNull().default('binary'),
    contentHash: text('content_hash').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    audience: text('audience').notNull().default('owner'),
    /** The template this was produced from, when one was declared. */
    template: text('template'),
    /** The declared expectation, verbatim. Null for a file nobody promised anything about. */
    expectation: jsonb('expectation'),
    /** Handles the content was derived from: action ids, claim handles, artifact ids. */
    evidence: jsonb('evidence').notNull().default([]),
    createdAt: created(),
  },
  (t) => [
    index('artifact_space_idx').on(t.spaceId),
    // The gate reads the latest row per path, so this is the index it walks.
    index('artifact_job_path_idx').on(t.jobId, t.area, t.path, t.createdAt),
  ],
);

/**
 * One validation result, bound to the artifact row and therefore to the exact
 * bytes it was computed over. Re-writing a file makes a new artifact row with
 * its own results rather than editing these, so the history of what was wrong
 * survives the fix.
 */
export const artifactValidation = pgTable(
  'artifact_validation',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    class: text('class').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    detail: text('detail').notNull().default(''),
    evidence: jsonb('evidence').notNull().default({}),
    /** Advisory results are recorded and shown; they never block a completion. */
    advisory: boolean('advisory').notNull().default(false),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    validatedContentHash: text('validated_content_hash'),
  },
  (t) => [
    index('artifact_validation_artifact_idx').on(t.artifactId),
    // One live result per named check per artifact: a human acceptance replaces
    // the pending row it answers rather than sitting beside it.
    uniqueIndex('artifact_validation_name_idx').on(t.artifactId, t.name),
  ],
);

/** Where an artifact went, and what the destination called it when it got there. */
export const artifactPublication = pgTable(
  'artifact_publication',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifact.id, { onDelete: 'cascade' }),
    actionId: text('action_id').notNull(),
    destination: text('destination').notNull(),
    externalRef: text('external_ref'),
    contentHash: text('content_hash').notNull(),
    detail: jsonb('detail').notNull().default({}),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('artifact_publication_artifact_idx').on(t.artifactId),
    uniqueIndex('artifact_publication_action_idx').on(t.actionId),
  ],
);

/**
 * A catalog, not the record. The Markdown file in the space git repository is
 * the source of truth and the FTS index is derived from it.
 */
export const knowledgeRecord = pgTable(
  'knowledge_record',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status').notNull().default('active'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knowledge_space_path_idx').on(t.spaceId, t.path)],
);

export const trigger = pgTable(
  'trigger',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    spec: jsonb('spec').notNull(),
    cursor: text('cursor'),
    enabled: boolean('enabled').notNull().default(true),
    substrateDisposition: text('substrate_disposition').notNull().default('timer_or_event'),
    // The last observation this trigger looked at, so a `changed` clause has
    // something to compare against. Null until the first one arrives, which is
    // why `changed` is false on a feed's first observation: there is no
    // evidence of a change, only evidence of a first sighting.
    lastObservation: jsonb('last_observation'),
    createdAt: created(),
  },
  (t) => [index('trigger_job_idx').on(t.jobId)],
);

/** Reserve before the call, settle after it. Concurrent attempts cannot double-spend. */
export const budgetLedger = pgTable(
  'budget_ledger',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').references(() => attempt.id, { onDelete: 'set null' }),
    actionId: text('action_id').references(() => action.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    reserved: doublePrecision('reserved').notNull(),
    settled: doublePrecision('settled'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('budget_job_idx').on(t.jobId)],
);

export const skill = pgTable(
  'skill',
  {
    id: text('id').primaryKey(),
    // Null for the skills that ship with the release.
    spaceId: text('space_id').references(() => space.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    path: text('path').notNull(),
    frontmatter: jsonb('frontmatter').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [uniqueIndex('skill_space_name_idx').on(t.spaceId, t.name)],
);

export const submission = pgTable('submission', {
  submissionId: text('submission_id').primaryKey(),
  inputDigest: text('input_digest').notNull(),
  principalId: text('principal_id').references(() => principal.id),
  jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
  jobRevision: integer('job_revision'),
  eventCursor: bigint('event_cursor', { mode: 'number' }),
  state: text('state').notNull(),
  httpStatus: integer('http_status').notNull(),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  createdAt: created(),
});

/** Independent of the receipt row and retained beyond event-stream pruning. */
export const acceptanceJournal = pgTable('acceptance_journal', {
  submissionId: text('submission_id').primaryKey(),
  principalId: text('principal_id').references(() => principal.id),
  jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
  receipt: jsonb('receipt').notNull(),
  receiptHash: text('receipt_hash').notNull(),
  createdAt: created(),
});

export const replyObligation = pgTable(
  'reply_obligation',
  {
    id: text('id').primaryKey(),
    submissionId: text('submission_id').notNull().unique(),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    state: text('state').notNull().default('owed'),
    substrateDisposition: text('substrate_disposition').notNull().default('timer_or_event'),
    coalesceKey: text('coalesce_key').notNull(),
    eventCursor: bigint('event_cursor', { mode: 'number' }).notNull(),
    content: jsonb('content'),
    contentHash: text('content_hash'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    message: text('message'),
    createdAt: created(),
  },
  (t) => [index('reply_owed_idx').on(t.state, t.jobId)],
);

export const notification = pgTable(
  'notification',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    coalesceKey: text('coalesce_key').notNull(),
    deliveryKey: text('delivery_key').notNull(),
    obligationIds: jsonb('obligation_ids').notNull(),
    content: jsonb('content'),
    contentHash: text('content_hash').notNull(),
    // Why this had to be sent, and what happens if it is ignored. Both required:
    // a notification nobody can trace back to a record is noise with authority.
    because: jsonb('because').$type<string[]>().notNull().default([]),
    ifIgnored: text('if_ignored').notNull().default('This message has not been delivered yet.'),
    deliveryAttempt: integer('delivery_attempt').notNull(),
    state: text('state').notNull().default('pending'),
    substrateDisposition: text('substrate_disposition').notNull().default('external_uncertain'),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('notification_attempt_idx').on(t.deliveryKey, t.deliveryAttempt),
    index('notification_pending_idx').on(t.state),
    check('notification_because_not_empty', sql`jsonb_array_length(${t.because}) > 0`),
  ],
);

/**
 * The owner's question queue. One open row per job, enforced in the database, so
 * a talkative responsibility cannot turn one queue into its own inbox.
 */
export const question = pgTable(
  'question',
  {
    id: text('id').primaryKey(),
    /** `job` or `memory`. One queue, two things that can put an entry in it. */
    source: text('source').notNull().default('job'),
    /** Null for a memory question: a disputed key belongs to a space, not a job. */
    jobId: text('job_id').references(() => job.id, { onDelete: 'cascade' }),
    attemptId: text('attempt_id').references(() => attempt.id, { onDelete: 'set null' }),
    /** Set together, and only for a memory question: which key is in dispute. */
    spaceId: text('space_id').references(() => space.id, { onDelete: 'cascade' }),
    key: text('key'),
    text: text('text').notNull(),
    because: jsonb('because').$type<string[]>().notNull(),
    ifIgnored: text('if_ignored').notNull(),
    blocksExternalEffect: boolean('blocks_external_effect').notNull().default(false),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    state: text('state').notNull().default('open'),
    answer: text('answer'),
    options: jsonb('options').$type<Array<{ id: string; label: string }>>().notNull().default([]),
    answerSubmissionId: text('answer_submission_id'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('question_open_job_idx').on(t.jobId).where(sql`state = 'open'`),
    // One open question per disputed key, however many conflicting proposals arrive.
    uniqueIndex('question_open_memory_idx')
      .on(t.spaceId, t.key)
      .where(sql`state = 'open' and source = 'memory'`),
    index('question_queue_idx').on(t.state, t.blocksExternalEffect, t.deadlineAt, t.createdAt),
    check('question_because_not_empty', sql`jsonb_array_length(${t.because}) > 0`),
  ],
);

/** Durable registrations are the recovery source; queue messages are disposable hints. */
export const backgroundOperation = pgTable(
  'background_operation',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    operationKey: text('operation_key').notNull(),
    inputDigest: text('input_digest').notNull(),
    policyGeneration: integer('policy_generation').notNull().default(0),
    kind: text('kind').notNull(),
    substrateDisposition: text('substrate_disposition').notNull(),
    state: text('state').notNull().default('registered'),
    version: integer('version').notNull().default(0),
    ownerInstance: text('owner_instance'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull().defaultNow(),
    remoteRef: text('remote_ref'),
    triggerId: text('trigger_id').references(() => trigger.id, { onDelete: 'set null' }),
    result: jsonb('result'),
    createdAt: created(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('operation_job_key_idx').on(t.jobId, t.operationKey),
    index('operation_ready_idx').on(t.state, t.dueAt),
  ],
);

/** Transport retention is separate from the durable event/transcript ledger. */
export const eventRetention = pgTable('event_retention', {
  id: text('id').primaryKey(),
  retainedAfter: bigint('retained_after', { mode: 'number' }).notNull().default(0),
});

export const experienceTurn = pgTable('experience_turn', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => job.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => agent.id),
  submissionId: text('submission_id').notNull().unique(),
  text: text('text').notNull(),
  answer: text('answer').notNull().default(''),
  status: text('status').notNull().default('queued'),
  createdAt: created(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});

export const experienceProfile = pgTable('experience_profile', {
  spaceId: text('space_id')
    .primaryKey()
    .references(() => space.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default(''),
  timeZone: text('time_zone').notNull().default('UTC'),
  dayStart: text('day_start').notNull().default('08:00'),
  dayEnd: text('day_end').notNull().default('22:00'),
});

export const task = pgTable('task', {
  id: text('id').primaryKey(),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  done: boolean('done').notNull().default(false),
  createdAt: created(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const planMilestone = pgTable('plan_milestone', {
  id: text('id').primaryKey(),
  planId: text('plan_id')
    .notNull()
    .references(() => job.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  ordinal: integer('ordinal').notNull(),
  agentId: text('agent_id').references(() => agent.id),
  childJobId: text('child_job_id').references(() => job.id),
  done: boolean('done').notNull().default(false),
  scheduleAt: timestamp('schedule_at', { withTimezone: true }),
});

export const experienceRule = pgTable(
  'experience_rule',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id),
    toolKind: text('tool_kind').notNull(),
    recipient: jsonb('recipient').notNull(),
    recipientClass: text('recipient_class').notNull(),
    originTrust: text('origin_trust').notNull(),
    countCap: integer('count_cap').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    reconsentAfterDays: integer('reconsent_after_days').notNull(),
    used: integer('used').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: created(),
    /**
     * A rule scoped to one job: a chase's follow-ups, covered by the person's
     * approval of its first message, which `sourceActionId` names.
     */
    jobId: text('job_id').references(() => job.id, { onDelete: 'cascade' }),
    sourceActionId: text('source_action_id').references(() => action.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check(
      'experience_rule_bounds',
      sql`${t.countCap} between 1 and 100 and ${t.reconsentAfterDays} between 1 and 30 and ${t.used} between 0 and ${t.countCap}`,
    ),
    check(
      'experience_rule_job_scope',
      sql`${t.originTrust} <> 'person_approved' or (${t.jobId} is not null and ${t.sourceActionId} is not null)`,
    ),
    uniqueIndex('experience_rule_job_idx').on(t.jobId).where(sql`${t.jobId} is not null`),
  ],
);

export const experienceRuleUse = pgTable('experience_rule_use', {
  actionId: text('action_id')
    .primaryKey()
    .references(() => action.id, { onDelete: 'cascade' }),
  ruleId: text('rule_id')
    .notNull()
    .references(() => experienceRule.id),
});

export const experienceUndo = pgTable('experience_undo', {
  actionId: text('action_id')
    .primaryKey()
    .references(() => action.id, { onDelete: 'cascade' }),
  handle: text('handle').notNull().unique(),
  validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
  reversalActionId: text('reversal_action_id').references(() => action.id),
});

export const experienceDraftSend = pgTable('experience_draft_send', {
  draftActionId: text('draft_action_id')
    .primaryKey()
    .references(() => action.id, { onDelete: 'cascade' }),
  sendActionId: text('send_action_id').references(() => action.id),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
});

export const schema = {
  owner,
  principal,
  spaceMembership,
  space,
  secret,
  connection,
  job,
  attempt,
  action,
  repairCandidate,
  approval,
  event,
  artifact,
  artifactValidation,
  artifactPublication,
  knowledgeRecord,
  trigger,
  budgetLedger,
  skill,
  submission,
  acceptanceJournal,
  replyObligation,
  notification,
  question,
  backgroundOperation,
  eventRetention,
  agent,
  experienceTurn,
  experienceProfile,
  task,
  planMilestone,
  experienceRule,
  experienceRuleUse,
  experienceUndo,
  experienceDraftSend,
};
