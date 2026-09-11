/** Additive v0.1 responsibility protocol; the original job/runtime contracts stay stable. */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';
import { job } from './entities.ts';
import { apiEvent } from './events.ts';
import { attemptBundle, type RuntimeAdapter } from './runtime.ts';

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
export const responsibilityJob = job.extend({ substrate_disposition: substrateDisposition });
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
export const responsibilityAttemptBundle = attemptBundle.extend(contextGenerations.shape);
export type ResponsibilityAttemptBundle = z.infer<typeof responsibilityAttemptBundle>;
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
