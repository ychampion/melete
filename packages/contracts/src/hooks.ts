import { z } from 'zod';
import { timestamp } from './common.ts';

/** Observer boundaries supported by the pinned runtime plus its HTTP failure boundary. */
export const CAPTURED_HOOK_NAMES = [
  'on_session_start',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_api_request',
  'post_api_request',
  'api_request_error',
  'pre_approval_request',
  'post_approval_response',
  'subagent_start',
  'subagent_stop',
  'on_skill_lifecycle',
  'on_stream_start',
  'on_stream_end',
  'pre_verify',
  'on_compaction',
  'runtime_error',
] as const;

/** No free-text payloads: a digest covers redacted argument shape, never argument values. */
export const hookObservation = z.object({
  capture_id: z.string().min(1).max(160),
  name: z.enum(CAPTURED_HOOK_NAMES),
  tool_name: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
    .nullable(),
  timing: z.object({
    captured_at: timestamp,
    duration_ms: z.number().finite().nonnegative().max(86_400_000).nullable(),
  }),
  outcome: z.enum(['started', 'succeeded', 'failed', 'interrupted', 'observed', 'unknown']),
  redacted_args_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  /**
   * Scalars a boundary keeps by name. Absent for every boundary that keeps
   * none, which today is all of them but compaction. Bounded numbers and flags
   * only: a field here can say how much work was done, never what it said.
   */
  detail: z
    .object({
      compression_count: z.number().int().nonnegative().max(1_000_000).optional(),
      in_place: z.boolean().optional(),
    })
    .strict()
    .optional(),
});
export type HookObservation = z.infer<typeof hookObservation>;

/** Exceptions are classified without serializing messages, traces or original payloads. */
export const hookCaptureErrorCode = z.enum(['observer_failed', 'delivery_failed', 'capture_gap']);
