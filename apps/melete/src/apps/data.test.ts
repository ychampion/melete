import { describe, expect, test } from 'bun:test';
import { DataUnavailable, describeChange, interpretData } from './data.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('how a data file reaches an app', () => {
  test('a JSON file is given parsed and a text file as a string', () => {
    expect(interpretData('data/deals.json', bytes('[{"a":1}]'))).toEqual({
      format: 'json',
      value: [{ a: 1 }],
    });
    expect(interpretData('data/notes.md', bytes('# Notes'))).toEqual({
      format: 'text',
      value: '# Notes',
    });
  });

  test('a file over 2 MiB, not text, not UTF-8 or not valid JSON is refused in words', () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1).fill(0x20);
    expect(() => interpretData('data/big.json', big)).toThrow(DataUnavailable);
    expect(() => interpretData('data/chart.png', bytes('x'))).toThrow(/not JSON or text/);
    expect(() => interpretData('data/a.txt', new Uint8Array([0xff, 0xfe]))).toThrow(/UTF-8/);
    expect(() => interpretData('data/a.json', bytes('{'))).toThrow(/not valid JSON/);
  });
});

describe('what a new data version changes, for the person reviewing it', () => {
  test('top-level keys added, removed and changed, with the size before and after', () => {
    const change = describeChange(
      { format: 'json', value: { open: 3, won: 1, stale: true } },
      { format: 'json', value: { open: 4, won: 1, lost: 2 } },
      { before: 30, after: 27 },
    );
    expect(change.changes).toEqual({
      added: ['lost'],
      removed: ['stale'],
      changed: ['open'],
      truncated: false,
    });
    expect(change.summary).toBe('Keys: 1 added, 1 changed, 1 removed, 30 → 27 bytes');
  });

  test('a list says how many items it had and has; a first version says so', () => {
    expect(
      describeChange(
        { format: 'json', value: [1, 2] },
        { format: 'json', value: [1, 2, 3] },
        { before: 5, after: 7 },
      ).summary,
    ).toBe('2 → 3 items, 5 → 7 bytes');
    expect(
      describeChange(null, { format: 'text', value: 'x' }, { before: null, after: 1 }),
    ).toEqual({ changes: null, summary: 'First version, 1 bytes' });
  });

  test('long key lists are cut and say so', () => {
    const after = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
    const change = describeChange(
      { format: 'json', value: {} },
      { format: 'json', value: after },
      {
        before: 2,
        after: 300,
      },
    );
    expect(change.changes?.added).toHaveLength(20);
    expect(change.changes?.truncated).toBe(true);
    expect(change.summary).toStartWith('Keys: 30 added');
  });
});
