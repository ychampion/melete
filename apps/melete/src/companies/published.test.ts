/**
 * What a connection's feed can and cannot put on the ledger. The connection is
 * installed by the owner, but its items quote text other people wrote, so they
 * pass the same gate a scanned item does: a quote that is not exactly the text
 * at its span drops the whole item, and an action is kept only when it names a
 * tool the installation declared for the ledger.
 */
import { describe, expect, test } from 'bun:test';
import { evidenceHolds } from '@melete/contracts';
import {
  ACTION_INPUT_LIMIT,
  actionToolName,
  admitFeed,
  FEED_ENTRY_LIMITS,
  feedBody,
  feedEntryFits,
  publishedActionDigest,
  publishedMessageId,
  publishedStepObjective,
  shownActions,
} from './published.ts';

const CONNECTION = 'conn_01J8ZP3QWABCDEFGHJKMNPQRST';
const NOW = new Date('2026-10-01T09:00:00.000Z');
const TEXT = 'Thanks for the call. We will send the signed contract back by Friday. Ana';
const QUOTE = 'We will send the signed contract back by Friday.';
const START = TEXT.indexOf(QUOTE);

const source = {
  ref: 'thread-9',
  title: 'Contract',
  from: 'Ana <ana@harbour.example>',
  text: TEXT,
};
const item = (overrides: Record<string, unknown> = {}) => ({
  ref: 'deal-4',
  kind: 'commitment',
  direction: 'owed_to_you',
  summary: 'Signed contract back from Harbour',
  counterparty: { name: 'Harbour Studio', domain: 'harbour.example' },
  parties: [{ name: 'Ana', role: 'client' }],
  state: 'waiting on them',
  next_step: 'Nudge Ana on Monday',
  due_at: '2026-10-03T00:00:00.000Z',
  due_date_only: true,
  evidence: [{ source: 'thread-9', quote: QUOTE, start: START, end: START + QUOTE.length }],
  actions: [{ id: 'nudge', label: 'Nudge them', tool: 'post_note', input: { deal: 'deal-4' } }],
  ...overrides,
});
const admit = (body: unknown, declaredActions: string[] = ['post_note']) =>
  admitFeed(body, { connectionId: CONNECTION, declaredActions, now: NOW });

describe('admitting a feed', () => {
  test('an item whose quote holds is admitted, citing its source under a stored id', () => {
    const admitted = admit({ sources: [source], items: [item()] });
    expect(admitted?.seen).toBe(1);
    expect(admitted?.items).toHaveLength(1);
    const [evidence] = admitted?.items[0]?.evidence ?? [];
    expect(evidence?.message_id).toBe(publishedMessageId(CONNECTION, source));
    expect(evidence?.message_id.startsWith(`${CONNECTION}/thread-9#`)).toBe(true);
    const [stored] = admitted?.messages ?? [];
    expect(stored && evidence && evidenceHolds(stored.text, evidence)).toBe(true);
    expect(admitted?.dropped).toEqual({});
  });

  test('a fabricated quote, a shifted span and a missing source each drop the item', () => {
    const admitted = admit({
      sources: [source],
      items: [
        item({
          ref: 'a',
          evidence: [{ source: 'thread-9', quote: 'We will pay £9,000.', start: 0, end: 19 }],
        }),
        item({
          ref: 'b',
          evidence: [
            { source: 'thread-9', quote: QUOTE, start: START + 1, end: START + 1 + QUOTE.length },
          ],
        }),
        item({
          ref: 'c',
          evidence: [
            { source: 'thread-404', quote: QUOTE, start: START, end: START + QUOTE.length },
          ],
        }),
      ],
    });
    expect(admitted?.items).toEqual([]);
    expect(admitted?.messages).toEqual([]);
    expect(admitted?.dropped).toEqual({ evidence_failed: 2, source_missing: 1 });
  });

  test('a second quote that fails drops the whole item, not only that quote', () => {
    const good = item().evidence[0];
    const admitted = admit({
      sources: [source],
      items: [
        item({
          evidence: [good, { source: 'thread-9', quote: 'nothing like this', start: 0, end: 17 }],
        }),
      ],
    });
    expect(admitted?.items).toEqual([]);
    expect(admitted?.dropped).toEqual({ evidence_failed: 1 });
  });

  test('an action through a tool the installation did not declare is dropped, and the item kept', () => {
    const admitted = admit({
      sources: [source],
      items: [
        item({
          actions: [
            { id: 'nudge', label: 'Nudge them', tool: 'post_note', input: {} },
            { id: 'wipe', label: 'Tidy up', tool: 'delete_all', input: {} },
          ],
        }),
      ],
    });
    expect(admitted?.items[0]?.actions.map((action) => action.id)).toEqual(['nudge']);
    expect(admitted?.dropped).toEqual({ action_undeclared: 1 });
    expect(admit({ sources: [source], items: [item()] }, [])?.items[0]?.actions).toEqual([]);
  });

  test('an action input too large to carry is dropped', () => {
    const input = { note: 'x'.repeat(ACTION_INPUT_LIMIT) };
    const admitted = admit({
      sources: [source],
      items: [item({ actions: [{ id: 'nudge', label: 'Nudge', tool: 'post_note', input }] })],
    });
    expect(admitted?.items[0]?.actions).toEqual([]);
    expect(admitted?.dropped).toEqual({ action_too_large: 1 });
  });

  test('a malformed item or a repeated ref is counted and the rest stand', () => {
    const admitted = admit({
      sources: [source, source],
      items: [item(), item(), { ref: 'z', kind: 'nonsense' }],
    });
    expect(admitted?.seen).toBe(3);
    expect(admitted?.items).toHaveLength(1);
    expect(admitted?.dropped).toEqual({ duplicate_source: 1, duplicate_item: 1, invalid: 1 });
  });

  test('an answer that is not a feed is not read as an empty one', () => {
    expect(admit({ rows: [] })).toBeNull();
    expect(admit(null)).toBeNull();
  });

  test('a source whose text changed is a different stored message', () => {
    expect(publishedMessageId(CONNECTION, source)).not.toBe(
      publishedMessageId(CONNECTION, { ...source, text: `${TEXT} PS.` }),
    );
  });
});

