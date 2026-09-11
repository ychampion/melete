import { memoryHandle, prefixedId } from '@melete/contracts';
import { z } from 'zod';

const label = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
/** Scope is owner-selected metadata, never inferred authority or a customer fact. */
export const procedureScope = z.strictObject({
  task_family: label,
  app: label,
  app_version: label,
  role: z.literal('owner'),
  audience: z.literal('private'),
});
export type ProcedureScope = z.infer<typeof procedureScope>;
export const jobLearningScope = z.strictObject({
  scope: procedureScope,
  template_id: label,
  input_refs: z.array(memoryHandle).max(50).default([]),
});
export type JobLearningScope = z.infer<typeof jobLearningScope>;
export const intervention = z.strictObject({
  kind: z.enum(['correction', 'demonstration', 'takeover']),
  text: z.string().min(1).max(8000),
  /** A finite general signal is all the proposer receives from private evidence. */
  signal: z
    .enum(['typed_ordering', 'text_ordering', 'preserve_structure', 'unspecified'])
    .default('unspecified'),
});
export type Intervention = z.infer<typeof intervention>;
export const interventionRequest = intervention.extend({
  idempotency_key: z.string().min(1).max(120),
});
export const episodeId = prefixedId('ep');
export const procedureState = z.enum([
  'candidate',
  'evaluated',
  'enabled_canary',
  'active',
  'superseded',
  'reverted',
]);
export type ProcedureState = z.infer<typeof procedureState>;
export type VersionEvidence = {
  attempt_id: string;
  runtime: string;
  provider: string;
  model_requested: string;
  model_actual: string | null;
  tools: { name: string; version: string }[];
  skills: { name: string; version: string }[];
};
