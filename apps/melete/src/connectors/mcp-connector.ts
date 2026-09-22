import { type Action, jobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import { type McpServerConfig, type McpWorker, openMcpWorker } from './mcp.ts';
import { mcpCredentialAccess, mcpCredentialUrl } from './mcp-credentials.ts';
import type { SealedSecretStore } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** How a connector brings a server up for a call it has already authorized, and lets it go after. */
export type McpSessionHooks = {
  /** Undefined when the session is ready; otherwise why the call is refused without dispatch. */
  ready(): Promise<string | undefined>;
  done(): void;
};

/** Service-side adapter; only the transport receives remote data or launches a worker. */
export function mcpConnector(
  worker: McpWorker,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
  credentials?: ReturnType<typeof mcpCredentialAccess>,
  session?: McpSessionHooks,
): Connector {
  async function granted(action: Action, context: ConnectorContext) {
    const [row] = await sql`select c.scopes, s.audience, j.constraints from connection c
      join space s on s.id = c.space_id
      join job j on j.space_id = s.id and j.id = ${context.job_id}
      where c.id = ${binding.connectionId} and c.space_id = ${binding.spaceId}
        and c.provider = 'mcp' and c.status = 'active'`;
    const tool = worker.tools.find((tool) => tool.name === action.kind);
    return row &&
      tool &&
      row.audience === 'owner' &&
      action.connection_id === binding.connectionId &&
      context.space_id === binding.spaceId &&
      !jobConstraints.parse(row.constraints).public_compartment &&
      [action.kind, ...tool.required_scopes].every((scope) => row.scopes.includes(scope))
      ? row
      : null;
  }
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
      const row = await granted(action, context);
      if (!row) {
        return {
          outcome: 'failed',
          reason: 'MCP owner authority is unavailable',
          retryable: false,
        };
      }
      // A server started on demand starts only for a call that is already authorized.
      const refused = await session?.ready();
      if (refused) return { outcome: 'failed', reason: refused, retryable: false };
      try {
        return await worker.execute(action, {
          ...context,
          audience: row.audience,
          scopes: row.scopes,
        });
      } finally {
        session?.done();
      }
    },
    verify: () => worker.verify(),
    async reconnect(action, context) {
      if (await granted(action, context)) await worker.reconnect();
    },
    ...(credentials
      ? {
          async refreshCredential(action: Action, context: ConnectorContext) {
            if (
              !(await granted(action, context)) ||
              !(await credentials.refresh()) ||
              !(await granted(action, context))
            )
              return false;
            try {
              await worker.reconnect();
            } catch {
              return false;
            }
            return Boolean(await granted(action, context));
          },
        }
      : {}),
    health: () => worker.health(),
    close: () => worker.close(),
  };
}

/** A same-account subprocess has no vault/filesystem isolation on this host. */
export async function openConfiguredMcpConnector(
  config: McpServerConfig,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
  secrets?: SealedSecretStore,
): Promise<Connector> {
  // A container server is opened with its launcher in mcp-stdio.ts; nothing here can start one.
  if (config.endpoint.transport !== 'http') {
    throw new Error('MCP stdio requires an isolated OS launcher; service launch is disabled');
  }
  const [row] = await sql`select secret_ref from connection where id = ${binding.connectionId}`;
  if (row?.secret_ref && !secrets) throw new Error('MCP credential store is unavailable');
  if (row?.secret_ref) mcpCredentialUrl.parse(config.endpoint.url);
  const credentials = secrets
    ? mcpCredentialAccess(sql, secrets, binding, config.endpoint.url)
    : undefined;
  const worker = await openMcpWorker(config, binding, credentials);
  return mcpConnector(worker, binding, sql, credentials);
}