describe('reading a feed tool answer', () => {
  test('structured content first, else one text block of JSON, else nothing', () => {
    expect(feedBody({ structuredContent: { items: [] }, content: [] })).toEqual({ items: [] });
    expect(feedBody({ content: [{ type: 'text', text: '{"items":[]}' }] })).toEqual({ items: [] });
    expect(feedBody({ content: [{ type: 'text', text: 'not json' }] })).toBeNull();
    expect(
      feedBody({
        content: [
          { type: 'text', text: '{}' },
          { type: 'text', text: '{}' },
        ],
      }),
    ).toBeNull();
  });
});

describe('what a step is bound to', () => {
  const action = {
    id: 'nudge',
    label: 'Nudge them',
    tool: 'post_note',
    input: { deal: 'deal-4' },
  };

  test('the digest covers the id, label, tool and input, and nothing else moves it', () => {
    const digest = publishedActionDigest(action);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // Key order is not part of what was shown.
    expect(publishedActionDigest({ ...action, input: { deal: 'deal-4' } })).toBe(digest);
    for (const changed of [
      { ...action, id: 'nudge-2' },
      { ...action, label: 'Mark as seen' },
      { ...action, tool: 'delete_all' },
      { ...action, input: { deal: 'deal-5' } },
      { ...action, input: { deal: 'deal-4', note: 'and one more thing' } },
    ])
      expect(publishedActionDigest(changed)).not.toBe(digest);
    expect(shownActions([action])).toEqual([{ ...action, digest }]);
  });

  test('the job that runs a step is described from the installation alone', () => {
    const objective = publishedStepObjective('Project tracker', 'post_note');
    expect(objective).toContain('post_note');
    expect(objective).toContain('Project tracker');
    expect(objective.includes('\n')).toBe(false);
    expect(actionToolName('tracker', action)).toBe('mcp_tracker.post_note');
  });
});

describe('one bad entry drops only itself', () => {
  const nested = (depth: number) => {
    let value: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < depth; level++) value = { next: value };
    return value;
  };

  test('a NUL anywhere in an item or a source drops that one, and the rest stand', () => {
    const admitted = admit({
      sources: [source, { ...source, ref: 'nul-source', text: `bad\u0000text ${QUOTE}` }],
      items: [
        item(),
        item({ ref: 'nul-summary', summary: 'Contract\u0000' }),
        item({ ref: 'nul-state', state: 'open\u0000' }),
        item({
          ref: 'nul-key',
          actions: [{ id: 'nudge', label: 'Nudge', tool: 'post_note', input: { 'k\u0000': 1 } }],
        }),
        item({
          ref: 'cites-nul',
          evidence: [{ source: 'nul-source', quote: QUOTE, start: 9, end: 9 + QUOTE.length }],
        }),
      ],
    });
    expect(admitted?.items.map((entry) => entry.ref)).toEqual(['deal-4']);
    expect(admitted?.dropped).toEqual({ invalid_source: 1, invalid: 3, source_missing: 1 });
    // Every well-formed ref is still what the connection lists.
    expect(admitted?.refs.sort()).toEqual(
      ['cites-nul', 'deal-4', 'nul-key', 'nul-state', 'nul-summary'].sort(),
    );
  });

  test('an input nested past any stack drops its item instead of throwing', () => {
    expect(feedEntryFits(nested(10))).toBe(true);
    expect(feedEntryFits(nested(FEED_ENTRY_LIMITS.depth + 1))).toBe(false);
    const deep = nested(50_000);
    const admitted = admit({
      sources: [source],
      items: [
        item({ ref: 'deep', actions: [{ id: 'n', label: 'N', tool: 'post_note', input: deep }] }),
        item(),
      ],
    });
    expect(admitted?.items.map((entry) => entry.ref)).toEqual(['deal-4']);
    expect(admitted?.dropped).toEqual({ invalid: 1 });
  });

  test('an item too large to read is dropped before it is parsed', () => {
    const wide = Object.fromEntries(
      Array.from({ length: FEED_ENTRY_LIMITS.values + 1 }, (_, n) => [`k${n}`, n]),
    );
    const admitted = admit({
      sources: [source],
      items: [
        item({ ref: 'wide', actions: [{ id: 'n', label: 'N', tool: 'post_note', input: wide }] }),
        item(),
      ],
    });
    expect(admitted?.items.map((entry) => entry.ref)).toEqual(['deal-4']);
    expect(admitted?.dropped).toEqual({ invalid: 1 });
  });

  test('a malformed source is counted and the items that do not cite it stand', () => {
    const admitted = admit({ sources: [{ ref: 'x' }, source], items: [item()] });
    expect(admitted?.items).toHaveLength(1);
    expect(admitted?.dropped).toEqual({ invalid_source: 1 });
  });
});
