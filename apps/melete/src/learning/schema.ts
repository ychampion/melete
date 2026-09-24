import type {
  ProcedureCaseTemplates,
  ProcedureCheck,
  ProcedureDiscrimination,
  ProcedurePromotion,
  ProcedureStepEvidence,
  ProcedureTrigger,
} from '@melete/contracts';
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
import { attempt, job, principal, space } from '../db/schema.ts';
import type {
  Intervention,
  ProcedureOrigin,
  ProcedureScope,
  ProcedureState,
  VersionEvidence,
} from './contracts.ts';

const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const learningJob = pgTable(
  'learning_job',
  {
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
  },
  (t) => [index('learning_job_scope_idx').on(t.spaceId, t.templateId)],
);
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
    /** What the run produced before the correction, and after it: the only pair
     * that can show a check tells the two apart. Both are erased by forgetting. */
    priorOutput: text('prior_output'),
    correctedOutput: text('corrected_output'),
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
    /** Null exactly when the engine wrote this skill: there is no correction behind it. */
    episodeId: text('episode_id').references(() => episode.id, { onDelete: 'cascade' }),
    origin: text('origin').$type<ProcedureOrigin>().notNull().default('owner_correction'),
    /** The job and the attempt whose work wrote an engine skill. */
    sourceJobId: text('source_job_id').references(() => job.id, { onDelete: 'cascade' }),
    sourceAttemptId: text('source_attempt_id').references(() => attempt.id, {
      onDelete: 'cascade',
    }),
    /** Which of the attempt's five allowances this skill took; the count lives here. */
    ordinal: integer('ordinal'),
    skillName: text('skill_name'),
    description: text('description'),
    /** The claim and source versions the writing job read, so forgetting reaches this skill. */
    inputRefs: jsonb('input_refs').$type<string[]>().notNull().default([]),
    /** Why the owner has to read this skill before it is delivered; null once live. */
    holdReason: text('hold_reason'),
    scope: jsonb('scope').$type<ProcedureScope>().notNull(),
    state: text('state').$type<ProcedureState>().notNull().default('candidate'),
    promotion: jsonb('promotion')
      .$type<ProcedurePromotion>()
      .notNull()
      .default({ scope: 'private', principal_id: null }),
    body: text('body').notNull(),
    bodyHash: text('body_hash').notNull(),
    change: jsonb('change').$type<Record<string, unknown>>().notNull(),
    triggers: jsonb('triggers').$type<ProcedureTrigger[]>().notNull().default([]),
    checks: jsonb('checks').$type<ProcedureCheck[]>().notNull().default([]),
    /** The flattened spans, for audit; the binding copies live inside `change`. */
    evidence: jsonb('evidence').$type<ProcedureStepEvidence[]>().notNull().default([]),
    caseTemplates: jsonb('case_templates').$type<ProcedureCaseTemplates>().notNull().default({}),
    discrimination: jsonb('discrimination').$type<ProcedureDiscrimination>(),
    predictedBenefit: text('predicted_benefit').notNull(),
    knownRisk: text('known_risk').notNull(),
    tests: jsonb('tests').$type<string[]>().notNull(),
    compatibleModels: jsonb('compatible_models').$type<string[]>().notNull(),
    selectedEvaluationId: text('selected_evaluation_id'),
    canarySpaceId: text('canary_space_id'),
    rejectionReason: text('rejection_reason'),
    /** Set while the person has paused it: never delivered, and its state is kept to resume. */
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    /** Set when the person removed it from their list; kept only so the removal can be undone. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
    version: integer('version').notNull().default(0),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('procedure_episode_idx').on(t.episodeId),
    index('procedure_scope_idx').on(t.spaceId, t.state),
    // One decision per skill name per attempt, and five names at most: the
    // database holds both, so a concurrent intake cannot exceed the allowance.
    uniqueIndex('procedure_engine_name_idx').on(t.sourceAttemptId, t.skillName),
    uniqueIndex('procedure_engine_ordinal_idx').on(t.sourceAttemptId, t.ordinal),
    check(
      'procedure_state_check',
      sql`${t.state} in ('candidate','evaluated','enabled_canary','active','superseded','reverted')`,
    ),
    check('procedure_promotion_scope_check', sql`${t.promotion}->>'scope' in ('private', 'space')`),
    check('procedure_origin_check', sql`${t.origin} in ('owner_correction','engine_staged')`),
    check(
      'procedure_engine_shape_check',
      sql`case when ${t.origin} = 'engine_staged' then ${t.episodeId} is null
        and ${t.sourceJobId} is not null and ${t.sourceAttemptId} is not null
        and ${t.skillName} is not null and ${t.ordinal} between 1 and 5
        else ${t.episodeId} is not null and ${t.sourceAttemptId} is null and ${t.ordinal} is null end`,
    ),
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
/**
 * "Don't do this": a standing prohibition one person placed on an engine skill, by
 * the skill's name and by the digest of its body. It holds for that person in
 * every space they belong to, outlives the skill it was placed on, and stands
 * until they lift it. `space_id` records where it was placed.
 */
