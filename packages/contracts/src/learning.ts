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
/** Delivery authority is separate from the evaluated task applicability above. */
export const procedurePromotionScope = z.enum(['private', 'space']);
export type ProcedurePromotionScope = z.infer<typeof procedurePromotionScope>;
export const procedurePromotion = z.object({
  scope: procedurePromotionScope.default('private'),
  principal_id: prefixedId('own').nullable().default(null),
});
export type ProcedurePromotion = z.infer<typeof procedurePromotion>;
export const jobLearningScope = z.strictObject({
  scope: procedureScope,
  template_id: label,
  input_refs: z.array(memoryHandle).max(50).default([]),
});
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
  predictedBenefit: z.string(),
  knownRisk: z.string(),
  tests: z.array(z.string()),
  compatibleModels: z.array(z.string()),
  selectedEvaluationId: z.string().nullable(),
  canarySpaceId: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  version: z.number().int(),
  createdAt: timestamp,
});
export const learningSpaceQuery = z.object({ space_id: prefixedId('sp') });
export const learningSpaceRequest = z.strictObject({ space_id: prefixedId('sp') });
export const procedureActivationRequest = learningSpaceRequest.extend({
  scope: procedurePromotionScope.default('private'),
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
