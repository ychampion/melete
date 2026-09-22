/** Additive procedure learning vocabulary; facts and authority remain separate. */
import { z } from 'zod';
import { prefixedId, timestamp } from './common.ts';
import { memoryHandle } from './memory.ts';

const label = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
export const procedureScope = z.strictObject({
  task_family: label,
  app: label,
  app_version: label,
  role: z.literal('owner'),
  audience: z.literal('private'),
});
export type ProcedureScope = z.infer<typeof procedureScope>;
/**
 * The evaluator synthesises its own scope probes under these names, so a job
 * may not register one: a client that could claim `procedure-scope` would forge
 * the evidence row the promoter reads back.
 */
export const RESERVED_TASK_FAMILIES = [
  'procedure-scope',
  'source-authority',
  'forgetting-and-access',
] as const;
/** Delivery authority is separate from the evaluated task applicability above. */
export const procedurePromotionScope = z.enum(['private', 'space']);
export type ProcedurePromotionScope = z.infer<typeof procedurePromotionScope>;
export const procedurePromotion = z.object({
  scope: procedurePromotionScope.default('private'),
  principal_id: prefixedId('own').nullable().default(null),
  /**
   * Absent for delivery earned by evaluation. `owner_trial` is the owner approving the
   * exact definition by its hash: private to that owner in the origin space, and never
   * enough on its own to share. `owner_confirmed` is that owner answering "yes, keep
   * doing this" after a job used the trial: the same private reach, made lasting.
   */
  basis: z.enum(['evaluation', 'owner_trial', 'owner_confirmed']).optional(),
  definition_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  approved_at: timestamp.optional(),
});
export type ProcedurePromotion = z.infer<typeof procedurePromotion>;
export const jobLearningScope = z
  .strictObject({
    scope: procedureScope,
    template_id: label,
    input_refs: z.array(memoryHandle).max(50).default([]),
  })
  .refine(
    (value) => !(RESERVED_TASK_FAMILIES as readonly string[]).includes(value.scope.task_family),
    'reserved_task_family',
  );
export type JobLearningScope = z.infer<typeof jobLearningScope>;
export const intervention = z.strictObject({
  kind: z.enum(['correction', 'demonstration', 'takeover']),
  text: z.string().min(1).max(8000),
  signal: z
    .enum(['typed_ordering', 'text_ordering', 'preserve_structure', 'unspecified'])
    .default('unspecified'),
});
export type Intervention = z.infer<typeof intervention>;
export const interventionRequest = intervention.extend({
  idempotency_key: z.string().min(1).max(120),
});
/**
 * A check is a typed assertion, never a pattern and never code. A model-authored
 * regular expression would be a program whose cost and meaning a reviewer cannot
 * bound by reading it, so the definition hash would bind its bytes without
 * binding what it does. Literal phrases and a closed format vocabulary cover the
 * corrections people actually make; widening this union is a reviewed commit.
 */
const phrase = z.string().min(2).max(60);
const bounded = <T extends z.ZodObject>(shape: T) =>
  shape.refine(
    (value: { min?: number; max?: number }) =>
      (value.min !== undefined || value.max !== undefined) &&
      (value.min === undefined || value.max === undefined || value.min <= value.max),
    'a count check needs at least one bound, and min may not exceed max',
  );
export const procedureCheck = z.discriminatedUnion('kind', [
  bounded(
    z.strictObject({
      kind: z.literal('word_count'),
      min: z.number().int().min(0).max(10000).optional(),
      max: z.number().int().min(1).max(10000).optional(),
    }),
  ),
  bounded(
    z.strictObject({
      kind: z.literal('char_count'),
      min: z.number().int().min(0).max(65536).optional(),
      max: z.number().int().min(1).max(65536).optional(),
    }),
  ),
  bounded(
    z.strictObject({
      kind: z.literal('line_count'),
      min: z.number().int().min(0).max(1000).optional(),
      max: z.number().int().min(1).max(1000).optional(),
    }),
  ),
  z.strictObject({ kind: z.literal('required_phrase'), phrase }),
  z.strictObject({ kind: z.literal('forbidden_phrase'), phrase }),
  z.strictObject({
    kind: z.literal('output_format'),
    form: z.enum(['bullets', 'numbered', 'paragraphs', 'table', 'json']),
  }),
  z.strictObject({
    kind: z.literal('required_sections'),
    headings: z.array(phrase).min(1).max(5),
    ordered: z.boolean().default(true),
  }),
  z.strictObject({
    kind: z.literal('records_sorted'),
    key: phrase,
    type: z.enum(['number', 'text', 'date']),
    direction: z.enum(['ascending', 'descending']),
    preserve_rows: z.boolean().default(true),
  }),
  /** Parameterless: only a bundled fixture suite can supply the expected identities. */
  z.strictObject({ kind: z.literal('records_expected_order') }),
  z.strictObject({ kind: z.literal('action_kind_absent'), action_kind: phrase }),
  z.strictObject({
    kind: z.literal('action_kind_max'),
    action_kind: phrase,
    max: z.number().int().min(0).max(20),
  }),
  z.strictObject({
    kind: z.literal('action_kind_present'),
    action_kind: phrase,
    min: z.number().int().min(1).max(20).default(1),
  }),
]);
export type ProcedureCheck = z.infer<typeof procedureCheck>;
export const PROCEDURE_CHECK_KINDS = [
  'word_count',
  'char_count',
  'line_count',
  'required_phrase',
  'forbidden_phrase',
  'output_format',
  'required_sections',
  'records_sorted',
  'records_expected_order',
  'action_kind_absent',
  'action_kind_max',
  'action_kind_present',
] as const;

