/**
 * Provenance: the four properties that turn "Melete remembers correctly" from a
 * promise into something a test can falsify.
 *
 * E1 Dependence is declared. Every recall item carries a stable handle, and
 *    every consequential output carries the manifest of handles it used, so a
 *    correction invalidates exactly the outputs that cited the old revision.
 * E2 One active head per key. Keys come from a registry in the schema, not from
 *    extraction, and the database allows one active head per (space, key,
 *    audience). A second head is a contradiction, not a silent overwrite.
 * E3 Deterministic extractors first. Tier 0 resolves dates, addresses, phone
 *    numbers, URLs and amounts before any model call; Tier 1 may only propose a
 *    key and a span, and every span and value is re-derived from the evidence.
 * E4 Trust class travels. A claim is only as trustworthy as its weakest source,
 *    and a field in an outgoing payload can say where its value came from.
 *
 * The key registry, the trust classes and the handle format live in `memory.ts`
 * beside the claim they describe; everything an output, a repair brief, a
 * contradiction or a trust resolution needs lives here.
 */

import { z } from 'zod';
import { jsonObject, prefixedId, timestamp } from './common.ts';
import { claimHandle, memoryHandle, memoryKey, originTrust } from './memory.ts';

const boundedIdentity = z.string().min(1).max(240);
const boundedText = z.string().max(4000);

// --------------------------------------------------------------------------
// E1 outputs and their `uses` manifests
// --------------------------------------------------------------------------

/**
 * The three consequential things an attempt produces. Chat prose is not here:
 * it has no manifest, keeps the conservative invalidation rule, and is labelled
 * `unattributed` on the context record rather than pretending to be precise.
 */
export const OUTPUT_KINDS = ['artifact', 'plan_step', 'action'] as const;
export const outputKind = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof outputKind>;

export const usesManifest = z.array(memoryHandle).max(64);

/** What the runtime declares after writing an artifact, storing a plan step, or proposing an action. */
export const outputAttribution = z.strictObject({
  job_id: prefixedId('job'),
  attempt_id: prefixedId('att').nullable().default(null),
  kind: outputKind,
  output_id: boundedIdentity,
  output_version: boundedIdentity,
  /** Where inside the output the cited values sit: `paragraph 2`, `step 2`, `to`. */
  location: z.string().max(240).nullable().default(null),
  uses: usesManifest,
});
export type OutputAttribution = z.infer<typeof outputAttribution>;

export const outputAttributionResponse = z.strictObject({
  output_id: boundedIdentity,
  output_version: boundedIdentity,
  /** False when the manifest was empty: this output falls back to conservative invalidation. */
  attributed: z.boolean(),
  /** Handles the manifest named that memory has no record of. They are recorded, never trusted. */
  unknown_handles: z.array(z.string()).max(64),
});

/** One item as it was delivered to the attempt. The attribution check reads nothing else. */
export const deliveredItem = z.strictObject({
  handle: claimHandle,
  key: memoryKey.nullable().default(null),
  content: z.string().max(16000),
  excerpts: z.array(z.string().max(16000)).max(32).default([]),
});
export type DeliveredItem = z.infer<typeof deliveredItem>;

export const attributionKind = z.enum(['recipient', 'date', 'amount', 'identifier']);
export type AttributionKind = z.infer<typeof attributionKind>;

/** A value in the payload that came from a delivered item the manifest did not cite. */
export const attributionFinding = z.strictObject({
  field: z.string().max(240),
  value: z.string().max(1000),
  kind: attributionKind,
  handle: claimHandle,
  key: memoryKey.nullable(),
});
export type AttributionFinding = z.infer<typeof attributionFinding>;

export const attributionRequest = z.strictObject({
  payload: jsonObject,
  uses: usesManifest,
  delivered: z.array(deliveredItem).max(64),
});
export const attributionReport = z.strictObject({
  attributed: z.boolean(),
  findings: z.array(attributionFinding).max(64),
});
export type AttributionReport = z.infer<typeof attributionReport>;

// --------------------------------------------------------------------------
// E1 repair briefs
// --------------------------------------------------------------------------

export const repairTarget = z.strictObject({
  kind: outputKind,
  output_id: boundedIdentity,
  output_version: boundedIdentity,
  location: z.string().max(240).nullable(),
});

/**
 * What the next attempt is told after a correction: which handle moved, what the
 * value was and now is, and exactly which outputs said the old thing and where.
 */
