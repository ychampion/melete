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
import { attemptUsage, type TriggerSpec, triggerKind, waitSpec } from './entities.ts';
import { executionMode } from './execution.ts';
import { hookCaptureErrorCode, hookObservation } from './hooks.ts';
import { claimHandle, memoryKey, originTrust } from './memory.ts';
import { repairBrief } from './provenance.ts';
import { replyVoice } from './reply-voice.ts';

export const runtimeCapabilities = z.object({
  streaming: z.boolean(),
  tools: z.boolean(),
  interrupt: z.boolean(),
  version: z.string(),
  /**
   * Where an attempt's files live. `job` is a workspace no other job reads or
   * writes, with an engine home that does not outlive the attempt. A runtime that
   * keeps files across jobs says `persistent`; one that says nothing is treated
   * the same way, since an earlier job may have written what this one reads.
   */
  workspace: z.enum(['job', 'persistent']).optional(),
});
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilities>;

/** The most the summary of a conversation's earlier messages may take, rendered. */
export const EARLIER_SUMMARY_CHARACTERS = 16_000;

/**
 * The standing instructions carried past a summary: rules the person set that
 * hold until they change them, each in their own words.
 */
export const STANDING_INSTRUCTIONS = { items: 40, characters: 500 } as const;

/** The most of one MCP server's notes on using its tools an attempt carries, in characters. */
export const SERVER_NOTES_MAX = 800;

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
  /**
   * How long the broker may take to carry out one call of this tool, when its
   * connector asks for longer than the broker's default. The runtime waits
   * this long for the answer, plus a little, so the broker's own recorded
   * outcome is what the agent is told.
   */
  deadline_ms: z.number().int().positive().optional(),
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

/**
 * One line of the skill index an attempt carries: a skill it may read but was
 * not given in full. The body is read on demand with `skills.read`.
 */
export const skillIndexEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
});
export type SkillIndexEntry = z.infer<typeof skillIndexEntry>;

/** The broker-owned tool an attempt reads a skill's body with, by the name its index gives. */
export const SKILL_READ_TOOL_NAME = 'skills.read';

/** The broker-owned tool an attempt searches everything memory keeps about the person with. */
export const MEMORY_SEARCH_TOOL_NAME = 'memory.search';
export const MEMORY_SEARCH_TOOL: ToolSpec = {
  name: MEMORY_SEARCH_TOOL_NAME,
  description:
    "Search all Melete remembers about the person and their people, not only what came with this message. Search before saying you don't know or never had something, or taking back an answer.",
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
    required: ['query'],
    additionalProperties: false,
  },
  effect_class: 'read',
  connection_id: null,
};

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
  kind: z.enum(['artifact', 'knowledge', 'action', 'source']),
  /** `artifact:art_...`, `knowledge:k_...`, `action:act_...`, `source:src_...@version`. */
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
  /** Set when the person said what happened to an effect nobody could confirm. */
  decided_by: z.enum(['owner']).optional(),
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
 * What an effect nobody could confirm is, once the person has said. A "did not"
 * is the person's answer, not an invitation to find out for them: the work
 * reports and asks, and does not redo it, hunt for it or make files of its own.
 */
