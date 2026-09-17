/**
 * The provider that runs when no key is configured. It is not a stand-in for
 * the tests alone: with no key it is what a visitor gets, so what it reads out
 * of each of the three samples is checked here.
 */
import { describe, expect, test } from 'bun:test';
import type { ProviderRun } from '../src/provider.ts';
import { SAMPLES } from '../src/samples.ts';
import { draftFrom, kindOf } from '../src/scripted.ts';
import { canonical } from '../src/text.ts';

const run = (pasted: string): ProviderRun => ({
  pasted,
  today: '2026-09-18',
  signal: new AbortController().signal,
});

const sample = (id: string): string => {
  const found = SAMPLES.find((entry) => entry.id === id);
  if (!found) throw new Error(`no sample ${id}`);
  return found.text;
};

describe('which situation it is', () => {
  test('each sample is read as what it is', () => {
    expect(kindOf(canonical(sample('refund')))).toBe('refund');
    expect(kindOf(canonical(sample('price-rise')))).toBe('price_rise');
    expect(kindOf(canonical(sample('flight')))).toBe('delay');
  });

  test('anything else is handled as itself, not forced into a box', () => {
    expect(kindOf('They took my deposit in March and have gone quiet since.')).toBe('general');
  });
});

describe('what it reads out of each sample', () => {
  test('a refund promised names the amount that was promised', () => {
    const draft = draftFrom(run(sample('refund')));
    expect(draft.company).toBe('Northwind Electricals');
    expect(draft.entitlement.amount_minor).toBe(24999);
    expect(draft.entitlement.currency).toBe('GBP');
    expect(draft.issue).toContain('£249.99');
  });

  test('a price rise names the yearly difference, not the new price', () => {
    const draft = draftFrom(run(sample('price-rise')));
    // $22.99 - $16.99 = $6.00 a month.
    expect(draft.entitlement.amount_minor).toBe(7200);
    expect(draft.entitlement.currency).toBe('USD');
    expect(draft.message.body).toContain('current price');
  });

  test('a delay does not mistake the voucher for what is owed', () => {
    const draft = draftFrom(run(sample('flight')));
    expect(draft.entitlement.amount_minor).toBeNull();
    expect(draft.entitlement.summary).toContain('voucher is not');
    expect(draft.message.subject).toContain('not a voucher');
  });
});

describe('the sentences it picks', () => {
  test('a price inside a sentence does not split it in two', () => {
    const draft = draftFrom(run(sample('refund')));
    expect(draft.evidence.some((entry) => entry.quote.includes('£249.99 to your original'))).toBe(
      true,
    );
  });

  test('the envelope is not quoted back at the company that wrote it', () => {
    const draft = draftFrom(run(sample('refund')));
    for (const entry of draft.evidence) expect(entry.quote).not.toContain('care@');
  });

  test('every quote it produces is in the paste', () => {
    for (const entry of SAMPLES) {
      const draft = draftFrom(run(entry.text));
      const folded = canonical(entry.text);
      for (const quote of draft.evidence) expect(folded).toContain(quote.quote);
      for (const basis of draft.entitlement.basis)
        expect(folded).toContain(basis.quote ?? '__missing__');
    }
  });

  test('it never cites a page, because it never opened one', () => {
    for (const entry of SAMPLES) {
      const draft = draftFrom(run(entry.text));
      for (const basis of draft.entitlement.basis) expect(basis.source_kind).toBe('quote');
    }
  });
});
