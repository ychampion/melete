/**
 * The gates, on their own. These are the promises the page makes about what it
 * will show, so they are tested as rules rather than through the handler.
 */
import { describe, expect, test } from 'bun:test';
import type { DraftCaseFile } from '../src/schema.ts';
import { canonical, fold, locate, MIN_QUOTE, SENTINEL } from '../src/text.ts';
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
    const found = locate(fold(PASTED), 'We have approved a full refund of £249.99');
    expect(found?.quote).toBe('We have approved a full refund of £249.99');
  });

  test('a quote shorter than the floor proves nothing and is refused', () => {
    expect('8 August'.length).toBeLessThan(MIN_QUOTE);
    expect(locate(fold(PASTED), '8 August')).toBeNull();
  });
});

/**
 * A right-to-left override reverses everything after it when a browser draws
 * it, so a quote really present in the paste can be made to read as its own
 * opposite on screen. Escaping does not help: the characters are not markup,
 * they are text, and `<q>` is not an isolate. They carry no meaning in an
 * email from a company, so they come out with the other invisibles.
 */
describe('characters that change what a quote says without changing it', () => {
  const RLO = '‮';
  const LRI = '⁦';
  const PDI = '⁩';
  const MARK = '‏';

  test('an override is stripped, so the quote reads as it was written', () => {
    const pasted = `We do not owe you a refund. ${RLO}dnufer a uoy ewo ton od eW`;
    const folded = canonical(pasted);
    for (const control of [RLO, LRI, PDI, MARK]) expect(folded).not.toContain(control);
  });

  test('a quote carrying one still matches the text without it', () => {
    const pasted = `We have approved a full ${MARK}refund of £249.99 today.`;
    expect(locate(fold(pasted), 'We have approved a full refund of £249.99')).not.toBeNull();
  });

  test('every isolate and override is out, not only the one in the probe', () => {
    const all = '‪‫‬‭‮⁦⁧⁨⁩‎‏';
    expect(canonical(`a${all}b`)).toBe('ab');
  });
});

/**
 * Folding every run of whitespace made one paragraph of a whole email, so a
 * "quote" could begin in the company's sentence and end inside the person's
 * own reply two paragraphs below, under a caption promising it was word for
 * word. A blank line and a quoted-reply marker are structural: text on either
 * side of one was never written as a single sentence, and a quote may not
 * cross one. A single newline is not structural — that is an email wrapping a
 * sentence — so those still fold to a space.
 */
describe('breaks a quote may not cross', () => {
  const THREAD = `Hello,

We are not able to offer a refund on this occasion.

Kind regards,
Brightfibre Support

On 2 September you wrote:
> You told me on the phone that you would refund the £89.00
> and that the engineer visit would cost me nothing.`;

  test('a hard-wrapped sentence still reads as one sentence', () => {
    const wrapped = 'We have approved a full refund\nof £249.99 to your account.';
    expect(locate(fold(wrapped), 'We have approved a full refund of £249.99')).not.toBeNull();
  });

  test('a span across a blank line does not match', () => {
    expect(locate(fold(THREAD), 'on this occasion. Kind regards,')).toBeNull();
  });

  test('a span from the company’s words into the person’s reply does not match', () => {
    expect(
      locate(
        fold(THREAD),
        'Brightfibre Support On 2 September you wrote: > You told me on the phone',
      ),
    ).toBeNull();
  });

  test('each side of a break is still quotable on its own', () => {
    const folded = fold(THREAD);
    expect(locate(folded, 'We are not able to offer a refund on this occasion.')).not.toBeNull();
    expect(locate(folded, 'You told me on the phone that you would refund')).not.toBeNull();
  });

  test('a line someone chose to end is a break; a wrapped one is not', () => {
    const table = 'Refund due:\nno\nReplacement due:\nyes, within 30 days';
    expect(locate(fold(table), 'no Replacement due: yes')).toBeNull();
    const asked = 'Was a refund approved?\nNo.\nWill we pay you £249.99?';
    expect(locate(fold(asked), 'No. Will we pay you £249.99?')).toBeNull();
    // ...while a sentence wrapped mid-way still reads as one sentence.
    const wrapped = 'We received your returned item on 8 August and it was\nfaulty on arrival.';
    expect(locate(fold(wrapped), 'on 8 August and it was faulty on arrival')).not.toBeNull();
  });

  test('a line ending in no punctuation at all is still joined to the next', () => {
    // Known and accepted: the only signals available are a blank line, a reply
    // marker and a sentence ending, and a bare two-column row carries none of
    // them. Ruling on indentation instead would break every wrapped email,
    // which is the far commoner case. Recorded here so it is a decision.
    const bare = 'Refund due: no\nReplacement due: yes';
    expect(locate(fold(bare), 'no Replacement due: yes')).not.toBeNull();
  });

  test('the mark for a break can never be smuggled in by the model', () => {
    const folded = fold(THREAD);
    expect(folded.text).toContain(SENTINEL);
    expect(locate(folded, `on this occasion.${SENTINEL}Kind regards,`)).toBeNull();
  });
});

/**
 * The card says the quotes are word for word from what was pasted, so they
 * have to be exactly that and not a tidied copy. A model retypes typographic
 * characters as the plain ones, which is why the two sides are compared in a
 * fold — but what is shown is cut from the paste at the offsets the fold
 * recorded, so the person reads their own punctuation back.
 */
describe('the quote that is shown is the paste’s own text', () => {
  const said = (quote: string) => draft({ evidence: [{ quote, why: 'w' }] });

  const pairs: Array<[string, string, string]> = [
    [
      'curly quotes',
      'Our agent said “we will refund you in full” yesterday.',
      'Our agent said "we will refund you in full" yesterday.',
    ],
    [
      'em dashes',
      'Refund — in full — within five working days.',
      'Refund - in full - within five working days.',
    ],
    [
      'an ellipsis',
      'We will pay you… eventually, we promise.',
      'We will pay you... eventually, we promise.',
    ],
    [
      'primes',
      'The clearance is 5′ 10″ and a refund is due.',
      `The clearance is 5' 10" and a refund is due.`,
    ],
  ];

  for (const [what, pasted, typed] of pairs) {
    test(`${what}: matched as the model typed it, shown as it was pasted`, () => {
      const { file, counts } = gate(said(typed), pasted, []);
      expect(counts.quotesDropped).toBe(0);
      const shown = file.evidence[0]?.quote ?? '';
      expect(pasted).toContain(shown);
      expect(shown).not.toBe(typed);
    });
  }

  test('a wrapped sentence comes back with its own line break, still literal', () => {
    const pasted = 'We have approved a full refund of £249.99\nto your original payment method.';
    const { file } = gate(
      said('We have approved a full refund of £249.99 to your original payment method.'),
      pasted,
      [],
    );
    const shown = file.evidence[0]?.quote ?? '';
    expect(pasted).toContain(shown);
    expect(shown).toContain('\n');
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
    // The shown text is cut from the paste, so the paste contains it exactly.
    expect(PASTED).toContain(file.evidence[0]?.quote ?? '__nothing__');
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
