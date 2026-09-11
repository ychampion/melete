import { connectorManifest } from '@melete/contracts';
import type { Connector } from './types.ts';

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

  async close(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.connections.values()].map(async (connector) => connector.close?.()),
    );
    this.connections.clear();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
