/** Additive v0.1 responsibility protocol; the original job/runtime contracts stay stable. */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import { ID_PREFIXES, prefixedId, timestamp } from './common.ts';
import { job } from './entities.ts';

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