export const engineSkillProhibition = pgTable(
  'engine_skill_prohibition',
  {
    id: text('id').primaryKey(),
    /**
     * Where it was said, for display. It holds in every space of its person, so a
     * removed space takes only this record of where, never the prohibition.
     */
    spaceId: text('space_id').references(() => space.id, { onDelete: 'set null' }),
    principalId: text('principal_id')
      .notNull()
      .references(() => principal.id, { onDelete: 'cascade' }),
    skillName: text('skill_name').notNull(),
    /** Null when the skill's body was already erased before it was stopped. */
    bodySha256: text('body_sha256'),
    reason: text('reason').notNull(),
    sourceCandidateId: text('source_candidate_id').references(() => procedureCandidate.id, {
      onDelete: 'set null',
    }),
    createdAt: created(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }),
  },
  (t) => [index('engine_skill_prohibition_principal_idx').on(t.principalId)],
);
export const procedureEvaluation = pgTable(
  'procedure_evaluation',
  {
    id: text('id').primaryKey(),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => procedureCandidate.id, { onDelete: 'cascade' }),
    bodyHash: text('body_hash').notNull(),
    phase: text('phase').notNull(),
    suiteId: text('suite_id').notNull().default('records-fixtures/1'),
    suiteHash: text('suite_hash').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    budget: jsonb('budget').$type<Record<string, unknown>>().notNull(),
    passed: boolean('passed').notNull(),
    selectedAt: timestamp('selected_at', { withTimezone: true }),
    createdAt: created(),
  },
  (t) => [uniqueIndex('procedure_evaluation_once_idx').on(t.candidateId, t.bodyHash, t.phase)],
);

/**
 * What learning says to one person: the "keep doing this?" question after a job
 * used a procedure on trial, and the notice that a procedure stopped. Each row
 * carries a reason code and ids only; the words shown are rendered by trusted
 * code when read, and the person's own reason for a "no" lives in the
 * procedure's transition history, which forgetting removes with the procedure.
 */
export const learningNotice = pgTable(
  'learning_notice',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    candidateId: text('candidate_id')
      .notNull()
      .references(() => procedureCandidate.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => job.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'keep_question' | 'reverted'>().notNull(),
    /** The exact definition a question asks about; an answer applies to these bytes only. */
    definitionHash: text('definition_hash').notNull(),
    reasonCode: text('reason_code'),
    state: text('state')
      .$type<'open' | 'answered' | 'withdrawn' | 'read'>()
      .notNull()
      .default('open'),
    answer: text('answer').$type<'yes' | 'no' | 'change'>(),
    /** The correction a "change" opened. */
    episodeId: text('episode_id'),
    createdAt: created(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('learning_notice_principal_idx').on(t.spaceId, t.principalId, t.state),
    uniqueIndex('learning_notice_open_question_idx')
      .on(t.candidateId)
      .where(sql`${t.kind} = 'keep_question' and ${t.state} = 'open'`),
    check('learning_notice_kind_check', sql`${t.kind} in ('keep_question', 'reverted')`),
    check(
      'learning_notice_state_check',
      sql`${t.state} in ('open', 'answered', 'withdrawn', 'read')`,
    ),
    check(
      'learning_notice_answer_check',
      sql`${t.answer} is null or ${t.answer} in ('yes', 'no', 'change')`,
    ),
  ],
);

/**
 * Every change a person makes to what was learned, with the fields it changed
 * before and after, so the latest one can be undone exactly. A source other than
 * corrections adds its own reference column; the change itself is the same shape.
 */
export const learnedChange = pgTable(
  'learned_change',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id')
      .notNull()
      .references(() => space.id, { onDelete: 'cascade' }),
    principalId: text('principal_id').notNull(),
    source: text('source').notNull(),
    itemId: text('item_id').notNull(),
    candidateId: text('candidate_id').references(() => procedureCandidate.id, {
      onDelete: 'cascade',
    }),
    action: text('action').notNull(),
    before: jsonb('before').$type<Record<string, unknown>>().notNull(),
    after: jsonb('after').$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
  },
  (t) => [index('learned_change_principal_idx').on(t.spaceId, t.principalId, t.createdAt)],
);
