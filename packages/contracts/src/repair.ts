/**
 * Typed faults and the repair policy's vocabulary.
 *
 * A connector that fails tells the broker *what kind* of failure it was. The
 * difference between "the socket closed before the request left" and "the
 * destination accepted it and the acknowledgement was lost" is the difference
 * between a free retry and a duplicate send, and no string match on an error
 * message can be trusted to tell them apart. So the connector says so, in a
 * closed set, and the broker's policy reads the class rather than guessing.
 *
 * Two things a repair may never do. It may not change what the person asked
 * for: the recipient, the amount, the resource, the business intent. And it may
 * not retry an effect that may already have happened. Everything else a repair
 * is allowed to touch is a selector, a wrapper, a route or a candidate mapping,
 * and every one of those is written down on the action so the change is
 * readable afterwards rather than inferred from a log line.
 */
import { z } from 'zod';
import { actionStatus, effectClass, payloadHash } from './broker.ts';
import { ID_PREFIXES, jsonObject, prefixedId, timestamp } from './common.ts';
import { sha256Hex } from './effects.ts';

// --------------------------------------------------------------------------
// The fault taxonomy
// --------------------------------------------------------------------------

/**
 * Every way a connector is allowed to fail on purpose.
 *
 * - `transient_before_dispatch` the request did not leave. Retrying is free.
 * - `rate_limited` the destination asked to be left alone for a while.
 * - `expired_credential` the grant is still good; the token is stale.
 * - `revoked_credential` the grant is gone. Nobody may substitute another.
 * - `schema_drift` the destination's shape moved under a working call.
 * - `unsupported_route` this route cannot do it, and definitively did not.
 * - `uncertain_outcome` the answer was lost. It may or may not have happened.
 * - `bad_output` it ran and what came back does not pass its own validation.
 * - `unclassified` the connector does not know. Treated as unrepairable.
 */
export const CONNECTOR_FAULT_KINDS = [
  'transient_before_dispatch',
  'rate_limited',
  'expired_credential',
  'revoked_credential',
  'schema_drift',
  'unsupported_route',
  'uncertain_outcome',
  'bad_output',
  'unclassified',
] as const;
export const connectorFaultKind = z.enum(CONNECTOR_FAULT_KINDS);
export type ConnectorFaultKind = z.infer<typeof connectorFaultKind>;

/**
 * What a connector raises instead of a bare `Error`.
 *
 * `may_have_committed` is the only field with teeth: true means no retry of any
 * shape is allowed until `verify` has spoken, whatever the kind says. A
 * connector that is unsure must say true.
 */
export const connectorFault = z.object({
  kind: connectorFaultKind,
  /** True when the effect may already have landed. A repair may never re-send it. */
  may_have_committed: z.boolean().default(false),
  /** Seconds the destination asked to be left alone. Only meaningful when it said so. */
  retry_after: z.number().int().nonnegative().nullable().default(null),
  /** Plain words from the connector, for the trace and the owner's question. */
  detail: z.string().min(1),
});
export type ConnectorFault = z.infer<typeof connectorFault>;

// --------------------------------------------------------------------------
// What the policy decided, and where the action came to rest
// --------------------------------------------------------------------------

/**
 * Where one dispatch ended. `completed` is the only one that means the effect
 * happened. Every other value is a safe stop: nothing was duplicated, nothing
 * was invented, and the record says what is needed next.
 */
export const REPAIR_DISPOSITIONS = [
  'completed',
  'parked_until_retry',
  'needs_reconciliation',
  'needs_reconnect',
  'needs_input',
  'repair_exhausted',
] as const;
export const repairDisposition = z.enum(REPAIR_DISPOSITIONS);
export type RepairDisposition = z.infer<typeof repairDisposition>;

/** A safe stop is not a failure and must never be shown as one. */
export const isSafeStop = (disposition: RepairDisposition): boolean => disposition !== 'completed';

/** One step the policy took. Each is a decision, not a description of a log line. */
export const REPAIR_DECISIONS = [
  'verified_completion',
  'retry_with_backoff',
  'park_until_retry_after',
  'refresh_credential_once',
  'stop_connection_revoked',
  'rediscover_schema',
  'record_repair_candidate',
  'apply_safe_mapping',
  'change_route',
  'reconcile_by_verify',
  'revise_and_revalidate',
  'stop_needs_input',
  'escalate_diagnosis',
] as const;
export const repairDecision = z.enum(REPAIR_DECISIONS);
export type RepairDecision = z.infer<typeof repairDecision>;

/**
 * One line of the repair trace. `payload_hash` is the hash of the bytes that
 * attempt actually put on the wire, so the trace itself proves the payload did
 * not drift: it is the action's own hash on every line except the ones that
 * follow an applied mapping, and a mapping only ever renames a field.
 */
export const repairTraceEntry = z.object({
  at: timestamp,
  /** Which execution of the connector this line belongs to, from one. */
  attempt: z.number().int().nonnegative(),
  fault_kind: connectorFaultKind.nullable().default(null),
  decision: repairDecision,
  detail: z.string(),
  delay_ms: z.number().int().nonnegative().nullable().default(null),
  /** When the destination may be approached again, for a rate limit. */
  retry_after: timestamp.nullable().default(null),
  candidate_id: z.string().nullable().default(null),
  route: z.string().nullable().default(null),
  payload_hash: payloadHash,
});
export type RepairTraceEntry = z.infer<typeof repairTraceEntry>;

export const repairTrace = z.array(repairTraceEntry);

