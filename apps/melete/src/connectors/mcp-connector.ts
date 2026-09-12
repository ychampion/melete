import { jobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import { type McpServerConfig, type McpWorker, openMcpWorker } from './mcp.ts';
import type { Connector } from './types.ts';

/** Service-side adapter; only the transport receives remote data or launches a worker. */
export function mcpConnector(
  worker: McpWorker,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
): Connector {
  return {
    manifest: {
      name: 'Operator-installed MCP server',
      provider: 'mcp',
      version: '1.0.0',
      description: 'Brokered tools with operator-declared effects and scopes',
      credentials: [],
      health: true,
      tools: worker.tools,
    },
    catalog: { ...worker.catalog, audience: 'owner' },
    async execute(action, context) {
      // Re-read authority immediately before the transport call. A cached startup
      // audience or scope list cannot authorize a worker after a grant is revoked.
      const [row] = await sql`select c.scopes, s.audience, j.constraints from connection c
        join space s on s.id = c.space_id
        join job j on j.space_id = s.id and j.id = ${context.job_id}
        where c.id = ${binding.connectionId} and c.space_id = ${binding.spaceId}
          and c.provider = 'mcp' and c.status = 'active'`;
      if (!row || jobConstraints.parse(row.constraints).public_compartment) {
        return {
          outcome: 'failed',
          reason: 'MCP owner authority is unavailable',
          retryable: false,
        };
      }
      return worker.execute(action, {
        ...context,
        audience: row.audience,
        scopes: row.scopes,
      });
    },
    verify: () => worker.verify(),
    health: () => worker.health(),
    close: () => worker.close(),
  };
}

/** A same-account subprocess has no vault/filesystem isolation on this host. */
export async function openConfiguredMcpConnector(
  config: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
): Promise<Connector> {
  if (config.endpoint.transport === 'stdio') {
    throw new Error('MCP stdio requires an isolated OS launcher; service launch is disabled');
  }
  const worker = await openMcpWorker(config, binding);
  return mcpConnector(worker, binding, sql);
}
