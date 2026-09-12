/**
 * The persisted entities. These schemas are the shape of the Postgres rows and
 * of the API's read models; the Drizzle table definitions in the service are
 * generated against them by hand and checked by the same tests.
 */
import { z } from 'zod';
import { actionStatus, effectClass, payloadHash } from './broker.ts';
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';
import { originWarnings, sha256Hex } from './effects.ts';
import { jobState } from './job-state.ts';
import { knowledgeRecordStatus } from './knowledge.ts';
import { repairCounters, repairDisposition, repairTrace } from './repair.ts';
import { watchPredicate } from './watch.ts';

// --------------------------------------------------------------------------
// owner, space
// --------------------------------------------------------------------------

/** The installation keeps one owner row as its setup guard. */
export const owner = z.object({
  id: prefixedId(ID_PREFIXES.owner),
  email: z.email(),
  password_hash: z.string().nullable(),
  passkey: jsonObject.nullable(),
  created_at: timestamp,
});
export type Owner = z.infer<typeof owner>;

export const SPACE_KINDS = ['personal', 'shared'] as const;
export const spaceKind = z.enum(SPACE_KINDS);
export type SpaceKind = z.infer<typeof spaceKind>;

/**
 * Personal spaces are owner-only; shared spaces are visible to active members.
 */
export const SPACE_AUDIENCES = ['owner', 'space'] as const;
export const spaceAudience = z.enum(SPACE_AUDIENCES);
export type SpaceAudience = z.infer<typeof spaceAudience>;

export const space = z
  .object({
    id: prefixedId(ID_PREFIXES.space),
    name: z.string().min(1).max(120),
    kind: spaceKind,
    audience: spaceAudience,
    owner_principal_id: prefixedId(ID_PREFIXES.owner).nullable().optional(),
    /** Path of this space's git repository on the `spaces` volume. */
    git_path: z.string().min(1),
    created_at: timestamp,
  })
  .meta({ id: 'Space' });
export type Space = z.infer<typeof space>;

// --------------------------------------------------------------------------
// connection
// --------------------------------------------------------------------------

export const CONNECTION_PROVIDERS = [
  'imap',
  'smtp',
  'caldav',
  'web',
  'files',
  'test',
  // Runs inside the cell and records what it ran; see execution.ts.
  'exec',
  // Publishes a finished artifact to a destination outside the workspace.
  'artifacts',
  /** Generative capabilities: they make a file rather than reaching one. */
  'generation',
  /** Operator-installed MCP servers, exposed through the broker like any other connector. */
  'mcp',
] as const;
export const connectionProvider = z.enum(CONNECTION_PROVIDERS);
export type ConnectionProvider = z.infer<typeof connectionProvider>;

export const CONNECTION_STATUSES = ['active', 'disabled', 'error'] as const;
export const connectionStatus = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof connectionStatus>;

export const CONNECTION_HEALTH = ['unknown', 'ok', 'degraded', 'failing'] as const;
export const connectionHealth = z.enum(CONNECTION_HEALTH);
export type ConnectionHealth = z.infer<typeof connectionHealth>;

export const connection = z.object({
  id: prefixedId(ID_PREFIXES.connection),
  space_id: prefixedId(ID_PREFIXES.space),
  provider: connectionProvider,
  label: z.string().min(1).max(120),
  /**
   * Points at a row in `secret`, sealed with the operator's master key. The
   * runtime never sees this field, and no API response carries it.
   */
  secret_ref: prefixedId(ID_PREFIXES.secret).nullable(),
  scopes: z.array(z.string()),
  status: connectionStatus,
  health: connectionHealth,
  setup_state: z.enum(['available', 'connecting', 'connected', 'error']).optional(),
  last_checked_at: timestamp.nullable(),
  created_at: timestamp,
});
export type Connection = z.infer<typeof connection>;

/** What the API is allowed to return: the same row minus the secret pointer. */
export const connectionView = connection.omit({ secret_ref: true }).meta({ id: 'Connection' });
export type ConnectionView = z.infer<typeof connectionView>;

// --------------------------------------------------------------------------
// job
// --------------------------------------------------------------------------

/** What has to exist before a job may call itself completed. */
export const deliverable = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('artifact'), path_glob: z.string().min(1) }),
  z.object({ kind: z.literal('message_sent'), connection_id: prefixedId(ID_PREFIXES.connection) }),
  z.object({ kind: z.literal('answer') }),
]);
export type Deliverable = z.infer<typeof deliverable>;

