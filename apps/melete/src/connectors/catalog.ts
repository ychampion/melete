import { REACT_TOOL_NAME, reactToolSchema, type ToolSpec } from '@melete/contracts';
import type { Connector } from './types.ts';

/** The broker-owned reaction tool: no connection, no scope, always in the catalog. */
export const REACT_TOOL: ToolSpec = {
  name: REACT_TOOL_NAME,
  description:
    "React to the owner's latest message with one emoji instead of replying, when it needs only acknowledgement.",
  input_schema: reactToolSchema as unknown as ToolSpec['input_schema'],
  effect_class: 'read',
  connection_id: null,
};

export type ConnectionGrant = { id: string; provider: string; scopes: readonly string[] };
export type ConnectorLookup = { get(id: string): Connector | undefined };

/**
 * One execution backend per space. A space with an active sandbox connection
 * runs its commands there, so the cell's own exec connection is neither
 * offered nor admitted beside it: an agent that picked `exec.run` would
 * otherwise bypass the sandbox the owner configured.
 */
export function supersededExecution(provider: string, activeProviders: Iterable<string>): boolean {
  if (provider !== 'exec') return false;
  for (const active of activeProviders) if (active === 'sandbox') return true;
  return false;
}

/** Only active connection rows enter here; job scopes further narrow their grants. */
export function grantedToolCatalog(
  connections: readonly ConnectionGrant[],
  registry: ConnectorLookup,
  scopes?: readonly string[],
): ToolSpec[] {
  const tools: ToolSpec[] = [structuredClone(REACT_TOOL)];
  const providers = connections.map((connection) => connection.provider);
  for (const connection of connections) {
    const connector = registry.get(connection.id);
    if (
      supersededExecution(connection.provider, providers) ||
      !connector ||
      connector.manifest.provider !== connection.provider ||
      connector.capability?.available === false
    )
      continue;
    for (const tool of connector.manifest.tools) {
      if (
        ![tool.name, ...tool.required_scopes].every(
          (scope) =>
            connection.scopes.includes(scope) && (scopes === undefined || scopes.includes(scope)),
        )
      )
        continue;
      tools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        effect_class: tool.effect_class,
        connection_id: connection.id,
        // The cell needs to know which tools it carries out itself, and
        // the shape of the record it owes the ledger afterwards.
        execution: tool.execution,
        record_schema: tool.record_schema,
      });
    }
  }
  return tools.sort(
    (a, b) =>
      a.name.localeCompare(b.name, 'en') ||
      (a.connection_id ?? '').localeCompare(b.connection_id ?? '', 'en'),
  );
}
