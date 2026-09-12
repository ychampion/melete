import { z } from 'zod';
import { prefixedId } from './common.ts';

/** Bounded durable facts for a replacement attempt; no model-written summary. */
export const sinceLastBrief = z.object({
  previous_attempt_id: prefixedId('att').nullable(),
  evidence_handles: z.array(z.string()).max(50),
  actions: z
    .array(
      z.object({
        action_id: prefixedId('act'),
        status: z.string(),
        receipt_id: z.string().nullable(),
      }),
    )
    .max(50),
  pending_questions: z.array(z.object({ id: z.string(), prompt: z.string() })).max(20),
  pending_approvals: z
    .array(z.object({ approval_id: prefixedId('apr'), action_id: prefixedId('act') }))
    .max(20),
});
export type SinceLastBrief = z.infer<typeof sinceLastBrief>;
