import { describe, expect, test } from 'bun:test';
import type { LedgerItem } from '@melete/contracts';
import type { ExtractedItem } from './extract.ts';
import { computeTotals } from './totals.ts';
import { type AdmissionContext, admit, admitAll, dedupeKey } from './validate.ts';

const TEXT =
  'Subject: Your refund\n\nA refund of GBP 129.99 will reach your account within 10 working days.';
const QUOTE = 'A refund of GBP 129.99 will reach your account within 10 working days.';
const START = TEXT.indexOf(QUOTE);

const context: AdmissionContext = {
  spaceId: 'sp_01J0000000000000000000000A',
  principalId: 'own_01J0000000000000000000000B',
  companyId: 'co_01J0000000000000000000000C',
  messageId: '<m1@example.test>',
  messageText: TEXT,
};

const candidate = (over: Partial<ExtractedItem> = {}): ExtractedItem => ({
  kind: 'refund_owed',
  direction: 'owed_to_you',
  amount_minor: 12999,
  currency: 'GBP',
  due_at: null,
  confidence: 'high',
  suggested_playbook: 'refund-owed',
  summary: 'Refund owed to you',
  evidence: [{ quote: QUOTE, start: START, end: START + QUOTE.length }],
  ...over,
});

describe('the admission gate', () => {
  test('a due date given without a time is admitted as a date, and says so', () => {
    const dated = admit(candidate({ due_at: '2026-09-25' }), context);
    const timed = admit(candidate({ due_at: '2026-09-25T00:00:00Z' }), context);
    const none = admit(candidate(), context);
    expect(dated.admitted && dated.item).toMatchObject({
      due_at: '2026-09-25T00:00:00.000Z',
      due_date_only: true,
    });
    // Midnight stated as a time is still a time.
    expect(timed.admitted && timed.item.due_date_only).toBe(false);
    expect(none.admitted && none.item.due_date_only).toBe(false);
  });

  test('admits a claim whose quote sits exactly where it says it does', () => {
    const result = admit(candidate(), context);
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.item.amount_minor).toBe(12999);
    expect(result.item.status).toBe('found');
    expect(result.item.evidence[0]?.message_id).toBe('<m1@example.test>');
  });

  test('drops a fabricated quote, however plausible it reads', () => {
    const invented = 'A refund of GBP 900.00 will reach your account within 3 working days.';
    const result = admit(
      candidate({
        amount_minor: 90000,
        evidence: [{ quote: invented, start: START, end: START + invented.length }],
      }),
      context,
    );
    expect(result).toEqual({ admitted: false, reason: 'evidence_span' });
  });

  test('drops a real sentence carrying the wrong span', () => {
    const result = admit(
      candidate({ evidence: [{ quote: QUOTE, start: START + 1, end: START + 1 + QUOTE.length }] }),
      context,
    );
    expect(result).toEqual({ admitted: false, reason: 'evidence_span' });
  });

  test('drops a span that runs past the end of the message', () => {
    const result = admit(
      candidate({ evidence: [{ quote: QUOTE, start: START, end: TEXT.length + 5 }] }),
      context,
    );
    expect(result).toEqual({ admitted: false, reason: 'evidence_span' });
  });

  test('drops every item whose second quote fails, not only its first', () => {
    const result = admit(
      candidate({
        evidence: [
          { quote: QUOTE, start: START, end: START + QUOTE.length },
          { quote: 'never written', start: 0, end: 13 },
        ],
      }),
      context,
    );
    expect(result).toEqual({ admitted: false, reason: 'evidence_span' });
  });

  test('refuses an amount with no currency, which names no quantity', () => {
    expect(admit(candidate({ currency: null }), context)).toEqual({
      admitted: false,
      reason: 'amount_without_currency',
    });
  });

  test('refuses money on an item that is not about money', () => {
    expect(admit(candidate({ direction: 'info' }), context)).toEqual({
      admitted: false,
      reason: 'info_with_amount',
    });
  });

  test('refuses a due date that is not a date', () => {
    expect(admit(candidate({ due_at: 'sometime soon' }), context)).toEqual({
      admitted: false,
      reason: 'bad_due_date',
    });
  });
});