const OWNER_DECIDED: Record<string, string> = {
  succeeded: 'happened: the person said so.',
  failed:
    'did not happen: the person said so. Tell them plainly what it was and ask what they want ' +
    'next. Do not try it again, work around it or search for traces of it, and do not save or ' +
    'move anything in their Files they did not ask for.',
  unresolved:
    'is still unconfirmed: the person cannot tell yet. Do not try it again; say what you would ' +
    'need to know.',
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
    if (item.decided_by === 'owner') {
      lines.push(
        `- action ${item.action_id} (${item.kind}) ${OWNER_DECIDED[item.status] ?? `is ${item.status}: the person said so.`}`,
      );
      continue;
    }
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

/** One trigger the attempt may wait on, as the model reads it. */
export const registeredTrigger = z.object({
  id: prefixedId(ID_PREFIXES.trigger),
  kind: triggerKind,
  event_name: z.string().min(1).nullable(),
  description: z.string().min(1).max(300),
});
export type RegisteredTrigger = z.infer<typeof registeredTrigger>;

/** A plain sentence for a trigger spec. No model reads the spec itself. */
export function describeTrigger(spec: TriggerSpec): string {
  switch (spec.kind) {
    case 'schedule':
      return spec.rrule !== undefined
        ? `fires on the rule "${spec.rrule}" from ${spec.starts} (${spec.timezone})`
        : `fires on the schedule "${spec.cron}" (${spec.timezone})`;
    case 'event':
      return `fires on each ${spec.event_name} event from ${spec.connection_id}`;
    case 'watch':
      return `fires when a ${spec.event_name} event from ${spec.connection_id} matches its watch condition`;
  }
}

/**
 * The note on an approval Melete withdrew because what it was asked on changed
 * before anyone answered it: a fact it rested on, or the job's revision.
 * Nobody refused it: nothing was carried out, and the work asks again with the
 * current details if it still needs to.
 */
export const APPROVAL_OUTDATED_NOTE = 'outdated';

/**
 * Everything one attempt is given, and nothing more. The order matters for
 * prompt caching: stable prefix first, volatile inputs last.
 */
export const attemptBundle = z.object({
  principal_id: prefixedId(ID_PREFIXES.owner).optional(),
  membership_generation: z.number().int().nonnegative().optional(),
  /**
   * The persona a conversation's agent speaks as: its name, tone and standing
   * instruction. It is layered on top of Melete's own identity, which every
   * attempt carries whole, and never replaces it.
   */
  identity: z.string().max(1000).optional(),
  /** The person's IANA time zone, so dates the model reads and writes are theirs. */
  time_zone: z.string().min(1).max(64).optional(),
  /**
   * When and where this attempt starts, for the model's volatile input: the
   * moment the attempt was claimed, the zone it is read in, the city that zone
   * is named for, and a difference between the profile's zone and the person's
   * device, reported once.
   */
  local_now: z
    .object({
      at: z.string().datetime({ offset: true }),
      time_zone: z.string().min(1).max(64),
      city: z.string().min(1).max(80).nullable(),
      zone_mismatch: z
        .object({
          profile: z.string().min(1).max(64),
          device: z.string().min(1).max(64),
          /** Which of the two this attempt reads time in. */
          used: z.enum(['profile', 'device']),
        })
        .nullable(),
    })
    .optional(),
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
    /**
     * The job's enabled triggers, so a wait can name one. `event_name` is null
     * for a schedule. Optional, so an older producer still parses.
     */
    triggers: z.array(registeredTrigger).max(50).optional(),
  }),
  /** What changed since the last attempt: the reason this wake exists. */
  inputs: z.object({
    /**
     * Deprecated. The delta is the top-level `since_last`, built once from
     * durable rows; no producer fills this field. It stays optional so a bundle
     * written before the two shapes were unified still parses.
     */
    since_last: sinceLastBrief.optional(),
    new_user_messages: z.array(canonicalMessage),
    approval_results: z.array(
      z.object({
        action_id: prefixedId(ID_PREFIXES.action),
        decision: z.enum(['approved', 'denied']),
        note: z.string().nullable(),
        /**
         * What was decided on, read from the action row when the bundle is
         * built: the tool, the canonical payload the owner read, and where the
         * action stands now. Optional, so an older producer still parses.
         */
        kind: z.string().min(1).optional(),
        status: z.string().min(1).optional(),
        payload: jsonObject.optional(),
      }),
    ),
    trigger_events: z.array(jsonObject),
    /**
     * An event or timer wait that was in force when something requeued the job
     * before it fired, such as a correction to a claim the job relied on. The
     * attempt is told no wait is in force; if it completes without choosing
     * another, the service restores this one while it can still fire.
     */
    cancelled_wait: waitSpec.optional(),
    /**
     * True when `cancelled_wait` is a conversation's reminder the person
     * cancelled from another conversation: it comes back still cancelled and
     * does not fire unless run.resume turns it back on.
     */
    cancelled_wait_held: z.boolean().optional(),
    /**
     * What a correction broke and where. Each brief names the handle that moved,
     * the value before and after, and the outputs that cited the old revision.
     */
    repair_briefs: z.array(repairBrief).default([]),
    /**
     * What earlier attempts of this same conversation turn already said to the
     * person, which reached them however those attempts ended. An attempt that
     * runs the turn again carries on from it instead of answering a second
     * time. Optional, so an older producer still parses.
     */
    said_this_turn: z.string().max(8000).optional(),
    /**
     * Set when this turn's message answers a question an earlier turn ended
     * on: that question, and what the earlier turn already said to the
     * person, which they still have. The attempt replies to the answer
     * instead of sending those words again. Optional, so an older producer
     * still parses.
     */
    answered_question: z
      .object({ question: z.string().max(2000), said: z.string().max(8000) })
      .optional(),
  }),
  /**
   * What has happened since the last attempt, from durable rows. Additive: a
   * producer that omits it hands the next attempt an empty brief rather than
   * failing to build a bundle at all.
   */
  since_last: sinceLast.default(EMPTY_SINCE_LAST),
  transcript: z.array(canonicalMessage),
  /**
   * The earlier part of the conversation, which `transcript` no longer
   * carries: Melete's summary of the messages up to `through`, and how many
   * later ones did not fit and are not in that summary either. Optional, so
   * an older producer still parses; absent, nothing was left out.
   */
  earlier: z
    .object({
      summary: z.string().max(EARLIER_SUMMARY_CHARACTERS).nullable(),
      through: timestamp.nullable(),
      left_out: z.number().int().nonnegative(),
      /**
       * Rules the person set in the summarised messages that still hold (a
       * currency, a format, something to leave out), each in their own words,
       * newest last. They are kept apart from the summary so the engine can
       * hold them where its own compaction never reaches. Optional: absent,
       * there are none.
       */
      standing_instructions: z
        .array(z.string().min(1).max(STANDING_INSTRUCTIONS.characters))
        .max(STANDING_INSTRUCTIONS.items)
        .optional(),
    })
    .optional(),
  tools: z.array(toolSpec),
  skills: z.array(skillPayload),
  /**
   * Every other skill this attempt may read, by name and one line, within its
   * own token allowance. Additive: a producer that omits it offers none.
   */
  skill_index: z.array(skillIndexEntry).optional(),
  /**
   * The accounts the person connected that this attempt may use, one short
   * line each saying how (an account reached through the computer's command
   * line has no tool of its own). Additive: a producer that omits it names none.
   */
  connected_accounts: z.array(z.string().min(1).max(300)).max(20).optional(),
  /**
   * What each connected MCP server says about using its own tools (its
   * `instructions`), by connection. They are the server's words, not the
   * person's or Melete's, and are shown only while one of that connection's
   * tools is in `tools`. Additive: a producer that omits it gives none.
   */
  server_notes: z
    .array(
      z.object({
        connection_id: prefixedId(ID_PREFIXES.connection),
        server: z.string().min(1).max(120),
        notes: z.string().min(1).max(SERVER_NOTES_MAX),
      }),
    )
    .max(20)
    .optional(),
  /**
   * The voice the person picked for replies and drafts. Additive: a producer
   * that omits it gets the default voice.
   */
  voice: replyVoice.optional(),
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
    /**
     * Whether the model is shown the agent's screenshots as pictures. Absent,
     * the model catalog decides (`modelSupportsVision`).
     */
    vision: z.boolean().optional(),
  }),
});
export type AttemptBundle = z.infer<typeof attemptBundle>;

