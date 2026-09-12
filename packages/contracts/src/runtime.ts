/**
 * The runtime contract. A runtime is a disposable process that runs exactly one
 * bounded attempt and then commits an outcome. Anything it wants to do in the
 * world goes through the broker; anything it wants remembered is an event the
 * service persists before fan-out.
 */
import { z } from 'zod';
import { effectClass } from './broker.ts';
import { ID_PREFIXES, jsonObject, jsonSchema, prefixedId, timestamp } from './common.ts';
import { sinceLastBrief } from './delta.ts';
import { attemptUsage, waitSpec } from './entities.ts';
import { claimHandle, memoryKey, originTrust } from './memory.ts';
import { repairBrief } from './provenance.ts';

export const runtimeCapabilities = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  interrupt: z.boolean(),
  version: z.string(),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilities>;

/** Provider-agnostic message shape. Nothing provider-specific reaches the transcript. */
export const canonicalMessage = z.object({
  role: z.enum(['user', 'assistant', 'tool', 'system']),
  content: z.string(),
  tool_call_id: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  at: timestamp,
});
export type CanonicalMessage = z.infer<typeof canonicalMessage>;

/** One entry in the compact catalog, already filtered by the job's scopes. */
export const toolSpec = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  input_schema: jsonSchema,
  effect_class: effectClass,
  connection_id: prefixedId(ID_PREFIXES.connection).nullable(),
});
export type ToolSpec = z.infer<typeof toolSpec>;

export const skillPayload = z.object({
  name: z.string().min(1),
  body: z.string(),
});
export type SkillPayload = z.infer<typeof skillPayload>;

export const knowledgeExcerpt = z.object({
  path: z.string().min(1),
  excerpt: z.string(),
  /**
   * The stable handle of the revision this excerpt came from, as claim_id at
   * revision. It is what the attempt cites in the manifest of anything it
   * writes, and what a later correction matches against.
   */
  handle: claimHandle.optional(),
  key: memoryKey.nullable().default(null),
  origin_trust: originTrust.default('inferred'),
  /** An open contradiction on this key: do not act externally on it without approval. */
  disputed: z.boolean().default(false),
  provenance: z.object({
    id: prefixedId(ID_PREFIXES.knowledge),
    asserted_by: z.string(),
    observed_at: z.string(),
    status: z.string(),
  }),
});
export type KnowledgeExcerpt = z.infer<typeof knowledgeExcerpt>;

/**
 * Everything one attempt is given, and nothing more. The order matters for
 * prompt caching: stable prefix first, volatile inputs last.
 */
export const attemptBundle = z.object({
  attempt: z.object({
    id: prefixedId(ID_PREFIXES.attempt),
    job_id: prefixedId(ID_PREFIXES.job),
    epoch: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    /** Capability JWT; the broker checks it on every call. */
    token: z.string().min(1),
  }),
  job: z.object({
    title: z.string(),
    objective: z.string(),
    constraints: jsonObject,
    progress_summary: z.string(),
    unresolved_questions: z.array(z.string()),
    deliverable: jsonObject,
  }),
  /** What changed since the last attempt: the reason this wake exists. */
  inputs: z.object({
    since_last: sinceLastBrief.optional(),
    new_user_messages: z.array(canonicalMessage),
    approval_results: z.array(
      z.object({
        action_id: prefixedId(ID_PREFIXES.action),
        decision: z.enum(['approved', 'denied']),
        note: z.string().nullable(),
      }),
    ),
    trigger_events: z.array(jsonObject),
    /**
     * What a correction broke and where. Each brief names the handle that moved,
     * the value before and after, and the outputs that cited the old revision.
     */
    repair_briefs: z.array(repairBrief).default([]),
  }),
  transcript: z.array(canonicalMessage),
  tools: z.array(toolSpec),
  skills: z.array(skillPayload),
  knowledge: z.array(knowledgeExcerpt),
  workspace: z.object({
    mount: z.literal('/work'),
    files: z.array(z.string()),
  }),
  budget: z.object({
    max_turns: z.number().int().positive(),
    max_input_tokens: z.number().int().nonnegative().optional(),
    max_output_tokens: z.number().int().positive(),
    max_wall_ms: z.number().int().positive(),
    max_actions: z.number().int().nonnegative(),
  }),
  model: z.object({
    provider: z.string(),
    model: z.string(),
    fallback: z.object({ provider: z.string(), model: z.string() }).nullable(),
  }),
});
export type AttemptBundle = z.infer<typeof attemptBundle>;

