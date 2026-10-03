/**
 * The shapes a connection's ledger feed is held to, and the declaration that
 * lets an installation offer one. Only the installation declares a feed and
 * the tools an item may act through; the feed itself cannot widen either.
 */
import { describe, expect, test } from 'bun:test';
import { ID_PREFIXES } from './common.ts';
import { ledgerFeed, ledgerFeedItem, ledgerHandleRequest, ledgerItem } from './companies.ts';
import { mcpConnectionConfig } from './mcp.ts';

const SUFFIX = '01J8ZP3QWABCDEFGHJKMNPQRST';
const id = (prefix: string) => `${prefix}_${SUFFIX}`;

const install = (ledger?: unknown) => ({
  id: 'tracker',
  url: 'https://tracker.example.net/mcp',
  allowed_scopes: ['mcp_tracker.open_items', 'mcp_tracker.post_update', 'mcp_tracker.close'],
  audience: 'owner',
  tools: [
    {
      name: 'open_items',
      alias: 'open_items',
      required_scopes: ['mcp_tracker.open_items'],
      effect_class: 'read',
    },
    { name: 'post_update', alias: 'post_update', required_scopes: ['mcp_tracker.post_update'] },
    { name: 'close', alias: 'close', required_scopes: ['mcp_tracker.close'] },
  ],
  ...(ledger === undefined ? {} : { ledger }),
});

const feedItem = {
  ref: 'TRK-17',
  kind: 'commitment',
  direction: 'you_owe',
  summary: 'Send the revised estimate',
  counterparty: { name: 'Harbour Studio', domain: 'harbour.example' },
  state: 'open',
  evidence: [{ source: 'TRK-17#c2', quote: 'by Friday', start: 10, end: 19 }],
};

describe('declaring a ledger feed on an installed server', () => {
  test('a declaration names a read tool as the feed and other installed tools as actions', () => {
    const parsed = mcpConnectionConfig.parse(
      install({ feed: 'open_items', actions: ['post_update', 'close'] }),
    );
    expect(parsed.ledger).toEqual({
      feed: 'open_items',
      actions: ['post_update', 'close'],
      join_companies: false,
    });
    expect(mcpConnectionConfig.parse(install()).ledger).toBeUndefined();
  });

  test('a feed that can write, or an action the installation does not have, is refused', () => {
    for (const ledger of [
      { feed: 'post_update' },
      { feed: 'missing' },
      { feed: 'open_items', actions: ['open_items'] },
      { feed: 'open_items', actions: ['delete_everything'] },
      { feed: 'open_items', actions: ['close', 'close'] },
      { feed: 'open_items', extra: true },
    ])
      expect(mcpConnectionConfig.safeParse(install(ledger)).success).toBe(false);
  });
});

describe('a published item', () => {
  test('a commitment is owed one way or the other, and an amount brings its currency', () => {
    expect(ledgerFeedItem.safeParse(feedItem).success).toBe(true);
    expect(ledgerFeedItem.safeParse({ ...feedItem, direction: 'info' }).success).toBe(false);
    expect(
      ledgerFeedItem.safeParse({ ...feedItem, kind: 'matter', direction: 'info' }).success,
    ).toBe(true);
    expect(ledgerFeedItem.safeParse({ ...feedItem, amount_minor: 1200 }).success).toBe(false);
    expect(ledgerFeedItem.safeParse({ ...feedItem, evidence: [] }).success).toBe(false);
  });

  test('two actions on one item cannot share an id', () => {
    const action = { id: 'remind', label: 'Remind them', tool: 'post_update', input: {} };
    expect(ledgerFeedItem.safeParse({ ...feedItem, actions: [action] }).success).toBe(true);
    expect(ledgerFeedItem.safeParse({ ...feedItem, actions: [action, action] }).success).toBe(
      false,
    );
  });

  test('a feed page leaves its items for one-by-one checking', () => {
    const page = ledgerFeed.parse({ items: [feedItem, { nonsense: true }] });
    expect(page.items).toHaveLength(2);
    expect(page.sources).toEqual([]);
    expect(ledgerFeed.safeParse({ sources: [] }).success).toBe(false);
  });

  test('the ledger item it becomes carries where it came from', () => {
    const base = {
      id: id(ID_PREFIXES.ledger_item),
      space_id: id(ID_PREFIXES.space),
      principal_id: id(ID_PREFIXES.owner),
      company_id: id(ID_PREFIXES.company),
      kind: 'matter',
      direction: 'info',
      status: 'found',
      confidence: 'high',
      evidence: [{ message_id: 'x', quote: 'by Friday', start: 0, end: 9 }],
      summary: 'Estimate for the harbour fit-out',
    };
    const source = {
      connection_id: id(ID_PREFIXES.connection),
      label: 'Project tracker',
      ref: 'TRK-17',
      state: 'with the client',
      next_step: null,
      parties: [{ name: 'Ana', role: 'client' }],
      actions: [],
      published_at: '2026-10-01T09:00:00.000Z',
    };
    expect(ledgerItem.parse({ ...base, source }).source?.label).toBe('Project tracker');
    expect(ledgerItem.parse(base).source).toBeUndefined();
  });

  test('handling takes an optional action id and nothing else', () => {
    expect(ledgerHandleRequest.parse({})).toEqual({});
    expect(ledgerHandleRequest.parse({ action: 'remind' })).toEqual({ action: 'remind' });
    expect(ledgerHandleRequest.safeParse({ action: 'Remind!' }).success).toBe(false);
    expect(ledgerHandleRequest.safeParse({ tool: 'close' }).success).toBe(false);
  });
});
