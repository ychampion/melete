import { describe, expect, test } from 'bun:test';
import type { DeliveredItem } from '@melete/contracts';
import { checkPayloadAttribution, payloadCandidates } from './attribution.ts';

const item = (over: Partial<DeliveredItem> & { handle: string }): DeliveredItem => ({
  key: null,
  content: '',
  excerpts: [],
  ...over,
});

const hotelEmail = item({
  handle: 'k_01ARZ3NDEKTSV4RRFFQ69G5FAV@3',
  key: 'contact.hotel.email',
  content: 'desk@hotel.example',
});
const tripDate = item({
  handle: 'k_01ARZ3NDEKTSV4RRFFQ69G5FAW@1',
  key: 'event.trip.date',
  content: '2026-08-10T00:00:00.000Z',
  excerpts: ['the trip is on 10 August 2026'],
});
const deposit = item({
  handle: 'k_01ARZ3NDEKTSV4RRFFQ69G5FAX@1',
  content: 'the deposit was EUR 120.00',
});

describe('a payload must account for what memory gave it', () => {
  test('a recipient taken from a delivered claim without citing it is reported', () => {
    const report = checkPayloadAttribution(
      { to: 'desk@hotel.example', subject: 'Booking' },
      [hotelEmail, tripDate],
      [],
    );
    expect(report.attributed).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      field: 'to',
      kind: 'recipient',
      handle: hotelEmail.handle,
      key: 'contact.hotel.email',
    });
  });

  test('citing the handle accounts for it', () => {
    const report = checkPayloadAttribution(
      { to: 'desk@hotel.example' },
      [hotelEmail],
      [hotelEmail.handle],
    );
    expect(report).toEqual({ attributed: true, findings: [] });
  });

  test('a date written differently is still the same date', () => {
    // The draft says 2026-08-10; the claim's evidence says "10 August 2026".
    // Matching on the literal string alone would miss it, which is the whole
    // point of the check.
    const report = checkPayloadAttribution({ when: '2026-08-10' }, [tripDate], []);
    expect(report.findings.map((finding) => finding.kind)).toContain('date');
    expect(report.findings[0]?.handle).toBe(tripDate.handle);
  });

  test('an amount from an uncited claim is reported', () => {
    const report = checkPayloadAttribution({ amount: '120.00', currency: 'EUR' }, [deposit], []);
    expect(report.findings.some((finding) => finding.kind === 'amount')).toBe(true);
  });

  test('a value memory never delivered is not memory’s business', () => {
    const report = checkPayloadAttribution(
      { to: 'someone@elsewhere.example', subject: 'Hello' },
      [hotelEmail, tripDate, deposit],
      [],
    );
    expect(report).toEqual({ attributed: true, findings: [] });
  });

  test('short fragments are not candidates, because they match everything', () => {
    const fields = payloadCandidates({ ok: 'a', note: 'yes' });
    expect(fields.every((candidate) => candidate.value.length >= 3)).toBe(true);
  });

  test('an address is normalized the way the broker normalizes it', () => {
    const report = checkPayloadAttribution({ to: 'Desk <DESK@Hotel.Example> ' }, [hotelEmail], []);
    expect(report.findings[0]?.value).toBe('desk@hotel.example');
  });
});
