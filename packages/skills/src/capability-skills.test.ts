/**
 * A skill is offered only when every tool it names exists in this
 * installation's catalog. The podcast skill is the case that makes the rule
 * visible: without a speech capability it is not offered at all, rather than
 * offered and then failing in front of a person after the model has already
 * promised an episode.
 */
import { describe, expect, test } from 'bun:test';
import {
  buildToolCatalog,
  capabilityManifest,
  selectSkills,
  skillsWithToolsAvailable,
  type ToolSpec,
} from '@melete/contracts';
import { loadBuiltInSkills } from './loader.ts';

const { skills } = loadBuiltInSkills();

/**
 * Everything the built-in skills ask for except the capability, so the only
 * thing this installation is missing is the one under test.
 */
const CONNECTOR_TOOLS = [
  ...new Set(
    skills.flatMap((skill) =>
      skill.frontmatter.tools.filter((tool) => tool !== 'audio.synthesize'),
    ),
  ),
].sort();

const connectorTools: ToolSpec[] = CONNECTOR_TOOLS.map((name) => ({
  name,
  description: name,
  input_schema: {},
  effect_class: 'read',
  connection_id: 'conn_01J0000000000000000000000',
}));

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

const grants = [...CONNECTOR_TOOLS, 'audio.synthesize'];
const named = (offered: readonly { frontmatter: { name: string } }[]) =>
  offered.map((skill) => skill.frontmatter.name);

describe('the podcast skill', () => {
  test('is a built-in that loads inside its own 400-token cap', () => {
    const podcast = skills.find((skill) => skill.frontmatter.name === 'make-a-podcast');
    expect(podcast).toBeDefined();
    expect(podcast?.tokens).toBeLessThanOrEqual(400);
    expect(podcast?.frontmatter.tools).toContain('audio.synthesize');
  });

  test('is offered when the speech capability is configured', () => {
    const catalog = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [speech],
      grants,
    });
    expect(catalog.map((tool) => tool.name)).toContain('audio.synthesize');
    expect(named(skillsWithToolsAvailable(skills, catalog))).toContain('make-a-podcast');
  });

  test('is absent when it is not, and the other skills are unaffected', () => {
    const catalog = buildToolCatalog({ connectors: connectorTools, capabilities: [], grants });
    const offered = named(skillsWithToolsAvailable(skills, catalog));
    expect(offered).not.toContain('make-a-podcast');
    expect(offered).toContain('draft-follow-up');
  });

  test('an unavailable capability is the same as no capability', () => {
    const catalog = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [{ ...speech, available: false }],
      grants,
    });
    expect(named(skillsWithToolsAvailable(skills, catalog))).not.toContain('make-a-podcast');
  });

  test('selection still matches on triggers, over the offered set only', () => {
    const without = buildToolCatalog({ connectors: connectorTools, capabilities: [], grants });
    const offeredWithout = skillsWithToolsAvailable(skills, without);
    expect(
      selectSkills('Make a podcast about the heating repair', 'make a podcast', offeredWithout),
    ).toEqual([]);

    const withCapability = buildToolCatalog({
      connectors: connectorTools,
      capabilities: [speech],
      grants,
    });
    const offered = skillsWithToolsAvailable(skills, withCapability);
    const chosen = selectSkills(
      'Make a podcast about the heating repair',
      'make a podcast',
      offered,
    );
    expect(chosen.map((match) => match.skill.frontmatter.name)).toContain('make-a-podcast');
  });
});
