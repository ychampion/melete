/** Additive v0.1 responsibility protocol; the original job/runtime contracts stay stable. */
import { z } from 'zod';
import { errorResponse } from './api.ts';
import { ID_PREFIXES, prefixedId } from './common.ts';
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
