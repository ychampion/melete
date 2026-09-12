/**
 * The broker protocol. Every external effect is a record before it is a
 * request: the runtime proposes, the broker canonicalizes and classifies,
 * policy admits or refuses, the connector dispatches under an idempotency key,
 * and the receipt is persisted before the runtime learns anything.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ID_PREFIXES, type JsonValue, jsonObject, prefixedId, timestamp } from './common.ts';

/** Shared default for broker requests and the closing ledger check. */
export const BROKER_TIMEOUT_MS = 30_000;

/**
 * How much of the world an action can change. The connector manifest declares
 * the class; policy, not the model, decides what each class costs.
 */
export const EFFECT_CLASSES = ['read', 'write_reversible', 'write_external', 'spend'] as const;
export const effectClass = z.enum(EFFECT_CLASSES).meta({ id: 'EffectClass' });
export type EffectClass = z.infer<typeof effectClass>;

/**
 * proposed -> (needs_approval -> approved | denied) -> admitted -> dispatched
 *   -> succeeded | failed | unknown -> (verify) -> succeeded | failed | unresolved
 *
 * `unknown` means the dispatch may or may not have happened. It is never
 * replayed blindly. `unresolved` is the honest resting place for an action that
 * no verify step can decide.
 */
export const ACTION_STATUSES = [
  'proposed',
  'needs_approval',
  'approved',
  'denied',
  'admitted',
  'dispatched',
  'succeeded',
  'failed',
  'unknown',
  'unresolved',
] as const;
export const actionStatus = z.enum(ACTION_STATUSES).meta({ id: 'ActionStatus' });
export type ActionStatus = z.infer<typeof actionStatus>;

/** Statuses an action can rest in without any further work. */
export const TERMINAL_ACTION_STATUSES = [
  'succeeded',
  'failed',
  'denied',
] as const satisfies readonly ActionStatus[];

export const isTerminalAction = (status: ActionStatus): boolean =>
  (TERMINAL_ACTION_STATUSES as readonly ActionStatus[]).includes(status);

// --------------------------------------------------------------------------
// Canonicalization
// --------------------------------------------------------------------------

/**
 * Payload keys that hold email addresses. Approval binds to a hash, so
 * "Zara <ZARA@Example.COM> " and "zara@example.com" must not produce two
 * different hashes for the same message, or a person would be asked to approve
 * the same send twice.
 */
export const EMAIL_ADDRESS_FIELDS = [
  'to',
  'cc',
  'bcc',
  'from',
  'sender',
  'reply_to',
  'recipient',
  'recipients',
] as const;

const ANGLE_ADDRESS = /<([^<>]+)>\s*$/;

/**
 * Reduce one address to its comparable form: the address inside angle brackets
 * if there is one, trimmed, lowercased. Display names are dropped because they
 * do not change where the mail goes.
 */
export function normalizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const angled = ANGLE_ADDRESS.exec(trimmed);
  const address = angled?.[1] ?? trimmed;
  return address.trim().toLowerCase();
}

const isEmailField = (key: string): boolean =>
  (EMAIL_ADDRESS_FIELDS as readonly string[]).includes(key.toLowerCase());

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();

function canonicalizeValue(value: unknown, key: string | null): JsonValue {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    return key !== null && isEmailField(key) ? normalizeEmailAddress(value) : value.trim();
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`cannot canonicalize non-finite number at ${key ?? '<root>'}`);
    }
    // -0 and 0 hash the same; JSON has one zero.
    return value === 0 ? 0 : value;
  }

  if (typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeValue(item, key));
    // Recipient lists are sets: order and duplicates carry no meaning, and a
    // reordered To: line must not invalidate an approval.
    if (key !== null && isEmailField(key) && items.every((i) => typeof i === 'string')) {
      return uniqueSorted(items as string[]);
    }
    return items;
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const k of Object.keys(source).sort()) {
      const v = source[k];
      if (v === undefined) continue;
      out[k] = canonicalizeValue(v, k);
    }
    return out;
  }

  throw new TypeError(`cannot canonicalize ${typeof value} at ${key ?? '<root>'}`);
}

/**
 * Serialize a canonical value. Keys are already sorted, so `JSON.stringify`
 * emits them in that order and the bytes are stable across processes.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(value);
}

export type CanonicalPayload = {
  /** The normalized payload: sorted keys, trimmed strings, normalized addresses. */
  canonical: Record<string, JsonValue>;
  /** The exact bytes that were hashed. Store it; approvals are argued over it. */
  json: string;
  /** Lowercase hex sha256 of `json`. This is `action.payload_hash`. */
  hash: string;
};

/**
 * Canonicalize a proposed payload and hash it. The hash is the identity of the
 * effect: approval binds to it, retries reuse it, and editing a draft in the UI
 * produces a different hash and therefore a different action.
 */
export function canonicalizePayload(payload: Record<string, unknown>): CanonicalPayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('an action payload must be a plain object');
  }
  const canonical = canonicalizeValue(payload, null) as Record<string, JsonValue>;
  const json = canonicalJson(canonical);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  return { canonical, json, hash };
}

export const payloadHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256 digest');

// --------------------------------------------------------------------------
// Capability token
// --------------------------------------------------------------------------

/**
 * What an attempt is allowed to do, signed by the service. The broker checks
 * the epoch on every call, so a fenced attempt can deliver a late receipt but
 * can never admit new work.
 */