export const repairBrief = z.strictObject({
  id: boundedIdentity,
  job_id: prefixedId('job'),
  key: memoryKey.nullable(),
  changed_handle: claimHandle,
  replacement_handle: claimHandle.nullable(),
  old_value: boundedText,
  new_value: boundedText,
  affected: z.array(repairTarget).max(64),
  created_at: timestamp,
});
export type RepairBrief = z.infer<typeof repairBrief>;
export const repairBriefList = z.strictObject({ repair_briefs: z.array(repairBrief) });

// --------------------------------------------------------------------------
// E2 contradictions and the one owner question
// --------------------------------------------------------------------------

export const contradiction = z.strictObject({
  id: boundedIdentity,
  space_id: prefixedId('sp'),
  key: memoryKey,
  audience: z.enum(['private', 'space', 'public']),
  claim_id: prefixedId('k'),
  /** The revision that holds the active slot while the key is disputed. */
  head: claimHandle,
  /** The alternative the proposal asserted. It is committed, not dropped. */
  alternative: claimHandle,
  state: z.enum(['open', 'resolved']),
  question_id: boundedIdentity.nullable(),
  recorded_at: timestamp,
});
export type Contradiction = z.infer<typeof contradiction>;
export const contradictionList = z.strictObject({ contradictions: z.array(contradiction) });

/**
 * One question, one key. `because` names the two revision handles that disagree
 * and `if_ignored` says what happens if nobody answers; a question with an empty
 * `because` is refused at the outbox rather than sent.
 */
export const memoryOwnerQuestion = z.strictObject({
  id: boundedIdentity,
  space_id: prefixedId('sp'),
  key: memoryKey,
  question: z.string().min(1).max(2000),
  because: z.array(claimHandle).min(1).max(16),
  if_ignored: z.string().min(1).max(2000),
  state: z.enum(['queued', 'answered', 'withdrawn']),
  created_at: timestamp,
});
export type MemoryOwnerQuestion = z.infer<typeof memoryOwnerQuestion>;
export const memoryOwnerQuestionList = z.strictObject({
  questions: z.array(memoryOwnerQuestion),
});

// --------------------------------------------------------------------------
// E3 rejected proposals
// --------------------------------------------------------------------------

export const REJECTION_REASONS = [
  'key_not_in_registry',
  'span_not_verbatim',
  'span_outside_segment',
  'value_not_in_evidence',
  'date_not_parseable',
  'value_not_well_formed',
  'confidence_is_not_a_status',
  'checked_status_requires_tier0',
] as const;
export const rejectionReason = z.enum(REJECTION_REASONS);
export type RejectionReason = z.infer<typeof rejectionReason>;

/** A rejected proposal is recorded with its reason. It is never attached to a nearby message. */
export const rejectedProposal = z.strictObject({
  work_id: boundedIdentity,
  index: z.number().int().nonnegative(),
  key: z.string().max(200).nullable(),
  reason: rejectionReason,
  detail: z.string().max(1000),
  recorded_at: timestamp,
});
export type RejectedProposal = z.infer<typeof rejectedProposal>;
export const rejectedProposalList = z.strictObject({ rejected: z.array(rejectedProposal) });

// --------------------------------------------------------------------------
// E4 trust resolution
// --------------------------------------------------------------------------

/** One field of a canonical payload, with the origin a person would be shown. */
export const fieldTrust = z.strictObject({
  field: z.string().max(240),
  value: z.string().max(1000),
  handle: memoryHandle.nullable(),
  origin_trust: originTrust,
  /** Written for a person: "this address came from a web page fetched on 11 September". */
  description: z.string().max(500),
});
export type FieldTrust = z.infer<typeof fieldTrust>;

export const trustRequest = z.strictObject({
  payload: jsonObject,
  handles: usesManifest,
});
export const trustResolution = z.strictObject({
  fields: z.array(fieldTrust).max(64),
  /** The weakest class any field resolved to; `inferred` when nothing resolved. */
  minimum_trust: originTrust,
  /** True when at least one field resolved and every resolved field is owner or verified connector. */
  actionable: z.boolean(),
  /**
   * Payload fields memory could not place. The broker treats an untraceable
   * recipient, amount or resource as needing a fresh approval, so this list is
   * the honest answer rather than a silent pass.
   */
  unresolved: z.array(z.string().max(240)).max(64),
});
export type TrustResolution = z.infer<typeof trustResolution>;

/**
 * The seam the broker's admission rule holds. Memory implements it; the broker
 * is handed one and never reaches into memory itself.
 */
export interface TrustResolver {
  resolve(input: {
    space_id: string;
    payload: Record<string, unknown>;
    handles: readonly string[];
  }): Promise<TrustResolution>;
}
