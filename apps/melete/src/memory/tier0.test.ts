import { describe, expect, test } from 'bun:test';
import type { ExtractionProposal, SourceEvent } from '@melete/contracts';
import {
  DEFAULT_TIME_ZONE,
  observationProposals,
  parseTier0Date,
  tier0Values,
  zoneOffsetMinutes,
} from './tier0.ts';
import { checkTier1, validateTier1 } from './validate.ts';

const source = (over: Partial<SourceEvent> = {}): SourceEvent => ({
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  owner_id: 'own_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  space_id: 'sp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  publisher: 'authenticated-owner',
  stream: 'chat',
  source_identity: 'm1',
  stream_sequence: 1,
  source_type: 'message',
  content_ref: 'test',
  event_at: '2026-09-04T09:00:00Z',
  ingested_at: '2026-09-04T09:00:00Z',
  audience: 'private',
  state: 'active',
  eligibility_generation: 1,
  author: 'owner',
  origin_trust: 'owner',
  ...over,
});

describe('tier 0 resolves the facts that decide actions', () => {
  test('a date is resolved against the source event time and the owner zone', () => {
    // "next Friday" said on a Friday is a different day in Auckland and in Los
    // Angeles, and the answer must not depend on where the server is.
    const said = '2026-09-04T09:00:00Z';
    const auckland = parseTier0Date('next Friday', { eventAt: said, timeZone: 'Pacific/Auckland' });
    const losAngeles = parseTier0Date('next Friday', {
      eventAt: said,
      timeZone: 'America/Los_Angeles',
    });
    expect(auckland).not.toBeNull();
    expect(losAngeles).not.toBeNull();
    expect(zoneOffsetMinutes('Pacific/Auckland', new Date(said))).not.toBe(
      zoneOffsetMinutes('America/Los_Angeles', new Date(said)),
    );
    expect(zoneOffsetMinutes(DEFAULT_TIME_ZONE, new Date(said))).toBe(0);
    // An unknown zone falls back to UTC, never to the machine's local time.
    expect(zoneOffsetMinutes('Not/AZone', new Date(said))).toBe(0);
  });

  test('a string that is not only a date does not parse as one', () => {
    expect(
      parseTier0Date('2026-07-10', { eventAt: '2026-07-01T00:00:00Z' })?.slice(0, 10) ?? null,
    ).toBe('2026-07-10');
    expect(
      parseTier0Date('sometime around the tenth-ish', { eventAt: '2026-07-01T00:00:00Z' }),
    ).toBe(null);
    expect(parseTier0Date('', { eventAt: '2026-07-01T00:00:00Z' })).toBeNull();
  });

  test('addresses, numbers, links and amounts are grammar, with exact spans', () => {
    const text = 'write desk@hotel.example or call +351 21 123 4567; the deposit is EUR 120.00';
    const values = tier0Values(text, { eventAt: '2026-09-04T09:00:00Z' });
    const byType = (type: string) => values.filter((value) => value.type === type);
    expect(byType('email')[0]?.value).toBe('desk@hotel.example');
    expect(text.slice(byType('email')[0]?.start ?? 0, byType('email')[0]?.end ?? 0)).toBe(
      'desk@hotel.example',
    );
    expect(byType('phone')[0]?.value).toBe('+351211234567');
    expect(byType('amount')[0]).toMatchObject({ value: '120.00', currency: 'EUR' });
  });

  test('an offset makes segment spans whole-source coordinates', () => {
    const values = tier0Values('desk@hotel.example', { eventAt: '2026-09-04T09:00:00Z' }, 100);
    expect(values[0]).toMatchObject({ start: 100, end: 118 });
  });

  test('an offset shifts every span and changes nothing else', () => {
    // The overlap test that keeps a phone grammar off a date compares spans, so
    // it has to compare them in one coordinate system. When it did not, a
    // segment read at an offset silently lost values a whole source kept.
    const text = 'From 1 October 2026 the price rises from GBP 79.00 to GBP 99.00 a month.';
    const reference = { eventAt: '2026-09-02T00:00:00Z' };
    const base = tier0Values(text, reference);
    const moved = tier0Values(text, reference, 40);
    expect(base.filter((value) => value.type === 'amount').map((value) => value.value)).toEqual([
      '79.00',
      '99.00',
    ]);
    expect(moved.map((value) => `${value.type}:${value.value}`)).toEqual(
      base.map((value) => `${value.type}:${value.value}`),
    );
    expect(moved.map((value) => [value.start, value.end])).toEqual(
      base.map((value) => [value.start + 40, value.end + 40]),
    );
  });

  test('a connector observation becomes a checked fact with no model call', () => {
    const text = JSON.stringify({
      kind: 'calendar_event',
      slug: 'trip',
      summary: 'Trip',
      start: '2026-08-10',
      location: 'Lisbon',
    });
    const proposals = observationProposals(source({ source_type: 'observation' }), text);
    expect(proposals.map((p) => p.key).sort()).toEqual(['event.trip.date', 'event.trip.location']);
    const date = proposals.find((p) => p.key === 'event.trip.date');
    expect(date?.kind).toBe('checked_fact');
    expect(date?.factual_status).toBe('checked');
    expect(date?.content.slice(0, 10)).toBe('2026-08-10');
    // The span is the exact bytes of the field, so the verbatim check that guards
    // a model proposal guards this one too.
    const span = date?.sources[0];
    expect(text.slice(span?.start ?? 0, span?.end ?? 0)).toBe(span?.quote ?? '');
    expect(observationProposals(source({ source_type: 'message' }), text)).toEqual([]);
    expect(observationProposals(source({ source_type: 'observation' }), 'not json')).toEqual([]);
  });

  test('a contact record yields the address and the number, normalized', () => {
    const text = JSON.stringify({
      kind: 'contact',
      slug: 'hotel',
      email: 'Desk@Hotel.Example',
      phone: '+351 21 123 4567',
    });
    const proposals = observationProposals(source({ source_type: 'observation' }), text);
    expect(proposals.find((p) => p.key === 'contact.hotel.email')?.content).toBe(
      'desk@hotel.example',
    );
    expect(proposals.find((p) => p.key === 'contact.hotel.phone')?.content).toBe('+351211234567');
  });
});

