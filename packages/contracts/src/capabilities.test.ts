import { describe, expect, test } from 'bun:test';
import {
  buildToolCatalog,
  capabilityManifest,
  capabilityTool,
  isImplemented,
  skillsWithToolsAvailable,
  type ToolSpec,
} from './index.ts';

const speech = capabilityManifest.parse({
  kind: 'audio.synthesize',
  provider: 'fake',
  model: 'fake-tts-v1',
  description: 'Read a script aloud.',
  effect_class: 'spend',
  unit_cost_usd: 0,
  produces: 'audio/wav',
  input_schema: { type: 'object' },
  required_scopes: ['audio.synthesize'],
});

const connectorTools: ToolSpec[] = [
  {
    name: 'web.fetch',
    description: 'Fetch a page.',
    input_schema: {},
    effect_class: 'read',
    connection_id: 'conn_01J0000000000000000000000',
  },
  {
    name: 'files.write',
    description: 'Write a file.',
    input_schema: {},
    effect_class: 'write_reversible',
    connection_id: 'conn_01J0000000000000000000000',
  },
];

const grants = ['web.fetch', 'files.write', 'audio.synthesize'];

describe('a capability manifest', () => {
  test('spends, because generation costs money', () => {
    expect(speech.effect_class).toBe('spend');
    expect(() => capabilityManifest.parse({ ...speech, effect_class: 'read' })).toThrow();
  });

  test('names what it produces, so the artifact has a type before it exists', () => {
    expect(speech.produces).toBe('audio/wav');
  });

  test('becomes a connector tool that needs an approval and can be verified', () => {
    const tool = capabilityTool(speech);
    expect(tool.name).toBe('audio.synthesize');
    expect(tool.effect_class).toBe('spend');
    expect(tool.requires_approval).toBe(true);
    expect(tool.verify).toBe(true);
  });

  test('only audio.synthesize has an adapter in v0.1, and the enum says the rest out loud', () => {
    expect(isImplemented('audio.synthesize')).toBe(true);
    expect(isImplemented('image.generate')).toBe(false);
    expect(isImplemented('audio.transcribe')).toBe(false);
    expect(isImplemented('code.execute')).toBe(false);
  });
});

describe('the tool catalog', () => {
  test('is connectors and capabilities together, in one stable order', () => {
    const catalog = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [speech],
      grants,
      connectionFor: () => 'conn_generation',
    });
    expect(catalog.map((tool) => tool.name)).toEqual([
      'audio.synthesize',
      'files.write',
      'web.fetch',
    ]);
    const capability = catalog.find((tool) => tool.name === 'audio.synthesize');
    expect(capability?.effect_class).toBe('spend');
    expect(capability?.connection_id).toBe('conn_generation');
  });

  test('a capability outside the attempt grants never appears', () => {
    const catalog = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [speech],
      grants: ['web.fetch', 'files.write'],
    });
    expect(catalog.map((tool) => tool.name)).toEqual(['files.write', 'web.fetch']);
  });

  test('an unavailable capability is absent rather than advertised and refused', () => {
    const catalog = buildToolCatalog({
      connectors: [],
      capabilities: [{ ...speech, available: false }],
      grants,
    });
    expect(catalog).toEqual([]);
  });

  test('a capability with no adapter behind it is not offered either', () => {
    const catalog = buildToolCatalog({
      connectors: [],
      capabilities: [capabilityManifest.parse({ ...speech, kind: 'image.generate' })],
      grants: [...grants, 'image.generate'],
    });
    expect(catalog).toEqual([]);
  });
});

describe('offering a skill', () => {
  const podcast = { frontmatter: { tools: ['web.fetch', 'audio.synthesize', 'files.write'] } };
  const research = { frontmatter: { tools: ['web.fetch'] } };

  test('a skill is offered only when every tool it names exists', () => {
    const withCapability = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [speech],
      grants,
    });
    expect(skillsWithToolsAvailable([podcast, research], withCapability)).toEqual([
      podcast,
      research,
    ]);
  });

  test('without the capability the skill that needs it is not offered at all', () => {
    const without = buildToolCatalog({ connectors: connectorTools, capabilities: [], grants });
    expect(skillsWithToolsAvailable([podcast, research], without)).toEqual([research]);
  });

  test('a skill that names no tools is always offered', () => {
    expect(skillsWithToolsAvailable([{ frontmatter: { tools: [] } }], [])).toHaveLength(1);
  });
});
