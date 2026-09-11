/**
 * E3 Tier 1. What the model is allowed to contribute, and what is checked.
 *
 * A Tier-1 proposal may name a key and a span. Everything else about it is
 * re-derived here from the evidence itself: the span must be verbatim and inside
 * the segment that was delivered, the key must already exist in the registry, and
 * the value must be one Tier 0 found in the cited span. A date is only a date if
 * the Tier-0 parser says so; an address is only an address if the grammar and
 * the evidence both agree. `confidence` is recorded as a hint and can never
 * become a status.
 *
 * A proposal that fails is rejected with a reason and recorded. It is never
 * quietly attached to a nearby message, which is the failure mode this exists to
 * prevent.
 *
 * Proposals with no key take the path they took before: the whole-set validation
 * in `commit.ts` still owns them, so nothing that worked before changes shape.
 */
import {
  type ExtractionProposal,
  isMemoryKey,
  memoryKeyValue,
  type RejectionReason,
  type SourceEvent,
} from '@melete/contracts';
import { normalizeEmail, normalizePhone, parseTier0Date, tier0Values } from './tier0.ts';

export type Tier1Rejection = {
  index: number;
  key: string | null;
  reason: RejectionReason;
  detail: string;
};
export type Tier1Evidence = {
  source: SourceEvent;
  /** The exact segment the extractor was given. */
  text: string;
  segmentStart: number;
  segmentEnd: number;
  timeZone?: string;
};

const EMAIL_SHAPE =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z]{2,})+$/;
const PHONE_SHAPE = /^\+?\d{7,20}$/;

type Keyed = Extract<ExtractionProposal, { op: 'add' | 'supersede' }> & { key: string };
const keyed = (proposal: ExtractionProposal): proposal is Keyed =>
  (proposal.op === 'add' || proposal.op === 'supersede') && typeof proposal.key === 'string';

/**
 * Check one keyed proposal against the evidence. Returns the reason it fails, or
 * null when every structural check holds.
 */
export function checkTier1(
  proposal: Keyed,
  evidence: Tier1Evidence,
): { reason: RejectionReason; detail: string } | null {
  if (!isMemoryKey(proposal.key))
    return {
      reason: 'key_not_in_registry',
      detail: 'the registry grows by a reviewed commit, not by extraction',
    };
  for (const span of proposal.sources) {
    if (
      span.source_id !== evidence.source.source_id ||
      span.source_version !== evidence.source.source_version ||
      span.start < evidence.segmentStart ||
      span.end > evidence.segmentEnd ||
      span.start >= span.end
    )
      return {
        reason: 'span_outside_segment',
        detail: 'a span may only cite the segment this invocation was given',
      };
    const actual = evidence.text.slice(
      span.start - evidence.segmentStart,
      span.end - evidence.segmentStart,
    );
    if (actual !== span.quote)
      return {
        reason: 'span_not_verbatim',
        detail: 'the quoted text is not what the evidence holds at those offsets',
      };
  }
  if (proposal.factual_status === 'checked') {
    if (!evidence.source.source_type.match(/^(observation|receipt)$/))
      return {
        reason: 'checked_status_requires_tier0',
        detail:
          'only a deterministic extractor over a connector observation may mark a claim checked',
      };
    if (proposal.confidence !== undefined)
      return {
        reason: 'confidence_is_not_a_status',
        detail: 'a confidence hint cannot be spent to buy a checked status',
      };
  }
  // Only the cited spans count. A value found elsewhere in the segment is a
  // value the proposal did not actually point at.
  const cited = proposal.sources
    .map((span) =>
      evidence.text.slice(span.start - evidence.segmentStart, span.end - evidence.segmentStart),
    )
    .join('\n');
  const found = tier0Values(cited, {
    eventAt: evidence.source.event_at,
    timeZone: evidence.timeZone,
  });
  const content = proposal.content.trim();
  switch (memoryKeyValue(proposal.key)) {
    case 'date': {
      const resolved = parseTier0Date(content, {
        eventAt: evidence.source.event_at,
        timeZone: evidence.timeZone,
      });
      if (!resolved)
        return {
          reason: 'date_not_parseable',
          detail: 'a date key holds a date the Tier-0 parser resolves, not free text',
        };
      const day = resolved.slice(0, 10);
      if (!found.some((value) => value.type === 'date' && value.value.slice(0, 10) === day))
        return {
          reason: 'value_not_in_evidence',
          detail: 'the cited span does not contain that date',
        };
      return null;
    }
    case 'email': {
      if (!EMAIL_SHAPE.test(content))
        return { reason: 'value_not_well_formed', detail: 'not an address by grammar' };
      const wanted = normalizeEmail(content);
      if (!found.some((value) => value.type === 'email' && value.value === wanted))
        return {
          reason: 'value_not_in_evidence',
          detail: 'the cited span does not contain that address',
        };
      return null;
    }
    case 'phone': {
      const wanted = normalizePhone(content);
      if (!PHONE_SHAPE.test(wanted))
        return { reason: 'value_not_well_formed', detail: 'not a phone number by grammar' };
      if (!found.some((value) => value.type === 'phone' && value.value === wanted))
        return {
          reason: 'value_not_in_evidence',
          detail: 'the cited span does not contain that number',
        };
      return null;
    }
    default: {
      if (!cited.toLowerCase().includes(content.toLowerCase()))
        return {
          reason: 'value_not_in_evidence',
          detail: 'the cited span does not contain that value',
        };
      return null;
    }
  }
}

/**
 * Split a change set into what survives structural validation and what does not.
 * Unkeyed proposals pass through untouched.
 */
export function validateTier1(
  proposals: readonly ExtractionProposal[],
  evidence: Tier1Evidence,
): { accepted: ExtractionProposal[]; rejected: Tier1Rejection[] } {
  const accepted: ExtractionProposal[] = [];
  const rejected: Tier1Rejection[] = [];
  proposals.forEach((proposal, index) => {
    if (!keyed(proposal)) {
      accepted.push(proposal);
      return;
    }
    const failure = checkTier1(proposal, evidence);
    if (failure) rejected.push({ index, key: proposal.key, ...failure });
    else accepted.push(proposal);
  });
  return { accepted, rejected };
}
