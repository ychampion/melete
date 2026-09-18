/**
 * The gates, on their own. These are the promises the page makes about what it
 * will show, so they are tested as rules rather than through the handler.
 */
import { describe, expect, test } from 'bun:test';
import type { DraftCaseFile } from '../src/schema.ts';
import { canonical, locate, MIN_QUOTE } from '../src/text.ts';
import { gate, normaliseUrl, parseDraft, retrievedIndex } from '../src/validate.ts';

const PASTED = `From: Customer Care <care@northwind-electricals.example>

We can confirm that we received your returned item on 8 August and that it was
faulty on arrival. We have approved a full refund of £249.99 to your original
payment method.

Please allow 5 to 10 working days for the refund to appear.`;

const draft = (over: Partial<DraftCaseFile> = {}): DraftCaseFile => ({
  company: 'Northwind Electricals',
  issue: 'A refund they approved has not arrived.',
  entitlement: {
    summary: 'They owe you the refund they approved.',
    amount_minor: 24999,
    currency: 'gbp',
    basis: [],
  },
  evidence: [],
  odds: { level: 'high', why: 'They approved it in writing.', expected_days: 14 },
  message: { subject: 'Refund still outstanding', body: 'Hello,\n\nPlease refund.\n\nThank you,' },
  ladder: [{ day_offset: 0, step: 'Send it.' }],
  melete_next: 'Melete would send this and follow it up.',
  ...over,
});

describe('canonical text', () => {
  test('folds wrapping, non-breaking spaces and typographic characters', () => {
    expect(canonical('We have  approved\na full\r\nrefund')).toBe('We have approved a full refund');
    expect(canonical('“paid” — soon…')).toBe('"paid" - soon...');
  });

  test('a quote that spans a line break still matches the paste', () => {
    const found = locate(canonical(PASTED), 'We have approved a full refund of £249.99');
    expect(found?.quote).toBe('We have approved a full refund of £249.99');
  });

  test('a quote shorter than the floor proves nothing and is refused', () => {
    expect('8 August'.length).toBeLessThan(MIN_QUOTE);
    expect(locate(canonical(PASTED), '8 August')).toBeNull();
  });
});

describe('shape', () => {
  test('a complete draft is accepted', () => {
    expect(parseDraft(draft())).not.toBeNull();
  });

  test('anything missing, mistyped or off the enum is refused', () => {
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft('{}')).toBeNull();
    expect(parseDraft({ ...draft(), company: '' })).toBeNull();
    expect(parseDraft({ ...draft(), ladder: [] })).toBeNull();
    expect(
      parseDraft({ ...draft(), odds: { level: 'certain', why: 'x', expected_days: 1 } }),
    ).toBeNull();
    expect(
      parseDraft({ ...draft(), entitlement: { ...draft().entitlement, amount_minor: '249.99' } }),
    ).toBeNull();
  });
});

describe('the quote gate', () => {
  test('keeps a quote the paste contains, in the paste’s own characters', () => {
    const { file, counts } = gate(
      draft({
        evidence: [
          { quote: 'We have approved a full refund of £249.99', why: 'They approved it.' },
        ],
      }),
      PASTED,
      [],
    );
    expect(counts.quotesDropped).toBe(0);
    expect(file.evidence).toHaveLength(1);
    expect(PASTED.includes('approved a full refund of £249.99')).toBe(true);
    expect(file.noEvidenceNote).toBeNull();
  });

  test('drops a quote the paste does not contain', () => {
    const { file, counts } = gate(
      draft({
        evidence: [
          { quote: 'We have approved a full refund of £249.99', why: 'Approved.' },
          { quote: 'We will pay you within 48 hours, guaranteed.', why: 'Invented.' },
        ],
      }),
      PASTED,
      [],
    );
    expect(counts.quotesDropped).toBe(1);
    expect(file.evidence.map((entry) => entry.quote)).toEqual([
      'We have approved a full refund of £249.99',
    ]);
  });

  test('a near miss is still a miss: one changed word drops the quote', () => {
    const { counts } = gate(
      draft({ evidence: [{ quote: 'We have approved a partial refund of £249.99', why: 'x' }] }),
      PASTED,
      [],
    );
    expect(counts.quotesDropped).toBe(1);
  });

  test('with nothing left the case file says so and the odds come down', () => {
    const { file } = gate(
      draft({
        evidence: [{ quote: 'Your refund was sent on 1 September 2026.', why: 'Invented.' }],
      }),
      PASTED,
      [],
    );
    expect(file.evidence).toHaveLength(0);
    expect(file.noEvidenceNote).toContain('no sentence to quote');
    expect(file.odds.level).toBe('medium'); // was high
  });

  test('the same sentence quoted twice is shown once', () => {
    const quote = 'We have approved a full refund of £249.99';
    const { file } = gate(
      draft({
        evidence: [
          { quote, why: 'a' },
          { quote, why: 'b' },
        ],
      }),
      PASTED,
      [],
    );
    expect(file.evidence).toHaveLength(1);
  });
});

