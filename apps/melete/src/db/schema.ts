/**
 * The Postgres schema. One table per entity in the contracts package; the
 * migration SQL under apps/melete/drizzle is generated from this file and
 * committed, so a fresh install applies exactly the schema that was reviewed.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
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

export const space = pgTable('space', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('personal'),
  // Reserved so shared spaces can arrive without a rewrite. Always "owner" in v0.1.
  audience: text('audience').notNull().default('owner'),
  gitPath: text('git_path').notNull(),
  createdAt: created(),
});

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
    status: text('status').notNull().default('active'),
    health: text('health').notNull().default('unknown'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [index('connection_space_idx').on(t.spaceId)],
);

export const job = pgTable(
  'job',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    objective: text('objective').notNull(),
    constraints: jsonb('constraints').notNull().default({}),
    state: text('state').notNull().default('queued'),
    revision: integer('revision').notNull().default(0),
    // The fence. Every attempt start bumps it; the broker refuses a stale epoch.
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    // Due time lives here, not only in the queue, so a lost timer is recoverable.
    nextWakeAt: timestamp('next_wake_at', { withTimezone: true }),
    wait: jsonb('wait').notNull().default({ kind: 'none' }),
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
    revision: integer('revision').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    leaseStatus: text('lease_status').notNull().default('active'),
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
    status: text('status').notNull().default('proposed'),
    authorizationRef: text('authorization_ref'),
    budgetReservation: text('budget_reservation'),
    idempotencyKey: text('idempotency_key').notNull(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    receipt: jsonb('receipt'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    reconciliation: jsonb('reconciliation'),
    createdAt: created(),
  },
  (t) => [
    index('action_job_status_idx').on(t.jobId, t.status),
    uniqueIndex('action_idempotency_idx').on(t.idempotencyKey),
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
    decidedBy: text('decided_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
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
    path: text('path').notNull(),
    contentHash: text('content_hash').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    audience: text('audience').notNull().default('owner'),
    createdAt: created(),
  },
  (t) => [index('artifact_space_idx').on(t.spaceId)],
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
  jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
  receipt: jsonb('receipt').notNull(),
  receiptHash: text('receipt_hash').notNull(),
  createdAt: created(),
});

export const schema = {
  owner,
  space,
  secret,
  connection,
  job,
  attempt,
  action,
  approval,
  event,
  artifact,
  knowledgeRecord,
  trigger,
  budgetLedger,
  skill,
  submission,
  acceptanceJournal,
};