export const evidenceRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), artifact_id: prefixedId(ID_PREFIXES.artifact) }),
  z.object({ kind: z.literal('action'), action_id: prefixedId(ID_PREFIXES.action) }),
  z.object({ kind: z.literal('knowledge'), record_id: prefixedId(ID_PREFIXES.knowledge) }),
]);
export type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Why the model provider refused a call, in classes safe to show and act on.
 * The provider's own words never travel with it.
 */
export const PROVIDER_FAILURES = [
  'key_refused',
  'quota',
  'rate_limited',
  'model_not_found',
  'context_too_long',
  'provider_down',
] as const;
export const providerFailure = z.enum(PROVIDER_FAILURES);
export type ProviderFailure = z.infer<typeof providerFailure>;

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
  z.object({
    kind: z.literal('failed'),
    reason: z.string(),
    retryable: z.boolean(),
    /** Set when the model provider refused the call, and why. */
    failure: providerFailure.optional(),
  }),
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
  /** The model's reasoning as it is written, when its provider returns it. */
  'reasoning_delta',
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
  /**
   * The engine went quiet for longer than the step it was on may take. The
   * runtime has asked it, without the person seeing, to report what it has.
   */
  'stalled',
  /**
   * Words the person sent while the turn was running reached the model: at a
   * step's end, or as the input of the next run in the same attempt.
   */
  'steer_delivered',
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
  z.object({ ...runtimeEventBase, type: z.literal('reasoning_delta'), text: z.string() }),
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
    type: z.literal('stalled'),
    /** How long nothing came from the engine. */
    silent_ms: z.number().int().nonnegative(),
    /** The step it was on, when it was on one. */
    tool: z.string().max(200).optional(),
  }),
  z.object({
    ...runtimeEventBase,
    type: z.literal('steer_delivered'),
    /** The id the service gave the message when it recorded it. */
    steer_id: z.string().min(1).max(80),
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

/** Text and reasoning deltas are best-effort; a gap in them is shown as an ellipsis, never as lost history. */
export const isDurableRuntimeEvent = (type: RuntimeEventType): boolean =>
  type !== 'text_delta' && type !== 'reasoning_delta';

/**
 * What a runtime must implement. The service owns the loop around it: one
 * bundle in, one outcome out, events streamed to a sink that persists before
 * fanning out to clients.
 */
export interface EventSink {
  emit(event: RuntimeEvent): Promise<void>;
}

/** A message the person sent while a turn was running, already recorded by the service. */
export type SteerMessage = { id: string; text: string };

export interface RuntimeAdapter {
  capabilities(): Promise<RuntimeCapabilities>;
  start(bundle: AttemptBundle, sink: EventSink, signal: AbortSignal): Promise<AttemptOutcome>;
  /**
   * Hand a running attempt words the person sent after it started. False when
   * this attempt can no longer take them here (it has ended, or is not this
   * process's); the service then carries them to the next turn. A true answer
   * is a promise to deliver: `steer_delivered` follows on the attempt's
   * stream before its outcome, or the words are carried the same way.
   */
  steer?(attemptId: string, message: SteerMessage): Promise<boolean>;
}

/**
 * The context assembly budget, from the thin-harness rule, at the baseline
 * 128,000-token window. A model with a larger window gets proportionally more
 * (`contextBudget` in context-budget.ts); these numbers are the floor every
 * model gets. The service enforces them; a runtime that receives a bundle may
 * assume they already hold.
 */
export const CONTEXT_LIMITS = {
  identity_tokens: 250,
  max_skills: 3,
  skill_tokens: 400,
  knowledge_tokens: 2000,
  max_tools: 15,
  /** Serialized schemas in the first catalog, the two discovery tools included. */
  core_catalog_tokens: 750,
  /** The names-only listing of tools left outside that catalog. */
  catalog_index_tokens: 250,
  /** The skill index: names and one-line descriptions of the skills not given in full. */
  skill_index_tokens: 500,
} as const;
