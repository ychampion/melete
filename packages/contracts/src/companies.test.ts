import { describe, expect, test } from 'bun:test';
import { ID_PREFIXES } from './common.ts';
import {
  company,
  companyMap,
  companyMapTotals,
  evidenceHolds,
  LAUNCH_PLAYBOOKS,
  ledgerEvidence,
  ledgerItem,
  playbookId,
} from './companies.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const id = (prefix: string) => `${prefix}_${SUFFIX}`;
const NOW = '2026-09-18T00:00:00.000Z';

const MESSAGE = 'Hello. We will refund £42.00 within 14 days. We will refund £42.00 again.';
const QUOTE = 'We will refund £42.00';
const START = MESSAGE.indexOf(QUOTE);
const END = START + QUOTE.length;

const evidence = { message_id: '<abc@acme.com>', quote: QUOTE, start: START, end: END };

const item = {
  id: id(ID_PREFIXES.ledger_item),
  space_id: id(ID_PREFIXES.space),
  principal_id: id(ID_PREFIXES.owner),
  company_id: id(ID_PREFIXES.company),
  kind: 'refund_owed',
  direction: 'owed_to_you',
  amount_minor: 4200,
  currency: 'GBP',
  due_at: NOW,
  status: 'found',
  confidence: 'high',
  evidence: [evidence],
  suggested_playbook: 'refund-owed',
  job_id: null,
  summary: 'Refund for the cancelled order',
};

describe('the ledger item schema', () => {
  test('a complete item parses', () => {
    const parsed = ledgerItem.safeParse(item);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.amount_minor).toBe(4200);
  });

  test('an item may leave the optional figures out and gets nulls', () => {
    const parsed = ledgerItem.safeParse({
      id: item.id,
      space_id: item.space_id,
      principal_id: item.principal_id,
      company_id: item.company_id,
      kind: 'data_held',
      direction: 'info',
      status: 'found',
      confidence: 'low',
      evidence: item.evidence,
      summary: 'They still hold your address',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      amount_minor: null,
      currency: null,
      due_at: null,
      suggested_playbook: null,
      job_id: null,
    });
  });

  test('refuses a kind the contract does not name', () => {
    expect(ledgerItem.safeParse({ ...item, kind: 'parking_fine' }).success).toBe(false);
  });

  test('refuses evidence with an empty quote, which could never be checked', () => {
    expect(ledgerItem.safeParse({ ...item, evidence: [{ ...evidence, quote: '' }] }).success).toBe(
      false,
    );
    expect(ledgerEvidence.safeParse({ ...evidence, quote: '' }).success).toBe(false);
  });

  test('refuses an item with no evidence at all', () => {
    expect(ledgerItem.safeParse({ ...item, evidence: [] }).success).toBe(false);
  });

  test('refuses a negative amount: direction carries the sign, not the figure', () => {
    expect(ledgerItem.safeParse({ ...item, amount_minor: -4200 }).success).toBe(false);
  });

  test('refuses a currency that is not an ISO-4217 code', () => {
    expect(ledgerItem.safeParse({ ...item, currency: 'pounds' }).success).toBe(false);
  });

  test('accepts a span the message does not support: the gate is evidenceHolds, not the parser', () => {
    const parsed = ledgerItem.safeParse({
      ...item,
      evidence: [{ ...evidence, start: 900, end: 921 }],
    });
    expect(parsed.success).toBe(true);
    expect(evidenceHolds(MESSAGE, { quote: QUOTE, start: 900, end: 921 })).toBe(false);
  });
});

