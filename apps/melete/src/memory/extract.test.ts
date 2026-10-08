import { describe, expect, test } from 'bun:test';
import type { ExtractionProposal } from '@melete/contracts';
import { MemoryError } from './db.ts';
import { findQuote, isCollectionKey, keepListItems, readExtractionReply } from './extract.ts';

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

  test('a quote that is not in the message is refused with that reason', () => {
    const { proposals, dropped } = readExtractionReply(
      claim({ op: 'add' }, { start: 0, end: 10, quote: 'I love spreadsheets' }),
      evidence,
    );
    expect(proposals).toEqual([]);
    expect(dropped).toEqual([{ index: 0, detail: 'sources: quote not found in the source' }]);
  });
});

describe('a structured answer, as a schema-held model returns it', () => {
  // The message sits at 120 in its source; the model is shown only this segment.
  const said =
    'Thanks! Also, my sister Maya lives in Lisbon now. Remember that I take tea, not coffee.';
  const evidence = {
    source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    source_version: '3',
    start: 120,
    text: said,
  };
  const unused = {
    claim_id: null,
    expected_revision: null,
    domain_key: null,
    content: null,
    kind: null,
    factual_status: null,
    valid_from: null,
    valid_until: null,
  };

  test('quotes only, with the unused fields null: offsets come from the segment', () => {
    // Recorded shape of a strict json_schema answer to EXTRACTION_FORMAT.
    const reply = JSON.stringify({
      proposals: [
        {
          ...unused,
          op: 'add',
          domain_key: 'person.maya.city',
          content: 'Maya lives in Lisbon',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-10-01T09:00:00Z',
          sources: [{ quote: 'my sister Maya lives in Lisbon' }],
        },
        {
          ...unused,
          op: 'retract',
          claim_id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FAV',
          expected_revision: 2,
          sources: [{ quote: 'I take tea, not coffee' }],
        },
        { ...unused, op: 'no-op', sources: [{ quote: 'Thanks!' }] },
      ],
    });
    const { proposals, dropped } = readExtractionReply(reply, evidence);
    expect(dropped).toEqual([]);
    expect(proposals.map((proposal) => proposal.op)).toEqual(['add', 'retract', 'no-op']);
    for (const proposal of proposals)
      for (const span of proposal.sources) {
        expect(span).toMatchObject({ source_id: evidence.source_id, source_version: '3' });
        expect(said.slice(span.start - 120, span.end - 120)).toBe(span.quote);
      }
    expect(proposals[0]?.sources[0]).toMatchObject({ start: 134, end: 164 });
    expect(proposals[1]).not.toHaveProperty('content');
  });

  test('the old failure: offsets the model counted wrong are replaced by where the quote is', () => {
    // Recorded prose-mode answer: right words, offsets counted from the wrong place.
    const reply = JSON.stringify({
      proposals: [
        {
          op: 'add',
          expected_revision: null,
          domain_key: 'pref.drink',
          content: 'Takes tea, not coffee',
          kind: 'preference',
          factual_status: 'attributed',
          valid_from: '2026-10-01T09:00:00Z',
          valid_until: null,
          sources: [{ ...evidence, start: 0, end: 22, quote: 'I take tea, not coffee' }],
        },
      ],
    });
    const span = readExtractionReply(reply, evidence).proposals[0]?.sources[0];
    expect(span).toMatchObject({
      start: 120 + said.indexOf('I take'),
      quote: 'I take tea, not coffee',
    });
  });

  test('a loosely copied quote cites the segment’s own characters', () => {
    const reply = JSON.stringify({
      proposals: [
        {
          ...unused,
          op: 'add',
          domain_key: 'person.maya.city',
          content: 'Maya lives in Lisbon',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-10-01T09:00:00Z',
          sources: [{ quote: 'My  sister maya lives in Lisbon.' }],
        },
      ],
    });
    const span = readExtractionReply(reply, evidence).proposals[0]?.sources[0];
    expect(span?.quote).toBe('my sister Maya lives in Lisbon');
  });

  test('the old failure: a reply cut off mid-document is unreadable, never a partial read', () => {
    // Recorded: the output limit hit inside the second proposal.
    const cut =
      '{"proposals":[{"op":"no-op","sources":[{"quote":"Thanks!"}]},{"op":"add","domain_key":"person.maya.city","content":"Maya li';
    expect(code(() => readExtractionReply(cut, evidence))).toBe('extraction_unreadable');
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

describe('a list the person adds to', () => {
  const CLAIM = 'k_01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const item = (content: string, op: 'add' | 'supersede' = 'add', domain = 'reading_list') =>
    ({
      ...add,
      ...(op === 'supersede' ? { op, claim_id: CLAIM, expected_revision: 1 } : {}),
      domain_key: domain,
      key: domain,
      content,
    }) as ExtractionProposal;
  const keyOf = (proposal: ExtractionProposal | undefined) =>
    proposal && 'domain_key' in proposal ? proposal.domain_key : null;
  const first = 'Reading list: https://en.wikipedia.org/wiki/Container_ship';
  const second = 'Reading list: https://en.wikipedia.org/wiki/Suez_Canal';
  const held = [{ domain_key: 'reading_list', content: first }];

  test('a list is named by its key; a setting or a preference is one answer', () => {
    for (const key of ['reading_list', 'user.reading_list', 'gift_ideas', 'travel.wishlist'])
      expect(isCollectionKey(key)).toBe(true);
    for (const key of [
      'preferences.mailing_list',
      'pref.reading.list',
      'settings.watchlist',
      'pref.coffee.order',
      'person.maya.city',
      'reading_list.item_x1',
      'user.reading-list',
    ])
      expect(isCollectionKey(key)).toBe(false);
  });

  test('the first item stays where it was put; a second gets a key of its own beside it', () => {
    const [kept] = keepListItems([item(first)]);
    expect(kept).toEqual(item(first));
    const [added] = keepListItems([item(second)], held);
    expect(added?.op).toBe('add');
    expect(keyOf(added)).toStartWith('reading_list.en_wikipedia_org_wiki_suez_canal_');
    expect(added && 'key' in added).toBe(false);
    // Two in one message: the first takes the list's key, the second its own.
    const both = keepListItems([item(first), item(second)]);
    expect(keyOf(both[0])).toBe('reading_list');
    expect(keyOf(both[1])).toStartWith('reading_list.en_wikipedia_org_wiki_suez_canal_');
  });

  test('a supersede on a list key stays a supersede', () => {
    const replaced = item(second, 'supersede');
    expect(keepListItems([replaced], held)).toEqual([replaced]);
  });

  test('the same item in the same wording is not added twice', () => {
    expect(keepListItems([item(`  ${first.toUpperCase()}. `)], held)).toEqual([
      { op: 'no-op', sources: add.sources },
    ]);
    const twice = keepListItems([item(second), item(`${second}.`)], held);
    expect(twice[0]?.op).toBe('add');
    expect(twice[1]).toEqual({ op: 'no-op', sources: add.sources });
    // Already kept under its own item key, it is not added again either.
    const itemKey = keyOf(twice[0]) ?? '';
    expect(
      keepListItems([item(second)], [...held, { domain_key: itemKey, content: second }]),
    ).toEqual([{ op: 'no-op', sources: add.sources }]);
  });

  test('a preference that names a list is never split, even when it already has a value', () => {
    const answer = item('Keep me off every mailing list', 'add', 'preferences.mailing_list');
    expect(
      keepListItems([answer], [{ domain_key: 'preferences.mailing_list', content: 'None' }]),
    ).toEqual([answer]);
  });
});

describe('a structured extraction full of filler', () => {
  const said = 'Thanks! My sister Maya lives in Lisbon now.';
  const evidence = {
    source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    source_version: '1',
    start: 0,
    text: said,
  };

  test('fields an operation does not use are dropped, "" and 0 included', () => {
    // Recorded shape: the unused fields filled with "" and 0 instead of null.
    const reply = JSON.stringify({
      proposals: [
        {
          op: 'add',
          claim_id: '',
          expected_revision: 0,
          domain_key: 'person.maya.city',
          content: 'Maya lives in Lisbon',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '2026-10-01T09:00:00Z',
          valid_until: '',
          sources: [{ quote: 'My sister Maya lives in Lisbon' }],
        },
        {
          op: 'no-op',
          claim_id: '',
          expected_revision: 0,
          domain_key: '',
          content: '',
          kind: 'user_statement',
          factual_status: 'attributed',
          valid_from: '',
          valid_until: '',
          sources: [{ quote: 'Thanks!' }],
        },
      ],
    });
    const { proposals, dropped } = readExtractionReply(reply, evidence);
    expect(dropped).toEqual([]);
    expect(proposals[0]).toMatchObject({ op: 'add', expected_revision: null, valid_until: null });
    expect(proposals[0]).not.toHaveProperty('claim_id');
    expect(Object.keys(proposals[1] ?? {}).sort()).toEqual(['op', 'sources']);
  });

  test('one quote that is not there drops that proposal only', () => {
    const reply = JSON.stringify({
      proposals: [
        {
          op: 'no-op',
          sources: [{ quote: 'I never said this' }],
        },
        { op: 'no-op', sources: [{ quote: 'Thanks!' }] },
      ],
    });
    const { proposals, dropped } = readExtractionReply(reply, evidence);
    expect(dropped.map((item) => item.index)).toEqual([0]);
    expect(proposals).toHaveLength(1);
  });
});

describe('one-time tasks and requests are not facts about the person', () => {
  const said = (quote: string, content: string, kind = 'user_statement', extra = {}) => ({
    ...add,
    domain_key: 'person.request',
    content,
    kind,
    ...extra,
    sources: [{ ...span, end: quote.length, quote }],
  });
  const kept = (entry: unknown) =>
    readExtractionReply(JSON.stringify({ proposals: [entry] })).proposals.map(
      (proposal) => proposal.op,
    );

  const requests: [string, string][] = [
    ['book me a table for 7 tonight', 'Wants a table for 7 tonight'],
    ['Can you book a table for 7 tonight at Nopa?', 'Booking a table at Nopa tonight'],
    ['please send Maya the deck', 'Wants the deck sent to Maya'],
    ['Find flights to Denver for next weekend', 'Looking for flights to Denver'],
    ['write a short poem about rain', 'Asked for a poem about rain'],
    ['install pandas and run the notebook', 'Needs pandas installed'],
    ['remind me at 5 to call the bank', 'Call the bank at 5'],
    ['ok, order the blue one', 'Ordering the blue one'],
  ];
  for (const [quote, content] of requests)
    test(`dropped: ${quote}`, () => {
      expect(kept(said(quote, content))).toEqual(['no-op']);
    });

  const lasting: [string, string, string?][] = [
    ['I am allergic to cashews', 'Allergic to cashews'],
    ['always book aisle seats for me', 'Prefers aisle seats', 'preference'],
    ['from now on, write to me in Spanish', 'Wants replies in Spanish', 'preference'],
    ['never schedule calls before 10', 'No calls before 10', 'preference'],
    ["book somewhere vegetarian, I don't eat meat", "Doesn't eat meat"],
    ['remember that my sister Priyanka lives in Denver', 'Priyanka lives in Denver'],
    ['call me Sam', 'Goes by Sam', 'preference'],
    ['My landlord is Mr. Okafor', 'Landlord is Mr. Okafor'],
    ['Book club meets every Thursday at 7', 'Book club on Thursdays at 7'],
  ];
  for (const [quote, content, kind] of lasting)
    test(`kept: ${quote}`, () => {
      expect(kept(said(quote, content, kind))).toEqual(['add']);
    });

  test('the model saying a proposal is not lasting drops it, except a temporary exception', () => {
    expect(
      kept(said('the 7pm slot works', 'Prefers 7pm', 'preference', { lasting: false })),
    ).toEqual(['no-op']);
    expect(
      kept(said("I'm away until Friday", 'Away until Friday', 'exception', { lasting: false })),
    ).toEqual(['add']);
    expect(
      kept(said('the 7pm slot works', 'Prefers 7pm', 'preference', { lasting: true })),
    ).toEqual(['add']);
  });

  test('a forwarded document is not judged as a request', () => {
    expect(
      kept(
        said('Order #4411 ships to 12 Oak St', 'Order 4411 ships to Oak St', 'document_assertion'),
      ),
    ).toEqual(['add']);
  });
});
