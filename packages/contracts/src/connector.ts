/**
 * Connector manifests. A connector declares its tools, what each one costs in
 * effect class, which scopes it needs, and whether it can answer the only
 * question that matters after a timeout: did this actually happen?
 */
import { z } from 'zod';
import { effectClass } from './broker.ts';
import { jsonSchema } from './common.ts';
import { connectionProvider } from './entities.ts';

export const connectorTool = z.object({
  /** Namespaced, for example `email.send`. The catalog shows this verbatim. */
  name: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, 'must be `connector.tool`'),
  description: z.string().min(1).max(400),
  /** JSON Schema for the tool's arguments; carried through to the model catalog. */
  input_schema: jsonSchema,
  effect_class: effectClass,
  required_scopes: z.array(z.string()),
  /**
   * True when `verify(action)` can decide this tool's outcome after an unknown
   * dispatch. A tool with no verify can leave an action `unresolved`, and the
   * docs say so rather than pretending otherwise.
   */
  verify: z.boolean(),
  /** Reversible writes inside the workspace auto-admit; external sends never do. */
  requires_approval: z.boolean().default(false),
});
export type ConnectorTool = z.infer<typeof connectorTool>;

export const credentialRequirement = z.object({
  key: z.string().min(1),
  description: z.string().min(1),
  secret: z.boolean().default(true),
});
export type CredentialRequirement = z.infer<typeof credentialRequirement>;

export const connectorManifest = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  provider: connectionProvider,
  description: z.string().min(1),
  tools: z.array(connectorTool).min(1),
  credentials: z.array(credentialRequirement).default([]),
  /** Whether this connector implements `health()` at all. */
  health: z.boolean().default(true),
});
export type ConnectorManifest = z.infer<typeof connectorManifest>;

export const connectorHealth = z.object({
  status: z.enum(['ok', 'degraded', 'failing']),
  detail: z.string(),
  checked_at: z.string(),
});
export type ConnectorHealth = z.infer<typeof connectorHealth>;

/** Find a tool in a manifest by its fully qualified name. */
export const findTool = (
  manifest: ConnectorManifest,
  name: string,
): ConnectorTool | undefined => manifest.tools.find((t) => t.name === name);

/**
 * Which tools a job may see, given its scopes. Filtering happens in the service
 * before the catalog is built, so an out-of-scope tool is not merely refused at
 * call time, it never appears.
 */
export const toolsInScope = (
  manifest: ConnectorManifest,
  scopes: readonly string[],
): ConnectorTool[] => {
  const held = new Set(scopes);
  return manifest.tools.filter((tool) => tool.required_scopes.every((s) => held.has(s)));
};
