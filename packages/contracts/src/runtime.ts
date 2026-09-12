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
import { executionMode } from './execution.ts';
import { hookCaptureErrorCode, hookObservation } from './hooks.ts';
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
  /** `in_cell` tells the runtime to do the work itself and propose the record. */
  execution: executionMode.optional(),
  /** The shape of that record, for an `in_cell` tool. Null otherwise. */
  record_schema: jsonSchema.nullable().optional(),
});
export type ToolSpec = z.infer<typeof toolSpec>;

export const skillPayload = z.object({
  space_id: prefixedId(ID_PREFIXES.space).optional(),
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

// --------------------------------------------------------------------------
// The delta brief: what has happened since the last attempt
// --------------------------------------------------------------------------

/**
 * One thing produced since the last attempt that a later claim can rest on: a
 * file written, a knowledge record committed, an action with a receipt. The
 * handle is what the attempt cites; the label is what it can say out loud.
 */
export const evidenceHandleRef = z.object({
  kind: z.enum(['artifact', 'knowledge', 'action']),
  /** `artifact:art_...`, `knowledge:k_...`, `action:act_...`. */
  handle: z.string().min(1).max(240),
  label: z.string().max(240),
  at: timestamp,
});
export type EvidenceHandleRef = z.infer<typeof evidenceHandleRef>;

/**
 * What one of this job's actions did since the last attempt. The receipt
 * reference is the connector's own handle, a Message-ID or a CalDAV UID, which
 * is the only thing that makes "it was sent" a fact rather than a hope.
 */
export const actionSinceLast = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  kind: z.string().min(1),
  status: z.string().min(1),
  receipt_ref: z.string().max(500).nullable().default(null),
  at: timestamp,
});
export type ActionSinceLast = z.infer<typeof actionSinceLast>;

/** A question already put to the person, or still held for a later wake. */
export const openQuestionRef = z.object({
  id: z.string().max(240),
  text: z.string().max(4000),
  state: z.enum(['asked', 'held']),
});

/** A decision the person has not made yet. Nothing moves until they do. */
export const pendingApprovalRef = z.object({
  approval_id: prefixedId(ID_PREFIXES.approval),
  action_id: prefixedId(ID_PREFIXES.action),
  kind: z.string().min(1),
  requested_at: timestamp,
});

/**
 * The delta brief. An attempt is disposable and a responsibility is not, so a
 * wake that starts from zero rereads its whole history to learn one thing. This
 * is that one thing, built from durable rows only: what was produced, what the
 * job did and how it ended, what is still waiting on a person, and what a
 * correction broke.
 *
 * The identity file tells the model to name prior work in one clause. This is
 * what it names it from.
 */
export const sinceLast = z.object({
  /** The attempt this is measured from. Null on the first wake: nothing is prior. */
  attempt_id: prefixedId(ID_PREFIXES.attempt).nullable().default(null),
  ended_at: timestamp.nullable().default(null),
  evidence: z.array(evidenceHandleRef).max(50).default([]),
  actions: z.array(actionSinceLast).max(50).default([]),
  pending_questions: z.array(openQuestionRef).max(50).default([]),
  pending_approvals: z.array(pendingApprovalRef).max(50).default([]),
  /** What a correction broke and where. The same briefs as `inputs.repair_briefs`. */
  repair_briefs: z.array(repairBrief).max(50).default([]),
});
export type SinceLast = z.infer<typeof sinceLast>;

export const EMPTY_SINCE_LAST: SinceLast = {
  attempt_id: null,
  ended_at: null,
  evidence: [],
  actions: [],
  pending_questions: [],
  pending_approvals: [],
  repair_briefs: [],
};

/**
 * The delta brief as the model reads it. Plain lines, no ceremony, and nothing
 * that is not on a durable row. An empty brief renders as one sentence saying
 * so, because "this is the first wake" is itself worth knowing.
 */
export function renderSinceLast(delta: SinceLast): string {
  const lines: string[] = [
    delta.attempt_id ? `Since the last attempt (${delta.attempt_id}):` : 'Since the last attempt:',
  ];
  for (const item of delta.actions) {
    const receipt = item.receipt_ref ? `, receipt ${item.receipt_ref}` : '';
    const status = item.status === 'succeeded' && !item.receipt_ref ? 'not confirmed' : item.status;
    lines.push(`- action ${item.action_id} (${item.kind}) is ${status}${receipt}`);
  }
  for (const item of delta.evidence) lines.push(`- new ${item.kind} ${item.handle}: ${item.label}`);
  for (const item of delta.pending_questions) lines.push(`- question ${item.state}: ${item.text}`);
  for (const item of delta.pending_approvals)
    lines.push(`- approval ${item.approval_id} is waiting on action ${item.action_id}`);
  for (const brief of delta.repair_briefs)
    lines.push(
      `- correction: ${brief.key ?? brief.changed_handle} changed from "${brief.old_value}" to "${brief.new_value}"; ${brief.affected.length} output(s) cited the old value`,
    );
  if (lines.length === 1) {
    return delta.attempt_id
      ? `${lines[0]}\n- nothing was produced and nothing is waiting.`
      : 'This is the first attempt on this job.';
  }
  return lines.join('\n');
}

/**
 * Everything one attempt is given, and nothing more. The order matters for
 * prompt caching: stable prefix first, volatile inputs last.
 */
export const attemptBundle = z.object({
  principal_id: prefixedId(ID_PREFIXES.owner).optional(),
  membership_generation: z.number().int().nonnegative().optional(),
  /** Optional personalized identity, still bounded separately from working context. */
  identity: z.string().max(1000).optional(),
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
  /**
   * What has happened since the last attempt, from durable rows. Additive: a
   * producer that omits it hands the next attempt an empty brief rather than
   * failing to build a bundle at all.
   */
  since_last: sinceLast.default(EMPTY_SINCE_LAST),
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
  z.object({
    kind: z.literal('unknown_check'),
    check: z.literal('parked_actions'),
    reason: z.enum(['timed_out', 'unavailable']),
    message: z.string(),
  }),
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
  /**
   * History is missing. A dropped stream or an interrupted run leaves a hole,
   * and a transcript with a silent hole reads as a complete one. This says
   * where the hole is, which is a different fact from "the attempt failed".
   */
  'gap',
  'hook_event',
  'hook_error',
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
    ...hookObservation.shape,
    type: z.literal('hook_event'),
  }),
  z.object({
    ...runtimeEventBase,
    ...hookObservation.shape,
    type: z.literal('hook_error'),
    error_code: hookCaptureErrorCode,
  }),
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
  z.object({
    ...runtimeEventBase,
    type: z.literal('gap'),
    reason: z.string().min(1).max(2000),
    /** Events after this durable sequence number and before this one may be missing. */
    after_seq: z.number().int().nonnegative(),
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
