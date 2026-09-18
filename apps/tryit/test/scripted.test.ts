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

/**
 * The commonest thing a visitor will paste is not a clean notice: it is a
 * reply, with their own earlier message quoted underneath it. Reading the
 * whole blob as one voice made the page say the opposite of the truth — a
 * flat refusal became "approved £89.00 and it has not arrived", and the
 * message it drafted quoted the visitor's own words back at the company as
 * the company's. Everything below is that thread.
 */
const REFUSAL = `From: support@brightfibre.example
Subject: Re: my broadband bill

Hello,

We have reviewed your account and we are not able to offer a refund on this
occasion. The charge was applied correctly under your current contract.

Kind regards,
Brightfibre Support

On 2 September you wrote:
> You told me on the phone that you would refund the £89.00 and that the
> engineer visit would cost me nothing. Please can you sort this out.`;

describe('a reply with the visitor’s own message quoted underneath', () => {
  test('a refusal is read as a refusal, not as a promise', () => {
    expect(kindOf(canonical(REFUSAL))).toBe('refused');
  });

  test('the case file says they turned it down, and does not invent an approval', () => {
    const draft = draftFrom(run(REFUSAL));
    expect(draft.issue).toContain('turned down');
    expect(draft.issue).not.toContain('approved');
    expect(draft.entitlement.summary).not.toContain('owes you');
  });

  test('no figure is claimed as owed once a company has refused', () => {
    const draft = draftFrom(run(REFUSAL));
    expect(draft.entitlement.amount_minor).toBeNull();
  });

  test('nothing from the visitor’s own quoted reply is quoted back at them', () => {
    const draft = draftFrom(run(REFUSAL));
    const shown = [
      ...draft.evidence.map((entry) => entry.quote),
      ...draft.entitlement.basis.map((entry) => entry.quote ?? ''),
      draft.message.body,
    ].join('\n');
    expect(shown).not.toContain('You told me on the phone');
    expect(shown).not.toContain('On 2 September you wrote');
    expect(shown).not.toContain('>');
  });

  test('the amount is read from the company’s words, not the quoted reply', () => {
    // £89.00 appears only in the visitor's quoted message, so it is not a
    // figure this company ever put in writing.
    const draft = draftFrom(run(REFUSAL));
    expect(JSON.stringify(draft.entitlement)).not.toContain('8900');
  });

  test('what it asks for next is a question, not a demand for money', () => {
    const draft = draftFrom(run(REFUSAL));
    expect(draft.message.body.toLowerCase()).toContain('in writing');
    expect(draft.message.body).not.toContain('Please pay');
  });

  test('a sign-off is not evidence of anything', () => {
    const draft = draftFrom(run(REFUSAL));
    for (const entry of draft.evidence) expect(entry.quote).not.toContain('Kind regards');
  });
});

describe('a description typed by the visitor, not an email', () => {
  const TYPED = `I bought a laptop from Gadgetline in July and it broke after three weeks.
I sent it back on 8 August and they said they would refund me 549 dollars but
nothing has arrived and they stopped replying to me.`;

  test('the visitor’s own sentences are never labelled as the company’s', () => {
    const draft = draftFrom(run(TYPED));
    // There is no company text here, so there is nothing the company "said in
    // writing" and no basis to claim one.
    expect(draft.entitlement.basis).toEqual([]);
  });

  test('the message does not quote the visitor to themselves', () => {
    const draft = draftFrom(run(TYPED));
    expect(draft.message.body).not.toContain('Your own message says');
  });

  test('it still reads the situation and still has something to send', () => {
    const draft = draftFrom(run(TYPED));
    expect(draft.evidence.length).toBeGreaterThan(0);
    expect(draft.message.body.length).toBeGreaterThan(80);
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
    expect(draft.entitlement.summary).toContain('voucher');
    expect(draft.message.subject).toContain('not a voucher');
  });
});

/**
 * With no key this provider matches on words alone, so whatever it says is
 * said about every paste of that shape. That is fine for "worth asking"; it is
 * not fine for telling someone what they are entitled to, which it has no
 * evidence for and no business deciding.
 */
describe('what it states, and what it only asks', () => {
  const summaries = () =>
    SAMPLES.map((entry) => draftFrom(run(entry.text)).entitlement.summary).join('\n');

  test('it does not tell anyone what they may do', () => {
    const said = summaries();
    expect(said).not.toContain('you do not have to');
    expect(said).not.toContain('You can hold your current price or leave');
    expect(said).not.toContain('is not the same thing as compensation');
  });

  test('a price rise is put as a question for the company', () => {
    const draft = draftFrom(run(sample('price-rise')));
    expect(draft.entitlement.summary.toLowerCase()).toContain('worth asking');
    // The figure is still there: it is the one thing the letter itself proves.
    expect(draft.entitlement.amount_minor).toBe(7200);
  });

  test('a delay is put as a question too', () => {
    const draft = draftFrom(run(sample('flight')));
    expect(draft.entitlement.summary.toLowerCase()).toContain('worth asking');
    expect(draft.entitlement.amount_minor).toBeNull();
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
