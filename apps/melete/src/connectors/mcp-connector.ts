import { type Action, jobConstraints } from '@melete/contracts';
import type { Sql } from 'postgres';
import { type McpServerConfig, type McpWorker, openMcpWorker } from './mcp.ts';
import { mcpCredentialAccess, mcpCredentialUrl } from './mcp-credentials.ts';
import { publicOnlyFetch } from './public-fetch.ts';
import type { SealedSecretStore } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** Service-side adapter; only the transport receives remote data or launches a worker. */
export function mcpConnector(
  worker: McpWorker,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
  credentials?: ReturnType<typeof mcpCredentialAccess>,
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
      return worker.execute(action, {
        ...context,
        audience: row.audience,
        scopes: row.scopes,
      });
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
  if (config.endpoint.transport === 'stdio') {
    throw new Error('MCP stdio requires an isolated OS launcher; service launch is disabled');
  }
  const [row] = await sql`select secret_ref from connection where id = ${binding.connectionId}`;
  if (row?.secret_ref && !secrets) throw new Error('MCP credential store is unavailable');
  if (row?.secret_ref) mcpCredentialUrl.parse(config.endpoint.url);
  // Only the setup owner's spaces may reach a private address. Everyone else's
  // server and token endpoint are resolved, checked and pinned on every request,
  // so a name that later answers with an internal address reaches nothing.
  const pinned = (await setupOwnersSpace(sql, binding.spaceId)) ? undefined : publicOnlyFetch();
  const credentials = secrets
    ? mcpCredentialAccess(sql, secrets, binding, config.endpoint.url, pinned)
    : undefined;
  const worker = await openMcpWorker(config, binding, {
    ...credentials,
    ...(pinned ? { fetch: pinned } : {}),
  });
  return mcpConnector(worker, binding, sql, credentials);
}

/**
 * Whether a space belongs to the setup owner, who runs the installation and may
 * point a server at an address inside it. A space that names no owner predates
 * accounts and is the setup owner's, and before setup there is nobody else.
 */
export async function setupOwnersSpace(sql: Sql, spaceId: string): Promise<boolean> {
  const [row] =
    await sql`select o.id is null or coalesce(s.owner_principal_id, o.id) = o.id as setup
    from space s left join lateral (select id from owner order by created_at limit 1) o on true
    where s.id = ${spaceId}`;
  return row?.setup === true;
}