export const jobConstraints = z.object({
  deliverable: deliverable.default({ kind: 'none' }),
  /** Domains `web.fetch` may touch when the job carries private context. */
  allowed_domains: z.array(z.string()).default([]),
  /** Public-research mode: no private knowledge is loaded into context. */
  public_compartment: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
});
export type JobConstraints = z.infer<typeof jobConstraints>;

export const jobBudget = z.object({
  max_turns: z.number().int().positive(),
  max_input_tokens: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().positive(),
  max_wall_ms: z.number().int().positive(),
  max_actions: z.number().int().nonnegative(),
  max_attempts: z.number().int().positive(),
  max_usd_est: z.number().nonnegative(),
});
export type JobBudget = z.infer<typeof jobBudget>;

export const waitSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('user_input'), question: z.string() }),
  z.object({ kind: z.literal('approval'), action_ids: z.array(prefixedId(ID_PREFIXES.action)) }),
  z.object({ kind: z.literal('timer'), wake_at: timestamp }),
  z.object({
    kind: z.literal('event'),
    trigger_id: prefixedId(ID_PREFIXES.trigger),
    deadline_at: timestamp.nullable(),
  }),
]);
export type WaitSpec = z.infer<typeof waitSpec>;

export const job = z
  .object({
    id: prefixedId(ID_PREFIXES.job),
    space_id: prefixedId(ID_PREFIXES.space),
    principal_id: prefixedId(ID_PREFIXES.owner).nullable().optional(),
    title: z.string().min(1).max(200),
    objective: z.string().min(1),
    constraints: jobConstraints,
    state: jobState,
    /** Bumped whenever the objective or constraints change; approvals bind to it. */
    revision: z.number().int().nonnegative(),
    /** Bumped when an attempt starts. The broker fences on this. */
    lease_epoch: z.number().int().nonnegative(),
    next_wake_at: timestamp.nullable(),
    wait: waitSpec,
    budget: jobBudget,
    created_by: z.enum(['owner', 'trigger', 'system']),
    created_at: timestamp,
    updated_at: timestamp,
    /** Optimistic-concurrency counter for the single transaction that commits a move. */
    state_version: z.number().int().nonnegative(),
  })
  .meta({ id: 'Job' });
export type Job = z.infer<typeof job>;

// --------------------------------------------------------------------------
// attempt
// --------------------------------------------------------------------------

export const ATTEMPT_OUTCOMES = [
  'completed',
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_event_or_time',
  'failed',
  'budget_exhausted',
  'fenced',
  'unknown_check',
] as const;
export const attemptOutcomeKind = z.enum(ATTEMPT_OUTCOMES);
export type AttemptOutcomeKind = z.infer<typeof attemptOutcomeKind>;

export const attemptUsage = z.object({
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cached_input_tokens: z.number().int().nonnegative().default(0),
  requests: z.number().int().nonnegative().default(0),
  usd_est: z.number().nonnegative().default(0),
});
export type AttemptUsage = z.infer<typeof attemptUsage>;

export const attempt = z
  .object({
    id: prefixedId(ID_PREFIXES.attempt),
    job_id: prefixedId(ID_PREFIXES.job),
    epoch: z.number().int().nonnegative(),
    runtime_version: z.string(),
    provider: z.string(),
    model: z.string(),
    /** What the provider actually served, read from the response, not the request. */
    model_actual: z.string().nullable(),
    usage: attemptUsage,
    started_at: timestamp,
    ended_at: timestamp.nullable(),
    outcome: attemptOutcomeKind.nullable(),
    outcome_detail: jsonObject.nullable(),
    context_snapshot_ref: z.string().nullable(),
  })
  .meta({ id: 'Attempt' });
export type Attempt = z.infer<typeof attempt>;

// --------------------------------------------------------------------------
// action, approval
// --------------------------------------------------------------------------