describe('dedupe', () => {
  test('one claim read out of two emails is one item', () => {
    const second: AdmissionContext = { ...context, messageId: '<m2@example.test>' };
    const result = admitAll([
      { candidate: candidate(), context },
      { candidate: candidate(), context: second },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.drops.duplicate).toBe(1);
    // The surviving item cites the message the scan read first.
    expect(result.items[0]?.evidence[0]?.message_id).toBe('<m1@example.test>');
  });

  test('a different amount is a different claim', () => {
    const result = admitAll([
      { candidate: candidate(), context },
      { candidate: candidate({ amount_minor: 4200 }), context },
    ]);
    expect(result.items).toHaveLength(2);
    expect(result.drops.duplicate).toBe(0);
  });

  test('a company has one subscription, and it is the price in force', () => {
    // Two receipts and a price-rise notice state the same subscription three
    // times at two prices. Listing all three would add them up and tell the
    // studio it pays more than it pays. The scan reads newest first.
    const subscription = (amount: number) =>
      candidate({ kind: 'subscription', direction: 'you_pay', amount_minor: amount });
    const result = admitAll([
      { candidate: subscription(14800), context },
      { candidate: subscription(17900), context },
      { candidate: subscription(14800), context },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.amount_minor).toBe(14800);
    expect(result.drops.duplicate).toBe(2);
  });

  test('two companies each keep their own subscription', () => {
    const other = { ...context, companyId: 'co_01J0000000000000000000000D' };
    const result = admitAll([
      { candidate: candidate({ kind: 'subscription', direction: 'you_pay' }), context },
      { candidate: candidate({ kind: 'subscription', direction: 'you_pay' }), context: other },
    ]);
    expect(result.items).toHaveLength(2);
  });

  test('the key names the company, the kind, the direction, the amount and the day', () => {
    const one = admit(candidate({ due_at: '2026-10-12T00:00:00.000Z' }), context);
    const two = admit(candidate({ due_at: '2026-10-12T18:30:00.000Z' }), context);
    expect(one.admitted && two.admitted && dedupeKey(one.item) === dedupeKey(two.item)).toBe(true);
  });

  test('counts every refusal so a thin map can be explained', () => {
    const result = admitAll([
      { candidate: candidate(), context },
      { candidate: candidate({ currency: null }), context },
      { candidate: candidate({ evidence: [{ quote: 'not there', start: 0, end: 9 }] }), context },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.drops.amount_without_currency).toBe(1);
    expect(result.drops.evidence_span).toBe(1);
  });
});

describe('the totals', () => {
  const now = new Date('2026-09-18T09:00:00.000Z');
  const item = (over: Partial<LedgerItem>): LedgerItem => ({
    id: 'li_01J0000000000000000000000A',
    space_id: context.spaceId,
    principal_id: context.principalId,
    company_id: context.companyId,
    kind: 'refund_owed',
    direction: 'owed_to_you',
    amount_minor: 1000,
    currency: 'GBP',
    due_at: null,
    status: 'found',
    confidence: 'high',
    evidence: [{ message_id: '<m1@example.test>', quote: QUOTE, start: START, end: START + 1 }],
    suggested_playbook: null,
    job_id: null,
    summary: 'x',
    ...over,
  });

  test('adds what is owed and what is paid, in whole minor units', () => {
    const totals = computeTotals(
      [
        item({ amount_minor: 12999 }),
        item({ kind: 'subscription', direction: 'you_pay', amount_minor: 4800 }),
      ],
      { now },
    );
    expect(totals.owed_to_you_minor).toBe(12999);
    expect(totals.monthly_spend_minor).toBe(4800);
  });

  test('monthly spend counts subscriptions, not an annual renewal or a one-off', () => {
    // An annual licence and a balance due on delivery are both money going out,
    // and neither is a monthly figure. Adding either to one would overstate it.
    const totals = computeTotals(
      [
        item({ kind: 'subscription', direction: 'you_pay', amount_minor: 4800 }),
        item({ kind: 'renewal', direction: 'you_pay', amount_minor: 42000 }),
        item({ kind: 'price_rise', direction: 'you_pay', amount_minor: 9900 }),
      ],
      { now },
    );
    expect(totals.monthly_spend_minor).toBe(4800);
  });

  test('leaves another currency out of the money totals rather than converting it', () => {
    const totals = computeTotals([item({ currency: 'EUR', amount_minor: 40000 })], { now });
    expect(totals.owed_to_you_minor).toBe(0);
  });

  test('a date with no time is a whole day in the person’s own time zone', () => {
    // A promise "by 25 September" has not lapsed while it is still the 25th
    // where the person lives, and a renewal due today is still due soon.
    const promise = item({
      kind: 'promise',
      direction: 'info',
      amount_minor: null,
      currency: null,
    });
    const onThe25th = { due_at: '2026-09-25T00:00:00.000Z', due_date_only: true };
    const at = (iso: string, timeZone: string) => ({ now: new Date(iso), timeZone });

    // 15:30 on the 25th in Kolkata: in force, and the renewal is today.
    const kolkata = computeTotals(
      [{ ...promise, ...onThe25th }, item({ kind: 'renewal', direction: 'you_pay', ...onThe25th })],
      at('2026-09-25T10:00:00.000Z', 'Asia/Kolkata'),
    );
    expect(kolkata.promises_in_force).toBe(1);
    expect(kolkata.promises_lapsed).toBe(0);
    expect(kolkata.renewals_next_30d).toBe(1);

    // 22:00 on the 25th in New York, which is already the 26th in UTC.
    const newYork = computeTotals(
      [{ ...promise, ...onThe25th }],
      at('2026-09-26T02:00:00.000Z', 'America/New_York'),
    );
    expect(newYork.promises_in_force).toBe(1);

    // The 26th where the person is: the 25th has gone.
    const after = computeTotals(
      [{ ...promise, ...onThe25th }],
      at('2026-09-26T10:00:00.000Z', 'Europe/London'),
    );
    expect(after.promises_lapsed).toBe(1);

    // A stated time is an instant, and lapses at that instant, midnight included.
    const instant = computeTotals(
      [
        { ...promise, due_at: '2026-09-25T09:00:00.000Z' },
        { ...promise, due_at: '2026-09-25T00:00:00.000Z', due_date_only: false },
      ],
      at('2026-09-25T10:00:00.000Z', 'Asia/Kolkata'),
    );
    expect(instant.promises_lapsed).toBe(2);
  });

  test('counts a renewal only when it falls inside the next thirty days', () => {
    const totals = computeTotals(
      [
        item({ kind: 'renewal', direction: 'you_pay', due_at: '2026-10-08T00:00:00.000Z' }),
        item({ kind: 'renewal', direction: 'you_pay', due_at: '2027-01-08T00:00:00.000Z' }),
      ],
      { now },
    );
    expect(totals.renewals_next_30d).toBe(1);
  });

  test('a promise being chased is still a promise, until it is settled', () => {
    // The screen lane found this one against their own implementation: counting
    // only `found` promises made the total tick down the moment somebody
    // pressed "Handle it", which tells a person the problem went away at the
    // exact moment work started on it. A number must not say that.
    const lapsed = (status: LedgerItem['status']) =>
      computeTotals(
        [
          item({
            kind: 'promise',
            direction: 'info',
            amount_minor: null,
            currency: null,
            due_at: '2026-08-01T00:00:00.000Z',
            status,
          }),
        ],
        { now },
      );
    expect(lapsed('found').promises_lapsed).toBe(1);
    // Picked up, and still counted.
    expect(lapsed('handling').promises_lapsed).toBe(1);
    expect(lapsed('waiting').promises_lapsed).toBe(1);
    // Only an ending takes it off the count.
    expect(lapsed('settled').promises_lapsed).toBe(0);
    expect(lapsed('dropped').promises_lapsed).toBe(0);
  });

  test('counts promises in force apart from promises that have run out', () => {
    const totals = computeTotals(
      [
        item({
          kind: 'promise',
          direction: 'info',
          amount_minor: null,
          currency: null,
          due_at: '2026-10-01T00:00:00.000Z',
        }),
        item({
          kind: 'promise',
          direction: 'info',
          amount_minor: null,
          currency: null,
          due_at: '2026-08-01T00:00:00.000Z',
        }),
        item({ kind: 'promise', direction: 'info', amount_minor: null, currency: null }),
      ],
      { now },
    );
    expect([totals.promises_in_force, totals.promises_lapsed]).toEqual([2, 1]);
  });

  test('a settled or dropped item is out of every total', () => {
    const totals = computeTotals(
      [item({ status: 'settled' }), item({ status: 'dropped', amount_minor: 5000 })],
      { now },
    );
    expect(totals.owed_to_you_minor).toBe(0);
  });

  test('counts each company holding data once, however many items say so', () => {
    const totals = computeTotals(
      [
        item({ kind: 'data_held', direction: 'info', amount_minor: null, currency: null }),
        item({ kind: 'data_held', direction: 'info', amount_minor: null, currency: null }),
      ],
      { now },
    );
    expect(totals.data_holders).toBe(1);
  });
});