/** A span of the owner's own words, with exact UTF-16 offsets into the whole source. */
export const procedureStepEvidence = z.strictObject({
  source: z.enum(['intervention', 'objective']),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(3).max(240),
  /** Set when the step text is the quote itself because a paraphrase was not supported. */
  fallback: z.literal('verbatim').optional(),
});
export type ProcedureStepEvidence = z.infer<typeof procedureStepEvidence>;
export const procedureStep = z.strictObject({
  text: z.string().min(3).max(240),
  evidence: procedureStepEvidence,
});
export type ProcedureStep = z.infer<typeof procedureStep>;
export const procedureTrigger = z.strictObject({
  phrase: z.string().min(3).max(60),
  evidence: procedureStepEvidence,
});
export type ProcedureTrigger = z.infer<typeof procedureTrigger>;
/** Digests of normalised objectives, so binding case identity leaks no owner text. */
export const procedureCaseTemplates = z.strictObject({
  validation: z.array(z.string()).max(20).optional(),
  final_pool: z.array(z.string()).max(20).optional(),
});
export type ProcedureCaseTemplates = z.infer<typeof procedureCaseTemplates>;
/**
 * Whether the admitted checks tell the corrected answer from the one the owner
 * objected to. `none` means there were no checks to run, which is the only
 * shape an owner may still try by hand; automated evaluation needs `passed`.
 */
/**
 * What one proposal call may return. Strict at every level: an extra key throws
 * rather than being ignored, and the span carries no `fallback` field, because
 * only trusted code may decide that a step keeps the owner's words verbatim.
 */
const proposalSpan = z.strictObject({
  source: z.enum(['intervention', 'objective']),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(3).max(240),
});
export const procedureProposal = z.strictObject({
  target: z.literal('skill_body'),
  steps: z
    .array(z.strictObject({ text: z.string().min(3).max(240), evidence: proposalSpan }))
    .min(1)
    .max(6),
  triggers: z
    .array(z.strictObject({ phrase: z.string().min(3).max(60), evidence: proposalSpan }))
    .min(1)
    .max(4),
  /** A correction about tone may have no checkable form, so none is a valid answer. */
  checks: z.array(procedureCheck).min(0).max(6),
  variant_objectives: z.array(z.string().min(10).max(200)).max(4).default([]),
});
export type ProcedureProposal = z.infer<typeof procedureProposal>;

export const procedureDiscrimination = z.strictObject({
  status: z.enum(['passed', 'failed', 'none']),
  detail: z.string(),
  prior_failed: z.number().int().nonnegative().nullable(),
  corrected_failed: z.number().int().nonnegative().nullable(),
  empty_failed: z.number().int().nonnegative(),
  junk_failed: z.number().int().nonnegative(),
});
export type ProcedureDiscrimination = z.infer<typeof procedureDiscrimination>;