/** How many faults of each class this action met. Absent keys are zero. */
export const repairCounters = z.record(z.string(), z.number().int().nonnegative());
export type RepairCounters = z.infer<typeof repairCounters>;

// --------------------------------------------------------------------------
// Repair candidates
// --------------------------------------------------------------------------

/**
 * A drift mapping is a proposal, never a live change.
 *
 * `candidate` is what re-discovery produced. `evaluated` means its test has
 * run. `applied` means the test passed and the mapping was used for this
 * action's own retry. `rejected` means it did not pass, or the mapping changed
 * a value rather than only a name. Applying without a passing test is not a
 * state this table can hold.
 */
export const REPAIR_CANDIDATE_STATES = ['candidate', 'evaluated', 'applied', 'rejected'] as const;
export const repairCandidateState = z.enum(REPAIR_CANDIDATE_STATES);
export type RepairCandidateState = z.infer<typeof repairCandidateState>;

/**
 * The test a mapping must pass before anything is allowed to use it.
 *
 * `expected` documents the output the mapping intends. It is deliberately not
 * what the test checks: a test that recomputes the expected output with the
 * transform under test proves only that a function is itself. What is checked
 * is stated separately and in the vocabulary of the thing that matters, which
 * is that the operation and every decisive value come through untouched.
 */
export const repairCandidateTest = z.object({
  name: z.string().min(1),
  /** The tool this mapping belongs to. A mapping never changes the operation. */
  operation: z.string().min(1),
  /** The payload the mapping is applied to. */
  input: jsonObject,
  /** What the mapping intends to produce, field for field. */
  expected: jsonObject,
  /**
   * The recipient, destination, amount and resource values that must appear
   * unchanged, at the same paths, in whatever the mapping produces.
   */
  preserves: z.array(z.object({ path: z.string().min(1), value: z.string() })).default([]),
});
export type RepairCandidateTest = z.infer<typeof repairCandidateTest>;

export const repairCandidateEvaluation = z.object({
  passed: z.boolean(),
  detail: z.string(),
  evaluated_at: timestamp,
});
export type RepairCandidateEvaluation = z.infer<typeof repairCandidateEvaluation>;

export const repairCandidateView = z.object({
  id: prefixedId(ID_PREFIXES.repair_candidate),
  action_id: prefixedId(ID_PREFIXES.action),
  job_id: prefixedId(ID_PREFIXES.job),
  connection_id: prefixedId(ID_PREFIXES.connection),
  /** The tool whose call drifted, for example `files.write`. */
  kind: z.string().min(1),
  fault_kind: connectorFaultKind,
  state: repairCandidateState,
  /** The shape re-discovery found, carried opaquely. */
  observed_schema: jsonObject.nullable().default(null),
  /** Old field name to new field name. Nothing else is expressible. */
  proposed_mapping: z.record(z.string(), z.string()),
  test: repairCandidateTest,
  evaluation: repairCandidateEvaluation.nullable().default(null),
  /** True only for a rename whose every value survives unchanged. */
  safe: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type RepairCandidateView = z.infer<typeof repairCandidateView>;

// --------------------------------------------------------------------------
// The read view
// --------------------------------------------------------------------------

export const actionRepairView = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  job_id: prefixedId(ID_PREFIXES.job),
  kind: z.string().min(1),
  effect_class: effectClass,
  status: actionStatus,
  payload_hash: payloadHash,
  intent_key: sha256Hex.nullable().default(null),
  disposition: repairDisposition.nullable().default(null),
  /**
   * True for every disposition except `completed`. A client shows these as
   * their own state, never as a failure: nothing was duplicated and nothing was
   * lost, and in most cases the responsibility is still going.
   */
  safe_stop: z.boolean(),
  retry_after_at: timestamp.nullable().default(null),
  counters: repairCounters.default({}),
  trace: repairTrace.default([]),
  candidates: z.array(repairCandidateView).default([]),
});
export type ActionRepairView = z.infer<typeof actionRepairView>;

export const jobRepairsResponse = z.object({
  job_id: prefixedId(ID_PREFIXES.job),
  repairs: z.array(actionRepairView),
});
export type JobRepairsResponse = z.infer<typeof jobRepairsResponse>;

// --------------------------------------------------------------------------
// Mapping safety
// --------------------------------------------------------------------------

/**
 * Apply a rename mapping to a payload. Keys named in the mapping move; every
 * other key and every value is untouched.
 */
export function applyFieldMapping(
  payload: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) out[mapping[key] ?? key] = value;
  return out;
}

/**
 * Whether a mapping is one a repair may apply on its own: a pure rename at the
 * top level, no key dropped, no key collapsed onto another, and every value
 * carried across byte for byte. A mapping that would change what is sent is not
 * safe however plausible it looks, and stops the action instead.
 */
export function isSafeFieldMapping(
  payload: Record<string, unknown>,
  mapping: Record<string, string>,
): boolean {
  const entries = Object.entries(mapping);
  if (entries.length === 0) return false;
  // A rename of a field that is not there changes nothing and explains nothing.
  if (entries.some(([from]) => !(from in payload))) return false;
  const mapped = applyFieldMapping(payload, mapping);
  if (Object.keys(mapped).length !== Object.keys(payload).length) return false;
  const before = Object.values(payload).map((value) => JSON.stringify(value ?? null));
  const after = Object.values(mapped).map((value) => JSON.stringify(value ?? null));
  before.sort();
  after.sort();
  return JSON.stringify(before) === JSON.stringify(after);
}
