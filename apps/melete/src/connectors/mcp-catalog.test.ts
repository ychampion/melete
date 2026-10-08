/**
 * The app catalog's tools, as the broker sees them: reads run, changes that
 * can be put back go to auto-review, and anything that posts or sends as the
 * person, deletes, merges or moves money asks the person first.
 */
import { describe, expect, test } from 'bun:test';
import { asksFirst, MCP_CATALOG, mcpCatalogConfig } from '@melete/contracts';
import { reviewTier } from '../broker/auto-review.ts';
import { mcpServerConfig } from './mcp.ts';

describe('the app catalog', () => {
  test('every entry installs as a valid MCP policy, with one grant per tool and nothing more', () => {
    for (const entry of MCP_CATALOG) {
      const { url, ...policy } = mcpCatalogConfig(entry, entry.url);
      const parsed = mcpServerConfig.parse({ ...policy, endpoint: { transport: 'http', url } });
      expect(parsed.allowed_scopes).toHaveLength(entry.tools.length);
      for (const tool of parsed.tools)
        expect(tool.required_scopes).toEqual([`mcp_${entry.id}.${tool.alias}`]);
    }
  });

  test('a narrower list installs only those tools', () => {
    const notion = MCP_CATALOG.find((entry) => entry.id === 'notion');
    if (!notion) throw new Error('Notion is missing');
    const config = mcpCatalogConfig(notion, notion.url, notion.tools.slice(0, 2));
    expect(config.tools.map((tool) => tool.name)).toEqual(['notion-search', 'notion-fetch']);
    expect(config.allowed_scopes).toEqual(['mcp_notion.search', 'mcp_notion.fetch']);
  });

  test('posting, sending, deleting, merging and money always ask first', () => {
    const risky =
      /comment|create_issue$|issue_write|create_pull|merge|delete|push|refund|invoice|payment_link|subscription|dispute|coupon|worklog|create_jira|create_confluence|create_project|create_team|create_dsn|create_repository|fork/i;
    for (const entry of MCP_CATALOG)
      for (const tool of entry.tools) {
        // What only looks is a read; of the rest, what posts, sends, deletes or pays asks.
        if (/^(get|list|search|find|fetch|retrieve|whoami)|-(search|fetch|get)/i.test(tool.name))
          expect({ tool: tool.name, effect: tool.effect_class }).toEqual({
            tool: tool.name,
            effect: 'read',
          });
        else if (risky.test(tool.name))
          expect({ app: entry.id, tool: tool.name, asks: asksFirst(tool.effect_class) }).toEqual({
            app: entry.id,
            tool: tool.name,
            asks: true,
          });
      }
    const stripe = MCP_CATALOG.find((entry) => entry.id === 'stripe');
    for (const name of [
      'create_refund',
      'create_invoice',
      'create_payment_link',
      'finalize_invoice',
    ])
      expect(stripe?.tools.find((tool) => tool.name === name)?.effect_class).toBe('spend');
  });

  test('the broker runs reads, reviews changes that can be undone, and asks for the rest', () => {
    const tiers = new Map<string, Set<string>>();
    for (const entry of MCP_CATALOG)
      for (const tool of entry.tools) {
        const decided = reviewTier({
          tool: {
            name: `mcp_${entry.id}.${tool.alias}`,
            effect_class: tool.effect_class,
            // As the MCP worker builds every tool.
            requires_approval: tool.effect_class !== 'read',
          },
          provider: 'mcp',
          payload: {},
          doubts: [],
        });
        const seen = tiers.get(tool.effect_class) ?? new Set<string>();
        seen.add(decided.tier);
        tiers.set(tool.effect_class, seen);
      }
    expect([...(tiers.get('read') ?? [])]).toEqual(['sandbox']);
    expect([...(tiers.get('write_reversible') ?? [])]).toEqual(['reviewable']);
    expect([...(tiers.get('write_external') ?? [])]).toEqual(['person']);
    expect([...(tiers.get('spend') ?? [])]).toEqual(['person']);
  });
});