export const action = z
  .object({
    id: prefixedId(ID_PREFIXES.action),
    job_id: prefixedId(ID_PREFIXES.job),
    attempt_id: prefixedId(ID_PREFIXES.attempt),
    connection_id: prefixedId(ID_PREFIXES.connection),
    kind: z.string().min(1),
    effect_class: effectClass,
    canonical_payload: jsonObject,
    payload_hash: payloadHash,
    /**
     * The identity of the effect across attempts: one action per job, revision,
     * connection, tool and payload hash. Null only on rows written before the
     * column existed; every action created since carries one. A record that omits
     * it reads as null rather than failing, so an older producer still parses.
     */
    intent_key: sha256Hex.nullable().default(null),
    status: actionStatus,
    /** The approval this admission relied on, if any. */
    authorization_ref: prefixedId(ID_PREFIXES.approval).nullable(),
    budget_reservation: prefixedId(ID_PREFIXES.ledger).nullable(),
    /** Always the action id, so a retry is the same request to the connector. */
    idempotency_key: z.string().min(1),
    dispatched_at: timestamp.nullable(),
    receipt: jsonObject.nullable(),
    resolved_at: timestamp.nullable(),
    reconciliation: jsonObject.nullable(),
    /**
     * What the repair policy did about this action's faults, in order. Rows
     * written before the column existed read as an empty trace rather than
     * failing, so an older producer still parses.
     */
    repair_trace: repairTrace.default([]),
    /** One counter per fault class met. Absent keys are zero. */
    repair_counters: repairCounters.default({}),
    /**
     * Where the last dispatch came to rest. `completed` is the only value that
     * means the effect happened; every other one is a safe stop and a client
     * shows it as its own state rather than as a failure.
     */
    repair_disposition: repairDisposition.nullable().default(null),
    /** When a rate-limited destination may be approached again. */
    retry_after_at: timestamp.nullable().default(null),
    created_at: timestamp,
  })
  .meta({ id: 'Action' });
export type Action = z.infer<typeof action>;

export const approval = z.object({
  id: prefixedId(ID_PREFIXES.approval),
  action_id: prefixedId(ID_PREFIXES.action),
  /** Both of these must still match at admission or the approval is refused. */
  job_revision: z.number().int().nonnegative(),
  payload_hash: payloadHash,
  requested_at: timestamp,
  decided_at: timestamp.nullable(),
  decision: z.enum(['approved', 'denied']).nullable(),
  decided_by: z.string().nullable(),
  expires_at: timestamp.nullable(),
  /**
   * Why this was worth asking about: every recipient, destination, amount or
   * resource field whose origin Melete cannot vouch for. A decision taken
   * against one set of doubts cannot be spent against another.
   */
  origin_warnings: originWarnings.default([]),
});
export type Approval = z.infer<typeof approval>;

// --------------------------------------------------------------------------
// event
// --------------------------------------------------------------------------

export const EVENT_TYPES = [
  'job_created',
  'job_state_changed',
  'attempt_started',
  'attempt_ended',
  'turn_started',
  'text_delta',
  'tool_call_proposed',
  'tool_result',
  'action_requested',
  'action_status_changed',
  'approval_requested',
  'approval_decided',
  'knowledge_changed',
  'notice',
  /** A glyph on a message, from either side. Persisted and streamed like the rest. */
  'reaction',
  /**
   * Part of an attempt's history was never received. It is recorded where the
   * hole is rather than at the end, so a reader can see which stretch is
   * unknown instead of inferring it from a failure message.
   */
  'gap',
  'hook_event',
  'hook_error',
] as const;
export const eventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventType>;

export const event = z
  .object({
    seq: z.number().int().positive(),
    job_id: prefixedId(ID_PREFIXES.job).nullable(),
    attempt_id: prefixedId(ID_PREFIXES.attempt).nullable(),
    type: eventType,
    payload: jsonObject,
    /** Unique. Duplicate delivery of the same runtime event writes one row. */
    dedup_key: z.string().min(1),
    created_at: timestamp,
  })
  .meta({ id: 'Event' });
export type Event = z.infer<typeof event>;

// --------------------------------------------------------------------------
// artifact
// --------------------------------------------------------------------------

export const artifact = z.object({
  id: prefixedId(ID_PREFIXES.artifact),
  space_id: prefixedId(ID_PREFIXES.space),
  job_id: prefixedId(ID_PREFIXES.job).nullable(),
  path: z.string().min(1),
  content_hash: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  audience: spaceAudience,
  /**
   * The job whose work this is. `job_id` is detached when a job row goes away;
   * this one is the durable answer to "update this with the latest data", which
   * is the same job waking again rather than a new job writing a similar file.
   */
  source_job_id: prefixedId(ID_PREFIXES.job).nullable().optional(),
  created_at: timestamp,
});
export type Artifact = z.infer<typeof artifact>;

// --------------------------------------------------------------------------
// knowledge_record (catalog row; the file is the source of truth)
// --------------------------------------------------------------------------