export const capabilityClaims = z.object({
  principal_id: prefixedId(ID_PREFIXES.owner).optional(),
  membership_generation: z.number().int().nonnegative().optional(),
  job_id: prefixedId(ID_PREFIXES.job),
  attempt_id: prefixedId(ID_PREFIXES.attempt),
  space_id: prefixedId(ID_PREFIXES.space),
  epoch: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  scopes: z.array(z.string()),
  budget: z.object({
    max_actions: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().nonnegative(),
    max_usd_est: z.number().nonnegative(),
  }),
  exp: z.number().int().positive(),
});
export type CapabilityClaims = z.infer<typeof capabilityClaims>;

// --------------------------------------------------------------------------
// Broker API
// --------------------------------------------------------------------------

export const proposeActionRequest = z.object({
  /** Tool name from the connector manifest, for example `email.send`. */
  kind: z.string().min(1),
  connection_id: prefixedId(ID_PREFIXES.connection),
  payload: jsonObject,
  /** Set by the runtime so a retried propose does not create a second action. */
  client_ref: z.string().min(1).max(128).optional(),
});
export type ProposeActionRequest = z.infer<typeof proposeActionRequest>;

export const proposeActionResponse = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  status: actionStatus,
  effect_class: effectClass,
  payload_hash: payloadHash,
  canonical_payload: jsonObject,
  requires_approval: z.boolean(),
  approval_id: prefixedId(ID_PREFIXES.approval).nullable(),
});
export type ProposeActionResponse = z.infer<typeof proposeActionResponse>;

export const admitActionRequest = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  /** Repeated by the caller so a mismatch is caught before anything is reserved. */
  payload_hash: payloadHash,
});
export type AdmitActionRequest = z.infer<typeof admitActionRequest>;

export const BROKER_ERROR_CODES = [
  'stale_epoch',
  'revision_mismatch',
  'scope_denied',
  'unknown_connection',
  'unknown_tool',
  'payload_invalid',
  'schema_invalid',
  'approval_required',
  'approval_denied',
  'approval_hash_mismatch',
  'budget_exceeded',
  'action_not_found',
  'action_not_admissible',
  'connector_unavailable',
  // A recipient, destination, amount or resource field did not resolve to an
  // origin Melete can vouch for, and no approval bound to that doubt exists.
  'untrusted_recipient_origin',
] as const;
export const brokerErrorCode = z.enum(BROKER_ERROR_CODES);
export type BrokerErrorCode = z.infer<typeof brokerErrorCode>;

export const brokerError = z.object({
  code: brokerErrorCode,
  message: z.string(),
  action_id: prefixedId(ID_PREFIXES.action).nullable().optional(),
});
export type BrokerError = z.infer<typeof brokerError>;

export const admitActionResponse = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  status: actionStatus,
  budget_reservation: z
    .object({
      ledger_id: prefixedId(ID_PREFIXES.ledger),
      kind: z.enum(['tokens', 'usd_est', 'calls']),
      reserved: z.number().nonnegative(),
    })
    .nullable(),
});
export type AdmitActionResponse = z.infer<typeof admitActionResponse>;

export const dispatchRequest = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  /** Always the action id, so a connector retry is the same request. */
  idempotency_key: z.string().min(1),
});
export type DispatchRequest = z.infer<typeof dispatchRequest>;

export const receipt = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
  connection_id: prefixedId(ID_PREFIXES.connection),
  /** The connector's own handle: a Message-ID, a CalDAV UID, a content hash. */
  external_ref: z.string().nullable(),
  detail: jsonObject,
  received_at: timestamp,
  /** True when the receipt arrived from an attempt that had already been fenced. */
  late: z.boolean().default(false),
});
export type Receipt = z.infer<typeof receipt>;

export const dispatchResult = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('succeeded'), receipt }),
  z.object({ outcome: z.literal('failed'), reason: z.string(), retryable: z.boolean() }),
  // The dispatch left the process and the answer never came back. Nothing is
  // resent; the job goes to needs_reconciliation until verify or a person decides.
  z.object({ outcome: z.literal('unknown'), reason: z.string() }),
]);
export type DispatchResult = z.infer<typeof dispatchResult>;

export const verifyRequest = z.object({
  action_id: prefixedId(ID_PREFIXES.action),
});
export type VerifyRequest = z.infer<typeof verifyRequest>;

/**
 * A connector's answer to "did this actually happen?". `undecided` is a real
 * answer and produces `unresolved`, which the UI shows to the owner as a
 * question rather than hiding behind a guess.
 */
export const verifyResult = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('succeeded'), evidence: jsonObject, receipt: receipt.nullable() }),
  z.object({ decision: z.literal('failed'), evidence: jsonObject }),
  z.object({ decision: z.literal('undecided'), reason: z.string() }),
  z.object({ decision: z.literal('unsupported'), reason: z.string() }),
]);
export type VerifyResult = z.infer<typeof verifyResult>;

export const approvalDecision = z.enum(['approved', 'denied']);
export type ApprovalDecision = z.infer<typeof approvalDecision>;

export const approvalRequestView = z
  .object({
    approval_id: prefixedId(ID_PREFIXES.approval),
    action_id: prefixedId(ID_PREFIXES.action),
    job_id: prefixedId(ID_PREFIXES.job),
    job_revision: z.number().int().nonnegative(),
    kind: z.string(),
    effect_class: effectClass,
    connection_id: prefixedId(ID_PREFIXES.connection),
    /** Rendered by the client from this record, never from model text. */
    canonical_payload: jsonObject,
    payload_hash: payloadHash,
    requested_at: timestamp,
    expires_at: timestamp.nullable(),
  })
  .meta({ id: 'ApprovalRequest' });
export type ApprovalRequestView = z.infer<typeof approvalRequestView>;

export const approvalDecisionRequest = z.object({
  decision: approvalDecision,
  /** The hash the person was shown. A mismatch means the draft moved under them. */
  payload_hash: payloadHash,
  note: z.string().max(2000).optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequest>;