// --------------------------------------------------------------------------
// E3 falsifier, pure half: a wrong span and a hallucinated address
// --------------------------------------------------------------------------

const evidenceText = 'The trip is on 2026-08-10 and the desk is desk@hotel.example.';
const evidence = {
  source: source(),
  text: evidenceText,
  segmentStart: 0,
  segmentEnd: evidenceText.length,
};
const span = (start: number, end: number, quote = evidenceText.slice(start, end)) => ({
  source_id: evidence.source.source_id,
  source_version: '1',
  start,
  end,
  quote,
});
const proposal = (over: Record<string, unknown> = {}): ExtractionProposal =>
  ({
    op: 'add',
    expected_revision: null,
    domain_key: 'event.trip.date',
    key: 'event.trip.date',
    content: '2026-08-10T00:00:00.000Z',
    kind: 'user_statement',
    factual_status: 'attributed',
    valid_from: '2026-08-10T00:00:00Z',
    valid_until: null,
    sources: [span(15, 25)],
    ...over,
  }) as ExtractionProposal;

describe('tier 1 may propose a key and a span, and nothing else', () => {
  test('a correct proposal survives every structural check', () => {
    expect(checkTier1(proposal() as never, evidence)).toBeNull();
  });

  test('a date span that does not hold that date is rejected, not moved', () => {
    // The span points at the address, not the date. The old failure mode was to
    // accept the value and quietly attach it to whatever was nearby.
    const wrong = proposal({ sources: [span(41, 59)] });
    expect(checkTier1(wrong as never, evidence)?.reason).toBe('value_not_in_evidence');
    const misquoted = proposal({ sources: [span(15, 25, '2026-09-10')] });
    expect(checkTier1(misquoted as never, evidence)?.reason).toBe('span_not_verbatim');
    const outside = proposal({ sources: [span(15, 25)] });
    expect(checkTier1(outside as never, { ...evidence, segmentStart: 20 })?.reason).toBe(
      'span_outside_segment',
    );
  });

  test('an address the evidence does not contain is rejected', () => {
    const hallucinated = proposal({
      domain_key: 'contact.hotel.email',
      key: 'contact.hotel.email',
      content: 'reservations@other-hotel.example',
      sources: [span(41, 59)],
    });
    expect(checkTier1(hallucinated as never, evidence)?.reason).toBe('value_not_in_evidence');
    const malformed = proposal({
      domain_key: 'contact.hotel.email',
      key: 'contact.hotel.email',
      content: 'not-an-address',
      sources: [span(41, 59)],
    });
    expect(checkTier1(malformed as never, evidence)?.reason).toBe('value_not_well_formed');
  });

  test('a key the registry does not hold is rejected', () => {
    const invented = proposal({ key: 'event.trip.vibe', domain_key: 'event.trip.vibe' });
    expect(checkTier1(invented as never, evidence)?.reason).toBe('key_not_in_registry');
  });

  test('a date a parser cannot resolve is not a date', () => {
    const vague = proposal({ content: 'sometime in the summer' });
    expect(checkTier1(vague as never, evidence)?.reason).toBe('date_not_parseable');
  });

  test('confidence is a hint and can never buy a status', () => {
    const laundered = proposal({
      kind: 'checked_fact',
      factual_status: 'checked',
      confidence: 0.99,
    });
    // Not a connector observation, so `checked` is refused before confidence is
    // even considered; from an observation, the hint is still refused.
    expect(checkTier1(laundered as never, evidence)?.reason).toBe('checked_status_requires_tier0');
    expect(
      checkTier1(laundered as never, {
        ...evidence,
        source: source({ source_type: 'observation' }),
      })?.reason,
    ).toBe('confidence_is_not_a_status');
  });

  test('both bad proposals are rejected with reasons and the good ones survive', () => {
    const { accepted, rejected } = validateTier1(
      [
        proposal({ sources: [span(41, 59)] }),
        proposal({
          domain_key: 'contact.hotel.email',
          key: 'contact.hotel.email',
          content: 'reservations@other-hotel.example',
          sources: [span(41, 59)],
        }),
        proposal(),
        // A proposal with no key keeps the path it had before this existed.
        proposal({ key: undefined, domain_key: 'trip.month', content: 'August' }),
      ],
      evidence,
    );
    expect(rejected.map((r) => [r.index, r.reason])).toEqual([
      [0, 'value_not_in_evidence'],
      [1, 'value_not_in_evidence'],
    ]);
    expect(rejected.every((r) => r.detail.length > 0)).toBe(true);
    expect(accepted).toHaveLength(2);
  });
});