describe('the link gate', () => {
  const sources = [
    { url: 'https://www.northwind-electricals.example/help/returns/', title: 'Returns' },
  ];

  test('two spellings of one page are one page', () => {
    expect(normaliseUrl('https://www.Example.com/a/b/')).toBe('example.com/a/b');
    expect(normaliseUrl('https://example.com/a/b?utm=1#top')).toBe('example.com/a/b');
    expect(normaliseUrl('not a url')).toBeNull();
    expect(normaliseUrl('javascript:alert(1)')).toBeNull();
  });

  test('keeps a link the search returned, shown as the search returned it', () => {
    const { file, counts } = gate(
      draft({
        entitlement: {
          ...draft().entitlement,
          basis: [
            {
              claim: 'Their returns policy covers this.',
              source_kind: 'url',
              url: 'https://northwind-electricals.example/help/returns?ref=x',
              title: null,
              quote: null,
            },
          ],
        },
      }),
      PASTED,
      sources,
    );
    expect(counts.urlsDropped).toBe(0);
    expect(file.entitlement.basis[0]?.source).toEqual({
      kind: 'url',
      url: 'https://www.northwind-electricals.example/help/returns/',
      title: 'Returns',
    });
  });

  test('drops a link the search never returned', () => {
    const { file, counts } = gate(
      draft({
        entitlement: {
          ...draft().entitlement,
          basis: [
            {
              claim: 'A regulator says so.',
              source_kind: 'url',
              url: 'https://www.gov.example/consumer-rights',
              title: 'Consumer rights',
              quote: null,
            },
          ],
        },
      }),
      PASTED,
      sources,
    );
    expect(counts.urlsDropped).toBe(1);
    expect(file.entitlement.basis).toHaveLength(0);
  });

  test('a basis quote is held to the same rule as evidence', () => {
    const { file, counts } = gate(
      draft({
        entitlement: {
          ...draft().entitlement,
          basis: [
            {
              claim: 'Real.',
              source_kind: 'quote',
              quote: 'We have approved a full refund',
              url: null,
              title: null,
            },
            {
              claim: 'Invented.',
              source_kind: 'quote',
              quote: 'We promise same-day payment.',
              url: null,
              title: null,
            },
          ],
        },
      }),
      PASTED,
      [],
    );
    expect(file.entitlement.basis).toHaveLength(1);
    expect(counts.basisDropped).toBe(1);
  });

  test('duplicate sources collapse to one entry', () => {
    const index = retrievedIndex([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://www.example.com/a/', title: 'A again' },
    ]);
    expect(index.size).toBe(1);
  });
});

describe('the rest of the case file', () => {
  test('the ladder is trimmed to five and put in order, and currency is normalised', () => {
    const { file } = gate(
      draft({
        ladder: [
          { day_offset: 30, step: 'f' },
          { day_offset: 0, step: 'a' },
          { day_offset: 7, step: 'b' },
          { day_offset: 14, step: 'c' },
          { day_offset: 21, step: 'd' },
          { day_offset: 60, step: 'e' },
        ],
      }),
      PASTED,
      [],
    );
    expect(file.ladder).toHaveLength(5);
    expect(file.ladder.map((step) => step.dayOffset)).toEqual([0, 7, 14, 21, 30]);
    expect(file.entitlement.currency).toBe('GBP');
  });

  test('a currency with no amount behind it is dropped', () => {
    const { file } = gate(
      draft({ entitlement: { ...draft().entitlement, amount_minor: null } }),
      PASTED,
      [],
    );
    expect(file.entitlement.currency).toBeNull();
  });
});
