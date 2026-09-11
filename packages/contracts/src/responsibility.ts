/** Additive v0.1 responsibility protocol; the original job/runtime contracts stay stable. */
import { z } from 'zod';
import { createJobRequest, errorResponse } from './api.ts';
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';
import { job } from './entities.ts';
import { apiEvent } from './events.ts';
import { quickOptions } from './experience.ts';
import {
  type AttemptBundle,
  type AttemptOutcome,
  attemptBundle,
  attemptOutcome,
  type EventSink,
  type RuntimeAdapter,
} from './runtime.ts';

export const submissionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
export const inputDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const submissionState = z.enum(['accepted', 'rejected', 'unknown_durability']);
export const submissionReceipt = z.object({
  submission_id: submissionId,
  input_digest: inputDigest.nullable(),
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  job_revision: z.number().int().nonnegative().nullable(),
  event_cursor: z.number().int().nonnegative().nullable(),
  state: submissionState,
});
export type SubmissionReceipt = z.infer<typeof submissionReceipt>;
export const submissionResponse = z.object({ receipt: submissionReceipt });
export const jobSubmissionResponse = z.object({
  job: job.nullable(),
  receipt: submissionReceipt,
  error: errorResponse.shape.error.optional(),
});
export type JobSubmissionResponse = z.infer<typeof jobSubmissionResponse>;

// --------------------------------------------------------------------------
// Attention as a contract: what a question or a notification has to cite
// --------------------------------------------------------------------------

/**
 * A durable handle the service can cite as the reason something needs a person:
 * a persisted event, a knowledge claim, an action, an approval, an attempt, a
 * reply obligation, a submission, a question, a trigger or an operation. It is
 * always a real id in this installation, never prose, so a client can follow it
 * back to the record and the service can refuse a notification that cites
 * nothing.
 */
