import { expect, test } from 'bun:test';
import type { ToolSpec } from '@melete/contracts';
import {
  type CatalogItem,
  META_TOOLS,
  manifestEntry,
  schemaFingerprint,
  selectCore,
  toolTokens,
} from './catalog.ts';

function item(name: string, options: Partial<CatalogItem> = {}): CatalogItem {
  const tool: ToolSpec = {
    name,
    description: `Read ${name}`,
    input_schema: { type: 'object' },
    effect_class: 'read',
    connection_id: null,
  };
  return { tool, entry: manifestEntry(tool, [name]), core: false, uses: 0, ...options };
}

test('core uses a serialized token budget, never a count cap, with stable ordering', () => {
  const many = Array.from({ length: 22 }, (_, i) =>
    item(`files.t${String(i).padStart(2, '0')}`, { core: true }),
  );
  const budget = toolTokens([...META_TOOLS, ...many.map((entry) => entry.tool)]);
  const selected = selectCore(many, budget);
  expect(selected).toHaveLength(24);
  expect(selectCore([...many].reverse(), budget)).toEqual(selected);
  expect(toolTokens(selectCore(many, 500))).toBeLessThanOrEqual(500);
  expect(() => selectCore(many, 1)).toThrow('cannot hold discovery tools');
});

test('core prioritizes local tools then most-used granted connector verbs', () => {
  const local = item('files.read', { core: true });
  const popular = item('mail.search', { uses: 100 });
  const other = item('mail.archive');
  const budget = toolTokens([...META_TOOLS, local.tool, popular.tool]);
  expect(selectCore([other, popular, local], budget).map((tool) => tool.name)).toEqual([
    'search_tools',
    'load_tool',
    'files.read',
    'mail.search',
  ]);
});

test('capabilities and failing tools stay discoverable without inflating the core', () => {
  const capability = item('images.draw');
  capability.entry.source = 'capability';
  const failing = item('mail.search');
  failing.entry.health = 'failing';
  expect(selectCore([capability, failing])).toEqual(META_TOOLS);
});

test('fingerprints ignore schema key order and compact manifests bound examples', () => {
  expect(schemaFingerprint({ type: 'object', properties: { a: { type: 'string' } } })).toBe(
    schemaFingerprint({ properties: { a: { type: 'string' } }, type: 'object' }),
  );
  expect(schemaFingerprint({ type: 'string' })).not.toBe(schemaFingerprint({ type: 'number' }));
  const tool = item('files.read').tool;
  const manifest = manifestEntry(
    { ...tool, description: 'One\nline' },
    ['z', 'a', 'z'],
    'skill',
    'ok',
    ['One\nexample', 'two', 'three'],
  );
  expect(manifest.description).toBe('One line');
  expect(manifest.examples).toEqual(['One example', 'two']);
  expect(manifest.required_scopes).toEqual(['a', 'z']);
  expect(manifest).not.toHaveProperty('input_schema');
});
