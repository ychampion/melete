import type { ProcedurePromotion } from '@melete/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { attempt, job, space } from '../db/schema.ts';
import type { Intervention, ProcedureScope, ProcedureState, VersionEvidence } from './contracts.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const learningJob = pgTable('learning_job', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => job.id, { onDelete: 'cascade' }),
  spaceId: text('space_id')
    .notNull()
    .references(() => space.id, { onDelete: 'cascade' }),
  scope: jsonb('scope').$type<ProcedureScope>().notNull(),
  templateId: text('template_id').notNull(),
  inputRefs: jsonb('input_refs').$type<string[]>().notNull().default([]),
  createdAt: created(),
});
export const learningAttempt = pgTable('learning_attempt', {
  attemptId: text('attempt_id')
    .primaryKey()
    .references(() => attempt.id, { onDelete: 'cascade' }),
  versions: jsonb('versions').$type<VersionEvidence>().notNull(),
});
export const episode = pgTable(
  'episode',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => job.id, { onDelete: 'cascade' }),
    correctiveJobId: text('corrective_job_id').references(() => job.id, { onDelete: 'set null' }),
    segmentKey: text('segment_key').notNull(),
    inputDigest: text('input_digest').notNull(),
    scope: jsonb('scope').$type<ProcedureScope>().notNull(),
    templateId: text('template_id').notNull(),
    inputRefs: jsonb('input_refs').$type<string[]>().notNull().default([]),
    intervention: jsonb('intervention').$type<Intervention | null>(),
    actor: text('actor').notNull(),
    versions: jsonb('versions').$type<VersionEvidence[]>().notNull().default([]),
    artifacts: jsonb('artifacts').$type<Record<string, unknown>[]>().notNull().default([]),
    receipts: jsonb('receipts').$type<Record<string, unknown>[]>().notNull().default([]),
    judgement: text('judgement').notNull().default('pending'),
    failureClass: text('failure_class'),
    restricted: boolean('restricted').notNull().default(false),
    generationState: text('generation_state').notNull().default('pending'),
    generationStartedAt: timestamp('generation_started_at', { withTimezone: true }),
    createdAt: created(),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
  },
  (t) => [
    uniqueIndex('episode_segment_idx').on(t.jobId, t.segmentKey),
    index('episode_space_idx').on(t.spaceId, t.createdAt),
  ],
);

/** Evidence and transition history are retained on rejection; restriction deletes evidence. */
export const procedureCandidate = pgTable(
  'procedure_candidate',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    episodeId: text('episode_id')
      .notNull()
      .references(() => episode.id, { onDelete: 'cascade' }),
    scope: jsonb('scope').$type<ProcedureScope>().notNull(),
    state: text('state').$type<ProcedureState>().notNull().default('candidate'),
    promotion: jsonb('promotion')
      .$type<ProcedurePromotion>()
      .notNull()
      .default({ scope: 'private', principal_id: null }),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    change: jsonb('change').$type<Record<string, unknown>>().notNull(),
    predictedBenefit: text('predicted_benefit').notNull(),
    knownRisk: text('known_risk').notNull(),
    tests: jsonb('tests').$type<string[]>().notNull(),
    compatibleModels: jsonb('compatible_models').$type<string[]>().notNull(),
    selectedEvaluationId: text('selected_evaluation_id'),
    canarySpaceId: text('canary_space_id'),
    rejectionReason: text('rejection_reason'),
    version: integer('version').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('procedure_episode_idx').on(t.episodeId),
    index('procedure_scope_idx').on(t.spaceId, t.state),
    check(
      'procedure_state_check',
      sql`${t.state} in ('candidate','evaluated','enabled_canary','active','superseded','reverted')`,
    ),
    check('procedure_promotion_scope_check', sql`${t.promotion}->>'scope' in ('private', 'space')`),
  ],
);
export const procedureTransition = pgTable('procedure_transition', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id')
    .notNull()
    .references(() => procedureCandidate.id, { onDelete: 'cascade' }),
  fromState: text('from_state'),
  toState: text('to_state').$type<ProcedureState>().notNull(),
  actor: text('actor').notNull(),
  reason: text('reason').notNull(),
  createdAt: created(),
});
export const procedureEvaluation = pgTable(
  'procedure_evaluation',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => procedureCandidate.id, { onDelete: 'cascade' }),
    bodyHash: text('body_hash').notNull(),
    phase: text('phase').notNull(),
    suiteHash: text('suite_hash').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    budget: jsonb('budget').$type<Record<string, unknown>>().notNull(),
    passed: boolean('passed').notNull(),
    selectedAt: timestamp('selected_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('procedure_evaluation_once_idx').on(t.candidateId, t.bodyHash, t.phase)],
);
