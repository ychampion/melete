import { type ConnectorTool, connectorManifest } from '@melete/contracts';
import type { Connector } from './types.ts';

/**
 * An in-cell tool is carried out by the runtime and recorded afterwards, so by
 * the time the broker sees its payload the work has already happened. Two
 * things follow, and both are cheaper to catch here than in a ledger nobody can
 * make sense of later.
 *
 * It must declare the shape of that record, because the arguments the model
 * filled in are not the payload the broker will be asked to admit.
 *
 * It must not be a tool anyone could be asked to approve. Approval is a gate in
 * front of an effect; there is no gate in front of something that is over. A
 * connector that wants a person's decision has to ask for it before the cell
 * acts, which means it is not an in-cell tool at all.
 */
function checkInCellTool(tool: ConnectorTool): void {
  if (tool.execution !== 'in_cell') return;
  if (!tool.record_schema) {
    throw new Error(`${tool.name} is carried out in the cell and declares no record schema`);
  }
  if (
    tool.requires_approval ||
    tool.effect_class === 'write_external' ||
    tool.effect_class === 'spend'
  ) {
    throw new Error(
      `${tool.name} is carried out in the cell, so it cannot also require approval: ` +
        'the effect has already happened by the time the broker sees it',
    );
  }
}

/** A connection selects trusted code; payloads cannot select a module or credentials. */
export class ConnectorRegistry {
  private readonly connections = new Map<string, Connector>();

  register(connectionId: string, connector: Connector): this {
    if (!connectionId || this.connections.has(connectionId)) {
      throw new Error(`connection already registered or empty: ${connectionId}`);
    }
    connectorManifest.parse(connector.manifest);
    const names = connector.manifest.tools.map((tool) => tool.name);
    if (new Set(names).size !== names.length) throw new Error('duplicate connector tool');
    for (const tool of connector.manifest.tools) checkInCellTool(tool);
    this.connections.set(connectionId, connector);
    return this;
  }

  get(connectionId: string): Connector | undefined {
    return this.connections.get(connectionId);
  }

  entries(): [string, Connector][] {
    return [...this.connections.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
  }
}