describe('the company and the map', () => {
  const acme = {
    id: id(ID_PREFIXES.company),
    space_id: id(ID_PREFIXES.space),
    name: 'Acme',
    domain: 'acme.com',
    monthly_spend_minor: 999,
    currency: 'GBP',
    first_seen_at: NOW,
    last_seen_at: NOW,
    message_count: 12,
  };

  test('a company parses', () => {
    expect(company.safeParse(acme).success).toBe(true);
  });

  const totals = {
    owed_to_you_minor: 4200,
    monthly_spend_minor: 999,
    renewals_next_30d: 1,
    price_rises: 0,
    trials_ending: 0,
    data_holders: 1,
    promises_in_force: 2,
    promises_lapsed: 1,
  };

  test('a map carries its companies, its items and its totals', () => {
    const parsed = companyMap.safeParse({
      companies: [acme],
      items: [item],
      totals,
      currency: 'GBP',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.totals.owed_to_you_minor).toBe(4200);
  });

  test('the totals count promises in force apart from promises that lapsed', () => {
    const parsed = companyMapTotals.safeParse(totals);
    expect(parsed.success).toBe(true);
    expect([parsed.data?.promises_in_force, parsed.data?.promises_lapsed]).toEqual([2, 1]);
  });

  test('a map missing the promise counts is not a map', () => {
    const { promises_in_force: _inForce, ...withoutPromises } = totals;
    expect(companyMapTotals.safeParse(withoutPromises).success).toBe(false);
  });

  test('a promise count cannot be negative', () => {
    expect(companyMapTotals.safeParse({ ...totals, promises_lapsed: -1 }).success).toBe(false);
  });

  test('every launch playbook is a valid playbook name', () => {
    for (const name of LAUNCH_PLAYBOOKS) {
      expect(playbookId.safeParse(name).success).toBe(true);
    }
  });
});

describe('evidenceHolds', () => {
  test('holds when the quote sits at exactly the span it claims', () => {
    expect(evidenceHolds(MESSAGE, evidence)).toBe(true);
  });

  test('holds for the second occurrence when that is the span cited', () => {
    const second = MESSAGE.lastIndexOf(QUOTE);
    expect(second).not.toBe(START);
    expect(
      evidenceHolds(MESSAGE, { quote: QUOTE, start: second, end: second + QUOTE.length }),
    ).toBe(true);
  });

  test('fails on a span one character early', () => {
    expect(evidenceHolds(MESSAGE, { ...evidence, start: START - 1, end: END - 1 })).toBe(false);
  });

  test('fails on a span one character late', () => {
    expect(evidenceHolds(MESSAGE, { ...evidence, start: START + 1, end: END + 1 })).toBe(false);
  });

  test('fails on a span one character too long', () => {
    expect(evidenceHolds(MESSAGE, { ...evidence, end: END + 1 })).toBe(false);
  });

  test('fails when the quote is in the message but the span points elsewhere', () => {
    const elsewhere = MESSAGE.lastIndexOf(QUOTE);
    expect(MESSAGE.includes(QUOTE)).toBe(true);
    expect(evidenceHolds(MESSAGE, { quote: QUOTE, start: 0, end: QUOTE.length })).toBe(false);
    expect(evidenceHolds(MESSAGE, { quote: QUOTE, start: START, end: elsewhere })).toBe(false);
  });

  test('fails when the quote is not in the message at all', () => {
    expect(evidenceHolds(MESSAGE, { quote: 'We will refund £84.00', start: START, end: END })).toBe(
      false,
    );
  });

  test('fails on an empty quote, however the span is written', () => {
    expect(evidenceHolds(MESSAGE, { quote: '', start: 0, end: 0 })).toBe(false);
    expect(evidenceHolds(MESSAGE, { quote: '', start: START, end: START })).toBe(false);
  });

  test('fails on a span that runs off the end of the message', () => {
    expect(evidenceHolds(QUOTE, { quote: QUOTE, start: 0, end: QUOTE.length + 1 })).toBe(false);
  });

  test('fails on a negative start, which slice would read from the end', () => {
    expect(
      evidenceHolds(MESSAGE, { quote: QUOTE, start: -QUOTE.length, end: MESSAGE.length }),
    ).toBe(false);
    const tail = MESSAGE.slice(-QUOTE.length);
    expect(evidenceHolds(MESSAGE, { quote: tail, start: -QUOTE.length, end: MESSAGE.length })).toBe(
      false,
    );
  });

  test('fails on an end before its start', () => {
    expect(evidenceHolds(MESSAGE, { quote: QUOTE, start: END, end: START })).toBe(false);
  });

  test('fails on offsets that are not whole numbers', () => {
    expect(evidenceHolds(MESSAGE, { ...evidence, start: START + 0.5 })).toBe(false);
    expect(evidenceHolds(MESSAGE, { ...evidence, end: Number.NaN })).toBe(false);
  });

  test('an empty message admits nothing', () => {
    expect(evidenceHolds('', { quote: QUOTE, start: 0, end: QUOTE.length })).toBe(false);
  });
});
