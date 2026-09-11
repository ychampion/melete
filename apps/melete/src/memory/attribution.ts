/**
 * E1. The cheap check that makes "dependence is declared" enforceable.
 *
 * The runtime declares, in a `uses` manifest, which revisions an output rests on.
 * This function asks the opposite question: does the payload contain a recipient,
 * a date, an amount or an identifier that appears in something memory delivered
 * to this attempt, but whose handle the manifest does not name? Every hit is a
 * value the model took from memory without admitting it, and the broker refuses
 * a `write_external` or `spend` that has one.
 *
 * It is pure. It reads the payload and the items as they were delivered, has no
 * database, and cannot be influenced by anything the payload says about itself.
 */
import {
  type AttributionFinding,
  type AttributionKind,
  type AttributionReport,
  type DeliveredItem,
  EMAIL_ADDRESS_FIELDS,
  type JsonValue,
  normalizeEmailAddress,
} from '@melete/contracts';
import { tier0Values } from './tier0.ts';
import { payloadFields } from './trust.ts';

/** A date that carries no year resolves against this, on both sides, so the comparison is stable. */
const NEUTRAL_REFERENCE = '1970-01-01T00:00:00.000Z';

const IDENTIFIER = /\b[A-Za-z0-9][A-Za-z0-9._/-]{7,}\b/g;
const AMOUNT_FIELD = /(^|[._])(amount|total|price|cost|sum|value)([._]|$)/i;
const isEmailField = (field: string) => {
  const leaf = field.split(/[.[]/).filter(Boolean).pop() ?? field;
  return (EMAIL_ADDRESS_FIELDS as readonly string[]).includes(leaf.replace(/]$/, '').toLowerCase());
};

export type Candidate = { field: string; value: string; kind: AttributionKind };

/**
 * Every value in the payload worth tracing. Short strings are skipped: a two
 * character fragment matches everything and would make the check useless noise.
 */
export function payloadCandidates(payload: Record<string, JsonValue>): Candidate[] {
  const candidates: Candidate[] = [];
  const push = (field: string, value: string, kind: AttributionKind) => {
    const trimmed = value.trim();
    if (trimmed.length < 3) return;
    if (candidates.some((c) => c.field === field && c.value === trimmed && c.kind === kind)) return;
    candidates.push({ field, value: trimmed, kind });
  };
  for (const { field, value } of payloadFields(payload as JsonValue)) {
    if (isEmailField(field)) push(field, normalizeEmailAddress(value), 'recipient');
    if (AMOUNT_FIELD.test(field)) push(field, value, 'amount');
    for (const found of tier0Values(value, { eventAt: NEUTRAL_REFERENCE })) {
      if (found.type === 'email') push(field, found.value, 'recipient');
      if (found.type === 'date') push(field, found.text, 'date');
      if (found.type === 'amount') push(field, found.text, 'amount');
      if (found.type === 'url' || found.type === 'phone') push(field, found.value, 'identifier');
    }
    IDENTIFIER.lastIndex = 0;
    for (let match = IDENTIFIER.exec(value); match; match = IDENTIFIER.exec(value))
      push(field, match[0], 'identifier');
  }
  return candidates;
}

const normalize = (value: string) => value.trim().toLowerCase();
const haystackOf = (item: DeliveredItem) =>
  normalize([item.content, ...(item.excerpts ?? [])].join('\n'));
const daysIn = (text: string) =>
  new Set(
    tier0Values(text, { eventAt: NEUTRAL_REFERENCE })
      .filter((value) => value.type === 'date')
      .map((value) => value.value.slice(0, 10)),
  );

/** Did this value come from this item? Literal containment, or the same calendar day. */
function cameFrom(candidate: Candidate, item: DeliveredItem): boolean {
  const haystack = haystackOf(item);
  if (haystack.includes(normalize(candidate.value))) return true;
  if (candidate.kind !== 'date') return false;
  const wanted = daysIn(candidate.value);
  if (!wanted.size) return false;
  const present = daysIn(haystack);
  for (const day of wanted) if (present.has(day)) return true;
  return false;
}

/**
 * Report every payload value that came from a delivered item the manifest did
 * not cite. An empty report means the payload is fully accounted for by what the
 * attempt admitted to using.
 */
export function checkPayloadAttribution(
  payload: Record<string, JsonValue>,
  delivered: readonly DeliveredItem[],
  uses: readonly string[],
): AttributionReport {
  const cited = new Set(uses);
  const findings: AttributionFinding[] = [];
  for (const candidate of payloadCandidates(payload)) {
    for (const item of delivered) {
      if (cited.has(item.handle)) continue;
      if (!cameFrom(candidate, item)) continue;
      if (
        findings.some(
          (finding) => finding.field === candidate.field && finding.handle === item.handle,
        )
      )
        continue;
      findings.push({
        field: candidate.field,
        value: candidate.value.slice(0, 1000),
        kind: candidate.kind,
        handle: item.handle,
        key: item.key ?? null,
      });
      if (findings.length >= 64) return { attributed: false, findings };
    }
  }
  return { attributed: findings.length === 0, findings };
}