export const episodeId = prefixedId('ep');
export const procedureId = prefixedId('pc');
export const procedureState = z.enum([
  'candidate',
  'evaluated',
  'enabled_canary',
  'active',
  'superseded',
  'reverted',
]);
export type ProcedureState = z.infer<typeof procedureState>;
export const versionEvidence = z.object({
  attempt_id: prefixedId('att'),
  runtime: z.string(),
  provider: z.string(),
  model_requested: z.string(),
  model_actual: z.string().nullable(),
  tools: z.array(z.object({ name: z.string(), version: z.string() })),
  skills: z.array(z.object({ name: z.string(), version: z.string() })),
});
export type VersionEvidence = z.infer<typeof versionEvidence>;
const object = z.record(z.string(), z.unknown());
export const episodeRecord = z.object({
  id: episodeId,
  spaceId: prefixedId('sp'),
  jobId: prefixedId('job'),
  segmentKey: z.string(),
  inputDigest: z.string(),
  scope: procedureScope,
  templateId: z.string(),
  inputRefs: z.array(z.string()),
  intervention: intervention.nullable(),
  actor: z.string(),
  versions: z.array(versionEvidence),
  artifacts: z.array(object),
  receipts: z.array(object),
  judgement: z.string(),
  failureClass: z.string().nullable(),
  restricted: z.boolean(),
  generationState: z.string(),
  generationStartedAt: timestamp.nullable(),
  createdAt: timestamp,
  expiresAt: timestamp,
  correctiveJobId: prefixedId('job').nullable().optional(),
});
export const procedureRecord = z.object({
  id: procedureId,
  spaceId: prefixedId('sp'),
  episodeId,
  scope: procedureScope,
  promotion: procedurePromotion.default({ scope: 'private', principal_id: null }),
  state: procedureState,
  body: z.string(),
  bodyHash: z.string(),
  change: object,
  triggers: z.array(procedureTrigger).default([]),
  checks: z.array(procedureCheck).default([]),
  evidence: z.array(procedureStepEvidence).default([]),
  caseTemplates: procedureCaseTemplates.default({}),
  discrimination: procedureDiscrimination.nullable().default(null),
  predictedBenefit: z.string(),
  knownRisk: z.string(),
  tests: z.array(z.string()),
  compatibleModels: z.array(z.string()),
  selectedEvaluationId: z.string().nullable(),
  canarySpaceId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  pausedAt: timestamp.nullable().default(null),
  removedAt: timestamp.nullable().default(null),
  version: z.number().int(),
  createdAt: timestamp,
});
export const learningSpaceQuery = z.object({ space_id: prefixedId('sp') });
export const learningSpaceRequest = z.strictObject({ space_id: prefixedId('sp') });
export const procedureActivationRequest = learningSpaceRequest.extend({
  scope: procedurePromotionScope.default('private'),
});
/** The owner approves the definition they were shown, by its hash, not whatever is current. */
export const procedureTrialRequest = learningSpaceRequest.extend({
  definition_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const procedureReasonRequest = learningSpaceRequest.extend({
  reason: z.string().min(1).max(500),
});
export const episodeListResponse = z.object({ episodes: z.array(episodeRecord) });
export const interventionResponse = z.object({ episode: episodeRecord });
export const procedureListResponse = z.object({ procedures: z.array(procedureRecord) });
export const procedureResponse = z.object({ candidate: procedureRecord });
export const procedureInspection = z.object({
  candidate: procedureRecord,
  history: z.array(
    z.object({
      id: z.string(),
      candidateId: procedureId,
      fromState: z.string().nullable(),
      toState: procedureState,
      actor: z.string(),
      reason: z.string(),
      createdAt: timestamp,
    }),
  ),
  evaluations: z.array(
    z.object({
      id: z.string(),
      phase: z.string(),
      passed: z.boolean(),
      budget: object,
      createdAt: timestamp,
      selectedAt: timestamp.nullable(),
    }),
  ),
});
export const learningDeletionResponse = z.object({ deleted: z.literal(true) });
export const learningScopeResponse = z.object({
  jobId: prefixedId('job'),
  spaceId: prefixedId('sp'),
  scope: procedureScope,
  templateId: z.string(),
  inputRefs: z.array(z.string()),
  createdAt: timestamp,
});

/**
 * The person's own view of what was learned. Everything here is plain language
 * rendered by trusted code from the stored definition; evaluation records and
 * model output never appear. Corrections are one source; another source joins
 * the same list with its own `source` value.
 */
export const learnedSource = z.enum(['correction']);
export type LearnedSource = z.infer<typeof learnedSource>;
/**
 * `proposed`: learned from a correction and waiting for the person to try it.
 * `trial`: used on the person's own work until they say to keep it or not.
 * `active`: kept. `paused`: kept but not used until resumed. `reverted`: stopped,
 * with the reason in `reason`.
 */
export const learnedState = z.enum(['proposed', 'trial', 'active', 'paused', 'reverted']);
export type LearnedState = z.infer<typeof learnedState>;
/** `share` appears only on something kept that has sealed evidence, in a shared space. */
export const learnedAction = z.enum(['try', 'pause', 'resume', 'remove', 'share']);
export type LearnedAction = z.infer<typeof learnedAction>;
export const learnedChangeAction = z.enum(['pause', 'resume', 'remove', 'keep', 'decline']);
export type LearnedChangeAction = z.infer<typeof learnedChangeAction>;
export const learnedItem = z.strictObject({
  id: z.string(),
  source: learnedSource,
  /** A short name, from where it applies. */
  name: z.string(),
  /** What it does, step by step, in the person's own words. */
  does: z.array(z.string()),
  /** The phrases in a request that make it apply. Empty means every request of its kind. */
  applies_when: z.array(z.string()),
  space_id: prefixedId('sp'),
  /** False while it reaches only the person who taught it. */
  shared: z.boolean(),
  state: learnedState,
  /** Why it stopped, in plain words, when `state` is `reverted`. */
  reason: z.string().nullable(),
  reason_code: z.string().nullable(),
  /** What trying it approves: these exact bytes, and no later version. */
  definition_hash: z.string(),
  learned_at: timestamp,
  /**
   * When it leaves the list with the correction it came from. Null once the person
   * said to keep it: what they kept does not expire.
   */
  expires_at: timestamp.nullable(),
  /** True within a week of `expires_at`, so the list can say it is about to go. */
  expiring_soon: z.boolean(),
  /** What the person can do with it now. */
  actions: z.array(learnedAction),
});
export type LearnedItem = z.infer<typeof learnedItem>;
export const learnedChange = z.strictObject({
  id: z.string(),
  item_id: z.string(),
  source: learnedSource,
  action: learnedChangeAction,
  name: z.string(),
  created_at: timestamp,
});
export type LearnedChange = z.infer<typeof learnedChange>;
export const learnedList = z.strictObject({
  items: z.array(learnedItem),
  /** The person's latest change in this space that can still be undone. */
  last_change: learnedChange.nullable(),
});
export const learnedItemResponse = z.strictObject({
  /** Null once removed: a removed item leaves the list until the removal is undone. */
  item: learnedItem.nullable(),
  change: learnedChange.nullable(),
});
/** Undo names the change the person saw, so a newer change is never undone by mistake. */
export const learnedUndoRequest = learningSpaceRequest.extend({ change_id: z.string().min(1) });
export const learnedTryRequest = procedureTrialRequest;

export const learningNoticeId = prefixedId('ln');
const keepOption = z.strictObject({ id: z.enum(['yes', 'no', 'change']), label: z.string() });
/**
 * `keep_question`: asked once after a job used something on trial, answered yes,
 * no or change. `reverted`: something stopped being used, and why.
 */
export const learningNotice = z.discriminatedUnion('kind', [
  z.strictObject({
    id: learningNoticeId,
    kind: z.literal('keep_question'),
    item_id: z.string(),
    name: z.string(),
    text: z.string(),
    options: z.array(keepOption),
    job_id: prefixedId('job').nullable(),
    state: z.enum(['open', 'answered', 'withdrawn']),
    answer: z.enum(['yes', 'no', 'change']).nullable(),
    created_at: timestamp,
  }),
  z.strictObject({
    id: learningNoticeId,
    kind: z.literal('reverted'),
    item_id: z.string(),
    name: z.string(),
    text: z.string(),
    reason_code: z.string(),
    job_id: prefixedId('job').nullable(),
    state: z.enum(['open', 'read']),
    created_at: timestamp,
  }),
]);
export type LearningNotice = z.infer<typeof learningNotice>;
export const learningNoticeList = z.strictObject({ notices: z.array(learningNotice) });
export const learningNoticeResponse = z.strictObject({ notice: learningNotice });
export const keepAnswerRequest = z.discriminatedUnion('answer', [
  learningSpaceRequest.extend({ answer: z.literal('yes') }),
  learningSpaceRequest.extend({
    answer: z.literal('no'),
    reason: z.string().min(1).max(500).optional(),
  }),
  /** The person's own words for what to do differently; they become a correction. */
  learningSpaceRequest.extend({ answer: z.literal('change'), text: z.string().min(1).max(8000) }),
]);
export type KeepAnswerRequest = z.infer<typeof keepAnswerRequest>;
export const keepAnswerResponse = z.strictObject({
  notice: learningNotice,
  item: learnedItem.nullable(),
  /** The correction a "change" answer opened. */
  episode_id: episodeId.nullable(),
});
