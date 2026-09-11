/**
 * Capabilities.
 *
 * A connector reaches something that already exists: a mailbox, a calendar, a
 * folder. A capability makes something that did not: speech from a script, a
 * transcript from audio, an image from a description. The difference that
 * matters to Melete is that a capability call costs money and produces a file,
 * so it is an action of effect class `spend` like any other, with a budget
 * reservation before it and a typed artifact after it.
 *
 * Providers configured in the gateway advertise what they can generate. The
 * tool catalog an attempt sees is connectors, plus the capabilities its grants
 * allow, plus the skills whose tools all exist — so a skill that needs a
 * capability nobody configured is simply not offered, rather than offered and
 * then failing in front of a person.
 *
 * v0.1 implements `audio.synthesize`. The other three are in the enum because
 * the shape is the same and naming them now is cheaper than a migration later;
 * a manifest for one of them is refused until there is an adapter behind it.
 */
import { z } from 'zod';
import { effectClass } from './broker.ts';
import { jsonSchema } from './common.ts';
import type { ConnectorTool } from './connector.ts';
import type { ToolSpec } from './runtime.ts';

export const CAPABILITY_KINDS = [
  'audio.synthesize',
  'audio.transcribe',
  'image.generate',
  'code.execute',
] as const;
export const capabilityKind = z.enum(CAPABILITY_KINDS);
export type CapabilityKind = z.infer<typeof capabilityKind>;

/** What v0.1 has an adapter for. The rest are named, not shipped. */
export const IMPLEMENTED_CAPABILITIES = ['audio.synthesize'] as const;
export const isImplemented = (kind: CapabilityKind): boolean =>
  (IMPLEMENTED_CAPABILITIES as readonly string[]).includes(kind);

/**
 * What a provider says it can do. Cost and effect class come from this trusted
 * configuration, never from a tool argument: a model that could name its own
 * price could spend the budget by asking nicely.
 */
export const capabilityManifest = z.object({
  kind: capabilityKind,
  /** The gateway provider this runs through, for example `fake` or `openai`. */
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(200),
  description: z.string().min(1).max(400),
  /** Generation spends. There is no cheaper honest answer. */
  effect_class: effectClass.refine((value) => value === 'spend', 'a capability spends'),
  /** What one call is expected to cost, from configuration. */
  unit_cost_usd: z.number().nonnegative().max(1000),
  /** The mime type of the artifact a call produces. */
  produces: z.string().min(1).max(120),
  input_schema: jsonSchema,
  required_scopes: z.array(z.string()).default([]),
  /**
   * True when the adapter behind this needs a key the operator has not
   * supplied. An unavailable capability is not advertised and its skill is not
   * offered; it is not advertised and then refused.
   */
  available: z.boolean().default(true),
});
export type CapabilityManifest = z.infer<typeof capabilityManifest>;

export const capabilityListResponse = z.object({
  capabilities: z.array(capabilityManifest),
});

/** A capability as a connector tool, so the broker path is the one that already exists. */
export function capabilityTool(manifest: CapabilityManifest): ConnectorTool {
  return {
    name: manifest.kind,
    description: manifest.description,
    input_schema: manifest.input_schema,
    effect_class: 'spend',
    required_scopes: manifest.required_scopes,
    // The artifact is on disk with a content hash, so "did this happen?" has an
    // answer that does not depend on the provider still being reachable.
    verify: true,
    requires_approval: true,
  };
}

export type CatalogInput = {
  /** Tools from connectors, already filtered by the job's scopes. */
  connectors: readonly ToolSpec[];
  /** Capabilities the gateway advertises. */
  capabilities: readonly CapabilityManifest[];
  /** Scopes this attempt holds. A capability outside them never appears. */
  grants: readonly string[];
  /** The connection each capability runs through, by kind. */
  connectionFor?: (manifest: CapabilityManifest) => string | null;
};

/**
 * Connectors ∪ capabilities, filtered by grants, in a stable order. The union
 * is built once so the catalog an attempt reads and the catalog a skill is
 * checked against cannot disagree.
 */
export function buildToolCatalog(input: CatalogInput): ToolSpec[] {
  const held = new Set(input.grants);
  const fromCapabilities: ToolSpec[] = input.capabilities
    .filter(
      (manifest) =>
        manifest.available &&
        isImplemented(manifest.kind) &&
        [manifest.kind, ...manifest.required_scopes].every((scope) => held.has(scope)),
    )
    .map((manifest) => ({
      name: manifest.kind,
      description: manifest.description,
      input_schema: manifest.input_schema,
      effect_class: 'spend' as const,
      connection_id: input.connectionFor?.(manifest) ?? null,
    }));
  return [...input.connectors, ...fromCapabilities].sort((a, b) =>
    a.name < b.name
      ? -1
      : a.name > b.name
        ? 1
        : (a.connection_id ?? '').localeCompare(b.connection_id ?? '', 'en'),
  );
}

/**
 * A skill is offered only when every tool it names is in the catalog. A skill
 * that tells the model to call something it does not have is a promise the
 * attempt cannot keep, and the person hears about it after the model has
 * already said it would.
 */
export function skillsWithToolsAvailable<T extends { frontmatter: { tools: string[] } }>(
  skills: readonly T[],
  catalog: readonly ToolSpec[],
): T[] {
  const available = new Set(catalog.map((tool) => tool.name));
  return skills.filter((skill) => skill.frontmatter.tools.every((tool) => available.has(tool)));
}
