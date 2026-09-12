import { REACT_TOOL_NAME, reactToolSchema, type ToolSpec } from '@melete/contracts';
import type { Connector } from './types.ts';

export type ConnectionGrant = { id: string; provider: string; scopes: readonly string[] };
export type ConnectorLookup = { get(id: string): Connector | undefined };

/** Only active connection rows enter here; job scopes further narrow their grants. */
export function grantedToolCatalog(
  connections: readonly ConnectionGrant[],
  registry: ConnectorLookup,
  scopes?: readonly string[],
): ToolSpec[] {
  const tools: ToolSpec[] = [
    {
      name: REACT_TOOL_NAME,
      description:
        'React to a message with one emoji instead of replying, when the message needs only acknowledgement.',
      input_schema: reactToolSchema as unknown as ToolSpec['input_schema'],
      effect_class: 'read',
      connection_id: null,
    },
  ];
  for (const connection of connections) {
    const connector = registry.get(connection.id);
    if (
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
