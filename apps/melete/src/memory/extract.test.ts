import { describe, expect, test } from 'bun:test';
import { MemoryError } from './db.ts';
import { findQuote, readExtractionReply } from './extract.ts';

const span = {
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  start: 0,
  end: 5,
  quote: 'hello',
};
const add = {
  op: 'add',
  expected_revision: null,
  domain_key: 'pref.coffee.order',
  content: 'Oat flat white',
  kind: 'preference',
  factual_status: 'attributed',
  valid_from: '2026-09-29T10:00:00Z',
  valid_until: null,
  sources: [span],
};
const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof MemoryError ? error.code : String(error);
  }
  return null;
};

describe('reading a model’s extraction answer', () => {
  test('plain JSON is read as it always was', () => {
    expect(readExtractionReply(JSON.stringify({ proposals: [add] })).proposals).toHaveLength(1);
  });

  test('a code fence, a reasoning block and prose around the JSON are ignored', () => {
    const reply = `<think>They like coffee.</think>\nHere you go:\n\`\`\`json\n${JSON.stringify({ proposals: [add] })}\n\`\`\``;
    const read = readExtractionReply(reply);
    expect(read.proposals).toHaveLength(1);
    expect(read.dropped).toEqual([]);
  });

  test('a bare list, a date for a timestamp, a missing end and extra fields are normalized', () => {
    const { proposals, dropped } = readExtractionReply(
      JSON.stringify([
        {
          ...add,
          expected_revision: undefined,
          valid_from: '2026-09-29',
          valid_until: undefined,
          reason: 'they said so',
          confidence: 'high',
          sources: [{ ...span, note: 'first message' }],
        },
      ]),
    );
    expect(dropped).toEqual([]);
    expect(proposals[0]).toMatchObject({
      expected_revision: null,
      valid_from: '2026-09-29T00:00:00Z',
      valid_until: null,
    });
    expect(proposals[0]).not.toHaveProperty('confidence');
  });

  test('one malformed entry is dropped with its reason; the rest are kept', () => {
    const { proposals, dropped } = readExtractionReply(
      JSON.stringify({ proposals: [add, { op: 'add', content: 'no sources' }, 'noise'] }),
    );
    expect(proposals).toHaveLength(1);
    expect(dropped.map((item) => item.index)).toEqual([1, 2]);
    expect(dropped[0]?.detail).toContain('domain_key');
  });

  test('an answer with no JSON at all is unreadable, never a crash', () => {
    expect(code(() => readExtractionReply('I could not find anything to remember.'))).toBe(
      'extraction_unreadable',
    );
    expect(code(() => readExtractionReply('{"proposals": [ {"op": "add"'))).toBe(
      'extraction_unreadable',
    );
    expect(code(() => readExtractionReply('{"memories": []}'))).toBe('extraction_unreadable');
  });

  test('an empty answer list is a good answer', () => {
    expect(readExtractionReply('{"proposals": []}')).toEqual({ proposals: [], dropped: [] });
  });
});

describe('the replies a real model gave', () => {
  const said =
    'Email and admin is what eats my week right now. I’d rather do calls in the morning.';
  const evidence = {
    source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    source_version: '1',
    start: 0,
    text: said,
  };
  const claim = (over: Record<string, unknown>, span: Record<string, unknown>) =>
    JSON.stringify({
      proposals: [
        {
          domain_key: 'work.time_sink',
          content: 'Email and admin take up most of the week',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-09-30',
          valid_until: null,
          sources: [span],
          ...over,
        },
      ],
    });

  test('no "op" at all, with an offset one short: read as an add citing the exact sentence', () => {
    const { proposals, dropped } = readExtractionReply(
      claim(
        {},
        {
          source_id: evidence.source_id,
          source_version: '1',
          start: 0,
          end: 46,
          quote: 'Email and admin is what eats my week right now.',
        },
      ),
      evidence,
    );
    expect(dropped).toEqual([]);
    expect(proposals[0]).toMatchObject({ op: 'add', expected_revision: null });
    const span = proposals[0]?.sources[0];
    expect(span).toMatchObject({ start: 0, end: 47 });
    expect(said.slice(span?.start, span?.end)).toBe(span?.quote ?? '');
  });

  test('"action" in place of "op", no source named, and a straight apostrophe', () => {
    const { proposals } = readExtractionReply(
      claim({ action: 'add' }, { start: 3, end: 9, quote: "I'd rather do  calls in the morning" }),
      evidence,
    );
    expect(proposals[0]?.op).toBe('add');
    const span = proposals[0]?.sources[0];
    expect(span?.source_id).toBe(evidence.source_id);
    expect(span?.quote).toBe('I’d rather do calls in the morning');
    expect(said.slice(span?.start, span?.end)).toBe(span?.quote ?? '');
  });

  test('a quote that is not in the message is left as written, to be refused as not verbatim', () => {
    const { proposals } = readExtractionReply(
      claim({ op: 'add' }, { start: 0, end: 10, quote: 'I love spreadsheets' }),
      evidence,
    );
    expect(proposals[0]?.sources[0]).toMatchObject({
      start: 0,
      end: 10,
      quote: 'I love spreadsheets',
    });
  });
});

describe('finding a quote', () => {
  test('the occurrence nearest the offset the model gave', () => {
    const text = 'tea. coffee. tea.';
    expect(findQuote(text, 'tea', 12)).toEqual({ start: 13, end: 16 });
    expect(findQuote(text, 'tea', 0)).toEqual({ start: 0, end: 3 });
  });
  test('loosely: whitespace, case, typographic quotes and a trailing stop', () => {
    const text = 'She said “Call me Mon”   and left';
    const found = findQuote(text, 'she said "call me mon" and left.');
    expect(found && text.slice(found.start, found.end)).toBe(text);
    expect(findQuote(text, 'nowhere')).toBeNull();
  });
  test('loosely, after a letter whose lower case is longer, still cites the right characters', () => {
    // "İ" lowers to two code units; the span must still land on the quoted words.
    const text = 'Back from İstanbul. My sister Maya lives in Lisbon now.';
    const found = findQuote(text, 'my sister maya lives in lisbon');
    expect(found && text.slice(found.start, found.end)).toBe('My sister Maya lives in Lisbon');
  });
});
