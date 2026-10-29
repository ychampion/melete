import { describe, expect, test } from 'bun:test';
import {
  gmailQuery,
  graphSearches,
  imapQuery,
  MAX_ALTERNATIVES,
  parseMailQuery,
} from './mail-query.ts';

describe('reading a mail query', () => {
  const cases: [string, string[][]][] = [
    ['', []],
    ['   ', []],
    ['dentist', [['dentist']]],
    ['field trip', [['field', 'trip']]],
    ['"field trip"', [['field trip']]],
    ['"field trip" OR "permission slip"', [['field trip'], ['permission slip']]],
    ['dentist OR appointment OR bill', [['dentist'], ['appointment'], ['bill']]],
    ['bill or reminder', [['bill'], ['reminder']]],
    ['bill | reminder', [['bill'], ['reminder']]],
    ['“field trip” OR “permission slip”', [['field trip'], ['permission slip']]],
    [
      '(trip OR slip) Wednesday',
      [
        ['trip', 'Wednesday'],
        ['slip', 'Wednesday'],
      ],
    ],
    ['bill AND due', [['bill', 'due']]],
    ['bill && due', [['bill', 'due']]],
    // Filters with nothing to search for are set aside; a field name comes off its value.
    ['from:school subject:"field trip"', [['school', 'field trip']]],
    ['is:unread OR dentist', [['dentist']]],
    ['after:2026/10/01 bill', [['bill']]],
    ['label:"Kids stuff" bill', [['bill']]],
    // What NOT or a minus applies to is dropped, not searched for.
    ['bill -spam', [['bill']]],
    ['bill NOT "final notice"', [['bill']]],
    ['bill -(spam OR junk)', [['bill']]],
    // Nothing left to look for lists the newest mail, as an empty query does.
    ['NOT spam', []],
    ['is:unread', []],
    ['OR', []],
    ['( )', []],
    // Untidy syntax is read as far as it goes.
    ['OR bill OR', [['bill']]],
    ['(bill OR due', [['bill'], ['due']]],
    ['bill) due', [['bill', 'due']]],
    ['"unclosed phrase', [['unclosed phrase']]],
    ['bill*', [['bill']]],
    ['bill, due.', [['bill', 'due']]],
    ['Bill bill', [['Bill']]],
    ['bill OR Bill', [['bill']]],
    ['10:30 a@b.example', [['10:30', 'a@b.example']]],
  ];
  for (const [query, expected] of cases)
    test(JSON.stringify(query), () => {
      expect(parseMailQuery(query)).toEqual(expected);
    });

  test('alternatives and terms stay bounded however the query is written', () => {
    const many = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' OR ');
    expect(parseMailQuery(many)).toHaveLength(MAX_ALTERNATIVES);
    const product = Array.from({ length: 12 }, (_, index) => `(a${index} OR b${index})`).join(' ');
    const read = parseMailQuery(product);
    expect(read.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    for (const terms of read) expect(terms.length).toBeLessThanOrEqual(8);
    expect(parseMailQuery(`${'('.repeat(500)}bill${')'.repeat(500)}`).length).toBeLessThanOrEqual(
      1,
    );
  });

  test('random queries never throw and never yield an empty term or alternative', () => {
    let seed = 0x5eed;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const parts = [
      'bill',
      'OR',
      'or',
      'AND',
      'NOT',
      '-',
      '(',
      ')',
      '"',
      'is:',
      'from:',
      'x',
      '*',
      '|',
      ' ',
      '“',
    ];
    for (let round = 0; round < 2000; round++) {
      const query = Array.from({ length: 1 + next(14) }, () => parts[next(parts.length)]).join(
        next(2) ? ' ' : '',
      );
      const read = parseMailQuery(query);
      expect(read.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
      for (const terms of read) {
        expect(terms.length).toBeGreaterThan(0);
        for (const term of terms) expect(term.trim()).not.toBe('');
      }
    }
  });
});

describe('writing a query for each mailbox', () => {
  test('Gmail gets its own OR, quoting only what needs it', () => {
    expect(gmailQuery([])).toBe('');
    expect(gmailQuery([['field trip'], ['permission slip']])).toBe(
      '"field trip" OR "permission slip"',
    );
    expect(gmailQuery([['class', 'Friday'], ['piano']])).toBe('(class Friday) OR piano');
    expect(gmailQuery([['school', 'a@b.example']])).toBe('school a@b.example');
    expect(gmailQuery([['OR'], ['say "hi"']])).toBe('"OR" OR "say hi"');
  });

  test('IMAP gets one SEARCH: OR between alternatives, every term of one required', () => {
    expect(imapQuery([])).toEqual({ all: true });
    expect(imapQuery([['field trip']])).toEqual({ text: 'field trip' });
    expect(imapQuery([['a', 'b', 'c']])).toEqual({
      text: 'a',
      or: [{ text: 'b', or: [{ text: 'c' }] }],
    });
    expect(imapQuery([['field trip'], ['permission slip']])).toEqual({
      or: [{ text: 'field trip' }, { text: 'permission slip' }],
    });
  });

  test('Graph gets one plain search per alternative', () => {
    expect(graphSearches([])).toEqual([]);
    expect(graphSearches([['field trip'], ['bill', 'due']])).toEqual([
      '"field trip"',
      '"bill due"',
    ]);
    expect(graphSearches([['say "hi" \\ now']])).toEqual(['"say hi  now"']);
  });
});
