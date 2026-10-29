import { describe, expect, test } from 'bun:test';
import {
  gmailQuery,
  graphSearches,
  imapQuery,
  MAX_ALTERNATIVES,
  MAX_LEFT_OUT,
  mailQueryText,
  parseMailQuery,
  readMailQuery,
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

  test('a ninth alternative is named back, not dropped', () => {
    const reading = readMailQuery(
      'rent OR lease OR landlord OR apartment OR deposit OR utilities OR electric OR water OR gas',
    );
    expect(reading.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(reading.leftOut).toEqual([['gas']]);
    expect(reading.more).toBe(false);
  });

  test('pairings past the bound are named back, each as a query to run next', () => {
    const reading = readMailQuery('(invoice OR receipt OR bill) (march OR april OR "may 1")');
    expect(reading.alternatives).toEqual([
      ['invoice', 'march'],
      ['invoice', 'april'],
      ['invoice', 'may 1'],
      ['receipt', 'march'],
      ['receipt', 'april'],
      ['receipt', 'may 1'],
      ['bill', 'march'],
      ['bill', 'april'],
    ]);
    expect(reading.leftOut).toEqual([['bill', 'may 1']]);
    expect(reading.more).toBe(false);
    expect(reading.leftOut.map(mailQueryText)).toEqual(['bill "may 1"']);

    const sixteen = readMailQuery('(a OR b) (c OR d) (e OR f) (g OR h)');
    expect(sixteen.leftOut).toHaveLength(8);
    expect(sixteen.leftOut.every((terms) => terms[0] === 'b')).toBe(true);
    expect(sixteen.more).toBe(false);

    const many = readMailQuery(
      Array.from({ length: 6 }, (_, index) => `(a${index} OR b${index})`).join(' '),
    );
    expect(many.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(many.leftOut).toHaveLength(MAX_LEFT_OUT);
    expect(many.more).toBe(true);
  });

  test('what a search runs plus what it names back is the whole query, when nothing more is cut', () => {
    // The full reading with no bound, written plainly, for queries of words, OR and parentheses.
    const full = (query: string): string[][] => {
      const list = query.match(/\(|\)|[^\s()]+/g) ?? [];
      let at = 0;
      const expression = (): string[][] => {
        const out: string[][] = [];
        for (;;) {
          let conjunction: string[][] = [[]];
          while (at < list.length && list[at] !== 'OR' && list[at] !== ')') {
            const token = list[at++] as string;
            let factor: string[][];
            if (token === '(') {
              factor = expression();
              at++;
            } else factor = [[token]];
            conjunction = conjunction.flatMap((a) => factor.map((b) => [...a, ...b]));
          }
          out.push(...conjunction);
          if (list[at] !== 'OR') return out;
          at++;
        }
      };
      const seen = new Set<string>();
      return expression()
        .map((terms) => [...new Set(terms)])
        .filter((terms) => {
          const key = [...terms].sort().join(' ');
          if (!terms.length || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    };
    let seed = 0xb0b;
    const next = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    const words = ['ab', 'cd', 'ef', 'gh', 'ij'];
    const group = (depth: number): string => {
      const parts = Array.from({ length: 1 + next(3) }, () =>
        depth < 2 && next(3) === 0
          ? `( ${group(depth + 1)} )`
          : (words[next(words.length)] as string),
      );
      return parts.map((part, index) => (index && next(2) ? `OR ${part}` : part)).join(' ');
    };
    let checked = 0;
    for (let round = 0; round < 3000; round++) {
      const query = Array.from({ length: 1 + next(4) }, () => `( ${group(0)} )`).join(
        next(2) ? ' ' : ' OR ',
      );
      const reading = readMailQuery(query);
      const expected = full(query);
      const named = [...reading.alternatives, ...reading.leftOut];
      if (reading.more) {
        for (const terms of named) expect(expected).toContainEqual(terms);
        // Duplicates can make a reading look longer than it is; the rest is still reported as more.
        expect(expected.length).toBeGreaterThanOrEqual(named.length);
      } else {
        expect([query, named]).toEqual([query, expected]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(2000);
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
