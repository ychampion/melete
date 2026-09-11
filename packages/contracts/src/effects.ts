/**
 * Effect identity and the origin of the values an effect carries.
 *
 * Two ideas live here, both additive to the frozen broker protocol.
 *
 * The first is the intent key. An action's payload hash says what would be
 * done; the intent key says which single real-world effect it is. It is derived
 * from the job, the job revision, the connection, the tool, and the canonical
 * payload hash, so a runtime that dies and retries proposes the same key and
 * gets the action that already exists rather than a second one. A changed
 * payload is a different key by construction, so editing a draft can never
 * silently reuse an earlier decision.
 *
 * The second is origin trust. A recipient, a destination, an amount or a
 * resource is not just a value: it came from somewhere. An address the owner
 * typed and an address lifted out of a web page look identical in a payload and
 * are not the same thing. Every value that decides where an external write goes
 * or what a spend costs carries the class of its origin and the handle it came
 * from, and anything that is not the owner or a verified connector becomes a
 * warning the person sees before they answer.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { proposeActionResponse } from './broker.ts';

// --------------------------------------------------------------------------
// Effect identity
// --------------------------------------------------------------------------

/** Lowercase hex sha256, the shape every identity in this file uses. */
export const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex sha256 digest');

export const intentKeyInput = z.object({
  job_id: z.string().min(1),
  job_revision: z.number().int().nonnegative(),
  connection_id: z.string().min(1),
  kind: z.string().min(1),
  payload_hash: sha256Hex,
});
export type IntentKeyInput = z.infer<typeof intentKeyInput>;

/**
 * The identity of one intended effect. Length-prefixed fields, so no pair of
 * different tuples can produce the same bytes by running two values together.
 */
export function intentKey(input: IntentKeyInput): string {
  const parsed = intentKeyInput.parse(input);
  const parts = [
    parsed.job_id,
    String(parsed.job_revision),
    parsed.connection_id,
    parsed.kind,
    parsed.payload_hash,
  ];
  const encoded = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

// --------------------------------------------------------------------------
// Origin trust
// --------------------------------------------------------------------------

/**
 * Where a value in a payload came from.
 *
 * `owner` is a value the person supplied. `verified_connector` is a value read
 * from an account they connected. `external_content` is a value that arrived in
 * something Melete read: a web page, a message, an attachment. `inferred` is a
 * value the model produced without either. `unknown` is the honest default and
 * is treated exactly as harshly as the rest.
 */
export const ORIGIN_TRUST_CLASSES = [
  'owner',
  'verified_connector',
  'external_content',
  'inferred',
  'unknown',
] as const;
export const originTrust = z.enum(ORIGIN_TRUST_CLASSES);
export type OriginTrust = z.infer<typeof originTrust>;

/** The two classes that can carry an external write or a spend on their own. */
export const TRUSTED_ORIGIN_CLASSES = [
  'owner',
  'verified_connector',
] as const satisfies ReadonlyArray<OriginTrust>;

export const isTrustedOrigin = (trust: OriginTrust): boolean =>
  (TRUSTED_ORIGIN_CLASSES as readonly OriginTrust[]).includes(trust);

/** The effect classes whose payload values must resolve to a trusted origin. */
export const TRUST_GATED_EFFECT_CLASSES = ['write_external', 'spend'] as const;

export const isTrustGatedEffect = (effectClass: string): boolean =>
  (TRUST_GATED_EFFECT_CLASSES as readonly string[]).includes(effectClass);

/** What kind of decision a payload value makes. */
export const ORIGIN_FIELD_CATEGORIES = ['recipient', 'destination', 'amount', 'resource'] as const;
export const originFieldCategory = z.enum(ORIGIN_FIELD_CATEGORIES);
export type OriginFieldCategory = z.infer<typeof originFieldCategory>;

/** One value in a canonical payload that decides where an effect lands. */
export const originField = z.object({
  /** Dotted path into the canonical payload, with array indices: `to[1]`. */
  path: z.string().min(1),
  category: originFieldCategory,
  /** The canonical value as a string; numbers are rendered, never rounded. */
  value: z.string(),
});
export type OriginField = z.infer<typeof originField>;

/** A resolver's answer for one field. */
export const originResolution = originField.extend({
  origin_trust: originTrust,
  /** The memory handle the value came from, when there is one. */
  handle: z.string().nullable(),
  /** Plain words for the approval screen. Never model text. */
  description: z.string().min(1),
});
export type OriginResolution = z.infer<typeof originResolution>;

/**
 * One reason the person is being asked. The approval record carries these and
 * the API hands them to the client, so a screen can say "this address came from
 * a web page fetched on Friday" instead of showing an address with no history.
 */
export const originWarning = z.object({
  field: z.string().min(1),
  origin_trust: originTrust,
  handle: z.string().nullable(),
  description: z.string().min(1),
});
export type OriginWarning = z.infer<typeof originWarning>;

export const originWarnings = z.array(originWarning);

/**
 * Sort and de-duplicate so the same set of doubts always hashes the same way,
 * whatever order a resolver produced them in.
 */
export function canonicalOriginWarnings(warnings: OriginWarning[]): OriginWarning[] {
  const seen = new Map<string, OriginWarning>();
  for (const warning of originWarnings.parse(warnings)) {
    const key = JSON.stringify([
      warning.field,
      warning.origin_trust,
      warning.handle,
      warning.description,
    ]);
    if (!seen.has(key)) seen.set(key, warning);
  }
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, w]) => w);
}

/**
 * The identity of a set of doubts. An approval is bound to this, so a decision
 * taken when the set was empty cannot be spent once the set is not.
 */
export function hashOriginWarnings(warnings: OriginWarning[]): string {
  const canonical = canonicalOriginWarnings(warnings);
  const json = JSON.stringify(
    canonical.map((warning) => [
      warning.field,
      warning.origin_trust,
      warning.handle,
      warning.description,
    ]),
  );
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

/** The hash of "nothing is in doubt", which is a real answer and not an absence. */
export const NO_ORIGIN_WARNINGS = hashOriginWarnings([]);

/** Only untrusted origins become warnings; the trusted classes are silent. */
export function warningsFor(resolutions: OriginResolution[]): OriginWarning[] {
  return canonicalOriginWarnings(
    resolutions
      .filter((resolution) => !isTrustedOrigin(resolution.origin_trust))
      .map((resolution) => ({
        field: resolution.path,
        origin_trust: resolution.origin_trust,
        handle: resolution.handle,
        description: resolution.description,
      })),
  );
}

// --------------------------------------------------------------------------
// What a proposal answers with
// --------------------------------------------------------------------------

/**
 * The proposal response, plus what the runtime needs in order to tell the truth
 * about a repeat. `message` is the sentence the tool result carries: a second
 * proposal of a send that already happened says so and names the receipt, and a
 * second proposal of a send nobody can confirm says that instead of pretending.
 */
export const effectProposalResponse = proposeActionResponse.extend({
  intent_key: sha256Hex,
  /** True when this proposal found an action that already existed. */
  repeated: z.boolean(),
  /** Plain words, built from the record. Never model text. */
  message: z.string().min(1),
  origin_warnings: originWarnings.default([]),
});
export type EffectProposalResponse = z.infer<typeof effectProposalResponse>;