export const attentionHandle = z
  .string()
  .regex(
    /^(event|claim|action|approval|attempt|obligation|submission|question|trigger|operation|job):[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/,
    'must be a handle such as event:1234 or claim:k_01J0000000000000000000000@3',
  );
export type AttentionHandle = z.infer<typeof attentionHandle>;

/** What happens if nobody acts, in plain language, carrying a date when one exists. */
export const ifIgnored = z.string().min(1).max(2000);

/**
 * One thing the service wants answered. An attempt may produce several; the
 * service asks exactly one of them and keeps the rest for a later wake.
 */
export const questionSpec = z.object({
  text: z.string().min(1).max(4000),
  because: z.array(attentionHandle).min(1).max(50),
  if_ignored: ifIgnored,
  /** True when an external effect cannot happen until this is answered. */
  blocks_external_effect: z.boolean().default(false),
  deadline_at: timestamp.nullable().default(null),
  options: quickOptions.optional(),
});
export type QuestionSpec = z.infer<typeof questionSpec>;
/** What a caller may hand in: the two ranking fields have defaults. */
export type QuestionSpecInput = z.input<typeof questionSpec>;

/** A question the service is holding. `created_at` is what "oldest" is measured on. */
export const deferredQuestion = questionSpec.extend({ created_at: timestamp });
export type DeferredQuestion = z.infer<typeof deferredQuestion>;

export const questionState = z.enum(['open', 'answered', 'withdrawn']);
export type QuestionState = z.infer<typeof questionState>;

/** The guidance every attempt bundle carries, so the model knows the budget is one. */
export const QUESTION_GUIDANCE =
  'You may ask one question. If more than one is needed, ask the one that blocks an ' +
  'external effect or has the nearest deadline; the service keeps the rest and asks ' +
  'them on a later wake.';

export const replyKind = z.enum(['direct', 'quiet']);
export const replyState = z.enum(['owed', 'acknowledged', 'fulfilled', 'needs_retransmission']);
export const replyContent = z.object({
  job_id: prefixedId(ID_PREFIXES.job),
  attempt_id: prefixedId(ID_PREFIXES.attempt),
  kind: z.enum(['answer', 'question', 'status']),
  text: z.string().min(1),
});
export type ReplyContent = z.infer<typeof replyContent>;
export const replyObligation = z.object({
  id: prefixedId('obl'),
  submission_id: submissionId,
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  kind: replyKind,
  state: replyState,
  coalesce_key: z.string(),
  acknowledged_at: timestamp.nullable(),
  fulfilled_at: timestamp.nullable(),
  message: z.string().nullable(),
  created_at: timestamp,
});
export const replyObligationList = z.object({ obligations: z.array(replyObligation) });
export const notification = z.object({
  id: prefixedId('ntf'),
  coalesce_key: z.string(),
  delivery_key: z.string(),
  obligation_ids: z.array(prefixedId('obl')),
  content: replyContent.nullable(),
  content_hash: inputDigest,
  /** The handles that made this necessary. The outbox refuses an empty list. */
  because: z.array(attentionHandle).min(1).max(50),
  if_ignored: ifIgnored,
  delivery_attempt: z.number().int().positive(),
  state: z.enum(['pending', 'attempted', 'delivered', 'superseded']),
  attempted_at: timestamp.nullable(),
  delivered_at: timestamp.nullable(),
  created_at: timestamp,
});
export const notificationList = z.object({ notifications: z.array(notification) });
export const notificationDelivery = z.object({ content_hash: inputDigest });

export const substrateDisposition = z.enum([
  'remote_recoverable',
  'timer_or_event',
  'local_process_interrupted',
  'external_uncertain',
]);
export const schedulingClass = z.enum(['interactive', 'background', 'quiet']);
export type SchedulingClass = z.infer<typeof schedulingClass>;
export const responsibilityImportance = z.enum(['routine', 'important']);
export const attentionStatus = z.enum(['normal', 'frequency_reduced', 'needs_attention']);
export const unreadThreshold = z.number().int().positive().max(1000);
export const responsibilityJob = job.extend({
  substrate_disposition: substrateDisposition,
  scheduling_class: schedulingClass,
  importance: responsibilityImportance,
  unread_results: z.number().int().nonnegative(),
  unread_threshold: unreadThreshold,
  cadence_multiplier: z.number().int().positive(),
  attention_status: attentionStatus,
  visible_status: job.shape.state.or(z.enum(['frequency_reduced', 'needs_attention'])),
  /** Questions this responsibility still wants answered but has not asked yet. */
  deferred_questions: z.array(deferredQuestion).default([]),
});
export const createResponsibilityRequest = createJobRequest.extend({
  scheduling_class: schedulingClass.default('interactive'),
  importance: responsibilityImportance.default('routine'),
  unread_threshold: unreadThreshold.default(3),
});
export type CreateResponsibilityRequest = z.input<typeof createResponsibilityRequest>;
export const responsibilitySubmissionResponse = jobSubmissionResponse.extend({
  job: responsibilityJob.nullable(),
});

/**
 * Where a question came from. A job contributes at most one; memory contributes
 * one per key whose head is disputed. They share a queue because a person has
 * one attention, not one per subsystem.
 */
export const questionSource = z.enum(['job', 'memory']);
export type QuestionSource = z.infer<typeof questionSource>;

/**
 * One entry in the owner's single question queue. Every job contributes at most
 * one, so the queue is a list of responsibilities waiting on a person, not a
 * backlog of prompts from one talkative job. A memory question names the space
 * and key it disputes instead of a job, and `because` carries the two revision
 * handles that disagree.
 */
export const ownerQuestion = deferredQuestion.extend({
  id: prefixedId('qst'),
  source: questionSource,
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  job_title: z.string().nullable(),
  attempt_id: prefixedId(ID_PREFIXES.attempt).nullable(),
  space_id: prefixedId(ID_PREFIXES.space).nullable(),
  key: z.string().max(200).nullable(),
  state: questionState,
  answer: z.string().nullable(),
  answered_at: timestamp.nullable(),
});
export type OwnerQuestion = z.infer<typeof ownerQuestion>;
export const questionList = z.object({ questions: z.array(ownerQuestion) });
/**
 * `choice` names which of the disputed revisions the owner is keeping, and is
 * required for a memory question: prose cannot say which of two revisions was
 * meant, and guessing would write the wrong fact down as a protected
 * correction. A job question ignores it.
 */
export const questionAnswerRequest = z.object({
  text: z.string().min(1).max(10_000),
  choice: z
    .string()
    .regex(/^k_[0-7][0-9A-HJKMNP-TV-Z]{25}@[1-9][0-9]{0,8}$/, 'must be a claim_id@revision handle')
    .optional(),
});
export type QuestionAnswerRequest = z.infer<typeof questionAnswerRequest>;
/**
 * Answering a job question delivers the text to the job as input, so it carries
 * a submission receipt. Answering a memory question settles a key instead, and
 * there is no job to wake and no receipt to hand back.
 */
export const questionAnswerResponse = z.object({
  question: ownerQuestion,
  job: responsibilityJob.nullable(),
  receipt: submissionReceipt.nullable(),
  error: errorResponse.shape.error.optional(),
});
export const jobScheduling = z
  .object({
    scheduling_class: schedulingClass.optional(),
    importance: responsibilityImportance.optional(),
    unread_threshold: unreadThreshold.optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide a scheduling or attention preference.',
  );
export type JobScheduling = z.infer<typeof jobScheduling>;
export const operationRegistration = z.object({
  operation_key: submissionId,
  kind: z.enum(['timer', 'remote_task', 'local_process']),
  due_at: timestamp.optional(),
  remote_ref: z.string().min(1).max(2000).optional(),
  trigger_id: prefixedId(ID_PREFIXES.trigger).optional(),
});
export type OperationRegistration = z.infer<typeof operationRegistration>;
export const operationVersion = z.object({ version: z.number().int().nonnegative() });
export const operationRearm = operationVersion.extend({ due_at: timestamp });
export const operationSettlement = operationVersion.extend({ result: jsonObject });
export const backgroundOperation = z.object({
  id: prefixedId('op'),
  job_id: prefixedId(ID_PREFIXES.job),
  operation_key: submissionId,
  kind: operationRegistration.shape.kind,
  substrate_disposition: substrateDisposition,
  state: z.enum(['registered', 'ready', 'claimed', 'settled', 'interrupted', 'unknown']),
  version: z.number().int().nonnegative(),
  due_at: timestamp,
  remote_ref: z.string().nullable(),
  result: jsonObject.nullable(),
});
export const operationList = z.object({ operations: z.array(backgroundOperation) });

export const responsibilityEvent = apiEvent.extend({
  type: apiEvent.shape.type.or(z.literal('context_invalidated')),
  cursor: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().nullable(),
});
export type ResponsibilityEvent = z.infer<typeof responsibilityEvent>;
export const responsibilitySnapshot = z.object({
  cursor: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().nullable(),
  jobs: z.array(responsibilityJob),
  actions: z.array(
    z.object({
      id: prefixedId(ID_PREFIXES.action),
      job_id: prefixedId(ID_PREFIXES.job),
      status: z.string(),
      dispatched_at: timestamp.nullable(),
      receipt: jsonObject.nullable(),
    }),
  ),
});
export type ResponsibilitySnapshot = z.infer<typeof responsibilitySnapshot>;
export const eventReset = z.object({
  type: z.literal('reset'),
  reason: z.enum(['retention', 'epoch_changed', 'cursor_ahead', 'resync', 'unknown_epoch']),
  cursor: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative().nullable(),
  snapshot: responsibilitySnapshot,
});
export const eventRetentionGap = z.object({
  type: z.literal('gap'),
  reason: z.literal('retention'),
  after: z.number().int().nonnegative(),
  retained_after: z.number().int().nonnegative(),
});

export const contextGenerations = z.object({
  policy_generation: z.number().int().nonnegative(),
  connection_generations: z.record(z.string(), z.number().int().nonnegative()),
});
export type ContextGenerations = z.infer<typeof contextGenerations>;
/**
 * The attention budget an attempt is given. One question per wake, the question
 * already open if there is one, and whatever the service is still holding.
 */
export const attentionBudget = z.object({
  questions_allowed: z.number().int().min(0).max(1),
  guidance: z.string().min(1),
  open_question: ownerQuestion.nullable(),
  deferred_questions: z.array(deferredQuestion),
});
export type AttentionBudget = z.infer<typeof attentionBudget>;
const OPEN_ATTENTION_BUDGET: AttentionBudget = {
  questions_allowed: 1,
  guidance: QUESTION_GUIDANCE,
  open_question: null,
  deferred_questions: [],
};
export const responsibilityAttemptBundle = attemptBundle
  .extend(contextGenerations.shape)
  .extend({ attention: attentionBudget.default(OPEN_ATTENTION_BUDGET) });
export type ResponsibilityAttemptBundle = z.infer<typeof responsibilityAttemptBundle>;

/**
 * An outcome plus the questions the attempt wanted to ask. The frozen outcome is
 * unchanged; a runtime that knows nothing about questions still commits exactly
 * what it always did, and the service reads an empty list.
 */
export const responsibilityAttemptOutcome = z.object({
  outcome: attemptOutcome,
  questions: z.array(questionSpec).max(50).default([]),
});
export type ResponsibilityAttemptOutcome = z.infer<typeof responsibilityAttemptOutcome>;
export type ResponsibilityAttemptOutcomeInput = z.input<typeof responsibilityAttemptOutcome>;
/** What the service accepts at the end of an attempt, old shape or new. */
export type CommittedOutcome = AttemptOutcome | ResponsibilityAttemptOutcomeInput;
export const isOutcomeEnvelope = (
  value: CommittedOutcome,
): value is ResponsibilityAttemptOutcomeInput => !('kind' in value);
export interface QuestioningRuntimeAdapter extends Omit<RuntimeAdapter, 'start'> {
  start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal): Promise<CommittedOutcome>;
}
export const contextInvalidated = z.object({
  type: z.literal('context_invalidated'),
  job_id: prefixedId(ID_PREFIXES.job),
  attempt_id: prefixedId(ID_PREFIXES.attempt),
  policy_generation: z.number().int().nonnegative(),
  connection_id: prefixedId(ID_PREFIXES.connection).nullable(),
  reason: z.enum(['credential_switched', 'connection_revoked', 'policy_changed']),
});
export type ContextInvalidated = z.infer<typeof contextInvalidated>;
export interface ContextAwareRuntimeAdapter extends RuntimeAdapter {
  contextInvalidated?(control: ContextInvalidated): void | Promise<void>;
}
export const connectionLifecycle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revoke'), expected_generation: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('switch'),
    expected_generation: z.number().int().nonnegative(),
    secret_ref: prefixedId(ID_PREFIXES.secret),
  }),
]);
export type ConnectionLifecycle = z.infer<typeof connectionLifecycle>;
export const connectionGeneration = z.object({
  connection_id: prefixedId(ID_PREFIXES.connection),
  generation: z.number().int().nonnegative(),
  policy_generation: z.number().int().nonnegative(),
  status: z.string(),
});
export const policyChange = z.object({ expected_generation: z.number().int().nonnegative() });
export const policyGeneration = z.object({
  space_id: prefixedId(ID_PREFIXES.space),
  policy_generation: z.number().int().nonnegative(),
});