export const evidenceRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), artifact_id: prefixedId(ID_PREFIXES.artifact) }),
  z.object({ kind: z.literal('action'), action_id: prefixedId(ID_PREFIXES.action) }),
  z.object({ kind: z.literal('knowledge'), record_id: prefixedId(ID_PREFIXES.knowledge) }),
]);
export type EvidenceRef = z.infer<typeof evidenceRef>;

/** How an attempt ends. There is no other way out. */
export const attemptOutcome = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('completed'),
    summary: z.string(),
    evidence: z.array(evidenceRef),
  }),
  z.object({
    kind: z.literal('waiting_for_input'),
    question: z.string(),
    draft: z.string().optional(),
  }),
  z.object({
    kind: z.literal('waiting_for_approval'),
    action_ids: z.array(prefixedId(ID_PREFIXES.action)).min(1),
  }),
  z.object({ kind: z.literal('waiting_for_event_or_time'), wait: waitSpec }),
  z.object({ kind: z.literal('failed'), reason: z.string(), retryable: z.boolean() }),
  z.object({ kind: z.literal('budget_exhausted'), summary: z.string() }),
]);
export type AttemptOutcome = z.infer<typeof attemptOutcome>;

// --------------------------------------------------------------------------
// Runtime events
// --------------------------------------------------------------------------

/**
 * Persisted with `dedup_key = attempt_id:local_seq`, so replaying a stream after
 * a reconnect writes no duplicate rows. Text deltas are transient; every other
 * event is durable.
 */
export const RUNTIME_EVENT_TYPES = [
  'turn_started',
  'text_delta',
  'tool_call_proposed',
  'tool_result',
  'action_requested',
  'attempt_outcome',
] as const;
export const runtimeEventType = z.enum(RUNTIME_EVENT_TYPES);
export type RuntimeEventType = z.infer<typeof runtimeEventType>;

const runtimeEventBase = {
  attempt_id: prefixedId(ID_PREFIXES.attempt),
  local_seq: z.number().int().nonnegative(),
  dedup_key: z.string().min(1),
  at: timestamp,
};

export const runtimeEvent = z.discriminatedUnion('type', [
  z.object({
    ...runtimeEventBase,
    type: z.literal('turn_started'),
    turn: z.number().int().nonnegative(),
  }),
  z.object({ ...runtimeEventBase, type: z.literal('text_delta'), text: z.string() }),
  z.object({
    ...runtimeEventBase,
    type: z.literal('tool_call_proposed'),
    tool: z.string(),
    call_id: z.string(),
    arguments: jsonObject,
  }),
  z.object({
    ...runtimeEventBase,
    type: z.literal('tool_result'),
    call_id: z.string(),
    ok: z.boolean(),
    result: jsonObject,
  }),
  z.object({
    ...runtimeEventBase,
    type: z.literal('action_requested'),
    action_id: prefixedId(ID_PREFIXES.action),
    kind: z.string(),
  }),
  z.object({
    ...runtimeEventBase,
    type: z.literal('attempt_outcome'),
    outcome: attemptOutcome,
    usage: attemptUsage.optional(),
  }),
]);
export type RuntimeEvent = z.infer<typeof runtimeEvent>;

/** The one and only dedup key format. Both sides compute it the same way. */
export const dedupKey = (attemptId: string, localSeq: number): string => `${attemptId}:${localSeq}`;

/** Text deltas are best-effort; a gap in them is shown as an ellipsis, never as lost history. */
export const isDurableRuntimeEvent = (type: RuntimeEventType): boolean => type !== 'text_delta';

/**
 * What a runtime must implement. The service owns the loop around it: one
 * bundle in, one outcome out, events streamed to a sink that persists before
 * fanning out to clients.
 */
export interface EventSink {
  emit(event: RuntimeEvent): Promise<void>;
}

export interface RuntimeAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal): Promise<AttemptOutcome>;
}

/**
 * The context assembly budget, from the thin-harness rule. The service enforces
 * these; a runtime that receives a bundle may assume they already hold.
 */
export const CONTEXT_LIMITS = {
  identity_tokens: 250,
  max_skills: 3,
  skill_tokens: 400,
  knowledge_tokens: 2000,
  max_tools: 15,
} as const;
