import { expect, test } from 'bun:test';
import type { ToolSpec } from '@melete/contracts';
import {
  CATALOG_INDEX_TOKENS,
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

const withoutIndex = (tools: readonly ToolSpec[]): ToolSpec[] =>
  tools.map((tool) => META_TOOLS.find((meta) => meta.name === tool.name) ?? tool);

test('core uses a serialized token budget, never a count cap, with stable ordering', () => {
  const many = Array.from({ length: 22 }, (_, i) =>
    item(`files.t${String(i).padStart(2, '0')}`, { core: true }),
  );
  const budget = toolTokens([...META_TOOLS, ...many.map((entry) => entry.tool)]);
  const selected = selectCore(many, budget);
  expect(selected).toHaveLength(24);
  expect(selectCore([...many].reverse(), budget)).toEqual(selected);
  // The schemas answer to their budget; the names-only index answers to its own.
  const tight = selectCore(many, 500);
  expect(toolTokens(withoutIndex(tight))).toBeLessThanOrEqual(500);
  expect(toolTokens(tight)).toBeLessThanOrEqual(500 + CATALOG_INDEX_TOKENS);
  expect(toolTokens(selectCore(many, 500, {}, 0))).toBeLessThanOrEqual(500);
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
  const selected = selectCore([capability, failing]);
  expect(withoutIndex(selected)).toEqual(META_TOOLS);
  const loader = selected.find((tool) => tool.name === 'load_tool');
  expect(loader?.description).toContain('images.draw (Read images.draw)');
  expect(loader?.description).not.toContain('mail.search');
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

function effect(
  name: string,
  effectClass: ToolSpec['effect_class'],
  description: string,
  options: Partial<CatalogItem> = {},
): CatalogItem {
  const tool: ToolSpec = {
    name,
    description,
    input_schema: { type: 'object', properties: { text: { type: 'string' } } },
    effect_class: effectClass,
    connection_id: 'conn_01J8ZP3QWABCDEFGHJKMNPQRST',
  };
  return { tool, entry: manifestEntry(tool, [name]), core: false, uses: 0, ...options };
}

const names = (tools: readonly ToolSpec[]) => tools.map((tool) => tool.name);

test('relevance to the objective and the latest owner message outranks usage', () => {
  const popular = effect('notes.search', 'read', 'Search saved notes', { uses: 500 });
  const create = effect('calendar.create', 'write_external', 'Create a calendar event');
  const restart = effect('server.restart', 'write_external', 'Restart a managed service');
  const budget = toolTokens([...META_TOOLS, create.tool]);
  expect(names(selectCore([popular, create, restart], budget, {}, 0))).toContain('notes.search');
  expect(
    names(
      selectCore([popular, create, restart], budget, { text: 'Create the Friday review event' }, 0),
    ),
  ).toEqual(['search_tools', 'load_tool', 'calendar.create']);
  // Stemming and name segments: "restarting" reaches `server.restart`.
  expect(
    names(
      selectCore(
        [popular, create, restart],
        toolTokens([...META_TOOLS, restart.tool]),
        { text: 'Try restarting the billing service' },
        0,
      ),
    ),
  ).toEqual(['search_tools', 'load_tool', 'server.restart']);
});

test('a reversible draft is never shown without its external-write sibling', () => {
  const draft = effect('mail.draft', 'write_reversible', 'Save a local mail draft', { uses: 9 });
  const send = effect('mail.send', 'write_external', 'Send a mail message');
  const lonely = effect('notes.draft', 'write_reversible', 'Save a local note draft');
  const both = toolTokens([...META_TOOLS, draft.tool, send.tool]);
  const selected = names(selectCore([draft, send], both, { text: 'Draft a mail to Alex' }, 0));
  expect(selected).toEqual(['search_tools', 'load_tool', 'mail.draft', 'mail.send']);
  // The pair does not fit: the draft alone would read as the only way to act.
  const tight = names(selectCore([draft, send], both - 1, { text: 'Draft a mail to Alex' }, 0));
  expect(tight).not.toContain('mail.draft');
  // A draft with no external sibling is an ordinary tool.
  expect(names(selectCore([lonely], toolTokens([...META_TOOLS, lonely.tool]), {}, 0))).toContain(
    'notes.draft',
  );
});

test('the lifecycle wait and the reaction are pinned when the turn needs them', () => {
  const files = Array.from({ length: 12 }, (_, i) =>
    item(`files.t${String(i).padStart(2, '0')}`, { core: true }),
  );
  const wait = item('job.wait', { core: true });
  const react = item('react', { core: true });
  const budget = toolTokens([...META_TOOLS, wait.tool, react.tool]);
  const plain = names(selectCore([...files, wait, react], budget, {}, 0));
  expect(plain).not.toContain('job.wait');
  const pinned = names(
    selectCore([...files, wait, react], budget, { waitable: true, conversational: true }, 0),
  );
  expect(pinned).toEqual(['search_tools', 'load_tool', 'job.wait', 'react']);
});

test('an MCP tool enters the core by relevance and never by default', () => {
  const mcp = effect('tickets.lookup', 'read', 'Look up a support ticket');
  mcp.entry.source = 'mcp';
  expect(names(selectCore([mcp]))).not.toContain('tickets.lookup');
  expect(names(selectCore([mcp], undefined, { text: 'Find ticket 4411' }))).toContain(
    'tickets.lookup',
  );
});

test('an MCP description cannot take the place of a granted connector verb', () => {
  // A description written by the server it came from is that server's words,
  // not the owner's. They may earn room nothing else wanted; they may not
  // spend the room a granted verb wanted, however closely they echo the job.
  const granted = effect('mail.send', 'write_external', 'Send a mail message');
  const text = 'Send the quarterly report to Alex by Friday morning as an email attachment';
  const echoing = effect('helper.relay', 'write_external', text);
  echoing.entry.source = 'mcp';
  const one = toolTokens([...META_TOOLS, echoing.tool]);
  expect(names(selectCore([granted, echoing], one, { text }, 0))).toEqual([
    'search_tools',
    'load_tool',
    'mail.send',
  ]);
  // With room for both, the echoing tool is still offered, after the verb.
  const two = toolTokens([...META_TOOLS, granted.tool, echoing.tool]);
  expect(names(selectCore([granted, echoing], two, { text }, 0))).toEqual([
    'search_tools',
    'load_tool',
    'mail.send',
    'helper.relay',
  ]);
});

test('every unloaded tool is named in a bounded index on load_tool', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    effect(
      `suite${String(i).padStart(2, '0')}.apply`,
      'read',
      `Apply change number ${i} to the remote record. This second sentence is never shown.`,
    ),
  );
  const selected = selectCore(many, 400, {}, CATALOG_INDEX_TOKENS);
  const core = new Set(names(selected));
  const loader = selected.find((tool) => tool.name === 'load_tool');
  const base = META_TOOLS.find((tool) => tool.name === 'load_tool');
  if (!loader || !base) throw new Error('load_tool missing');
  const index = loader.description.slice(base.description.length);
  const first = many.find((entry) => !core.has(entry.tool.name));
  expect(index).toContain(`${first?.tool.name} (Apply change number`);
  expect(index).not.toContain('second sentence');
  expect(index).toMatch(/\+\d+ more/);
  expect(Math.ceil(index.length / 4)).toBeLessThanOrEqual(CATALOG_INDEX_TOKENS);
  // The schemas keep their own budget; the index has a separate fixed one.
  expect(toolTokens(selected)).toBeLessThanOrEqual(400 + CATALOG_INDEX_TOKENS);
  expect(toolTokens(withoutIndex(selected))).toBeLessThanOrEqual(400);
  // Core tools are not repeated, and a full core leaves the description alone.
  for (const name of core) expect(index).not.toContain(`${name} (`);
  const only = many[0] as CatalogItem;
  expect(selectCore([only])).toEqual([...META_TOOLS, only.tool]);
});