export const knowledgeRecordRow = z.object({
  id: prefixedId(ID_PREFIXES.knowledge),
  space_id: prefixedId(ID_PREFIXES.space),
  /** Relative to the space root, for example `knowledge/prefers-bun.md`. */
  path: z.string().min(1),
  frontmatter: jsonObject,
  content_hash: z.string().min(1),
  status: knowledgeRecordStatus,
  updated_at: timestamp,
});
export type KnowledgeRecordRow = z.infer<typeof knowledgeRecordRow>;

// --------------------------------------------------------------------------
// trigger
// --------------------------------------------------------------------------

export const TRIGGER_KINDS = ['schedule', 'event', 'watch'] as const;
export const triggerKind = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof triggerKind>;

export const triggerSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), cron: z.string().min(1), timezone: z.string().min(1) }),
  z.object({
    kind: z.literal('event'),
    connection_id: prefixedId(ID_PREFIXES.connection),
    /** For example `mail.new`, polled with a cursor in v0.1. */
    event_name: z.string().min(1),
    poll_seconds: z.number().int().positive().default(300),
  }),
  /**
   * Like an event trigger, but the service tests the observation before waking
   * anything. A monitor that wakes a model to look at an unchanged feed is not
   * watching, it is spending; a watch that does not match writes no attempt.
   */
  z.object({
    kind: z.literal('watch'),
    connection_id: prefixedId(ID_PREFIXES.connection),
    event_name: z.string().min(1),
    predicate: watchPredicate,
    poll_seconds: z.number().int().positive().default(300),
  }),
]);
export type TriggerSpec = z.infer<typeof triggerSpec>;

export const trigger = z.object({
  id: prefixedId(ID_PREFIXES.trigger),
  job_id: prefixedId(ID_PREFIXES.job),
  kind: triggerKind,
  spec: triggerSpec,
  cursor: z.string().nullable(),
  enabled: z.boolean(),
  created_at: timestamp,
});
export type Trigger = z.infer<typeof trigger>;

// --------------------------------------------------------------------------
// budget_ledger
// --------------------------------------------------------------------------

export const BUDGET_KINDS = ['tokens', 'usd_est', 'calls'] as const;
export const budgetKind = z.enum(BUDGET_KINDS);
export type BudgetKind = z.infer<typeof budgetKind>;

/** Reserve before the call, settle after it. Two attempts cannot double-spend. */
export const budgetLedger = z.object({
  id: prefixedId(ID_PREFIXES.ledger),
  job_id: prefixedId(ID_PREFIXES.job),
  attempt_id: prefixedId(ID_PREFIXES.attempt).nullable(),
  action_id: prefixedId(ID_PREFIXES.action).nullable(),
  kind: budgetKind,
  reserved: z.number().nonnegative(),
  settled: z.number().nonnegative().nullable(),
  at: timestamp,
});
export type BudgetLedger = z.infer<typeof budgetLedger>;

// --------------------------------------------------------------------------
// skill
// --------------------------------------------------------------------------

export const skillRow = z.object({
  id: prefixedId(ID_PREFIXES.skill),
  /** Null for the built-in skills that ship with the release. */
  space_id: prefixedId(ID_PREFIXES.space).nullable(),
  name: z.string().min(1),
  path: z.string().min(1),
  frontmatter: jsonObject,
  enabled: z.boolean(),
});
export type SkillRow = z.infer<typeof skillRow>;

// --------------------------------------------------------------------------
// secret (referenced by connection.secret_ref; never leaves the service)
// --------------------------------------------------------------------------

export const secret = z.object({
  id: prefixedId(ID_PREFIXES.secret),
  space_id: prefixedId(ID_PREFIXES.space),
  /** Sealed with MELETE_MASTER_KEY. Stored as base64; never returned by the API. */
  ciphertext: z.string().min(1),
  created_at: timestamp,
  rotated_at: timestamp.nullable(),
});
export type Secret = z.infer<typeof secret>;

/** Every table in v0.1, in dependency order. Used by the migration test. */
export const TABLES = [
  'owner',
  'principal',
  'space',
  'space_membership',
  'secret',
  'connection',
  'job',
  'attempt',
  'action',
  'approval',
  'event',
  'artifact',
  'knowledge_record',
  'trigger',
  'budget_ledger',
  'skill',
] as const;
export type TableName = (typeof TABLES)[number];
