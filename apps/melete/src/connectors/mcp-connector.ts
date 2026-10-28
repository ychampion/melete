import {
  type Action,
  type EntitlementKey,
  IDENTITY_HEADER,
  type JsonObject,
  jobConstraints,
  PAGE_META_KEY,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { BrokerFault } from '../broker/errors.ts';
import type { Query } from '../broker/records.ts';
import { type IdentitySigner, identityAudience } from '../identity/assertion.ts';
import { newId } from '../ids.ts';
import { connectionServesJob } from '../jobs/scopes.ts';
import type { OpenPageInput } from '../pages/service.ts';
import { DEFAULT_GATE_MESSAGE, requireEntitlement } from '../principals/entitlements.ts';
import { type McpServerConfig, type McpWorker, type OpenedPage, openMcpWorker } from './mcp.ts';
import { mcpCredentialAccess, mcpCredentialUrl } from './mcp-credentials.ts';
import { connectionOrigins } from './mcp-ui.ts';
import { reachFetch, spaceReach } from './public-fetch.ts';
import type { SealedSecretStore } from './secrets.ts';
import type { Connector, ConnectorContext } from './types.ts';

/** How a connector brings a server up for a call it has already authorized, and lets it go after. */
export type McpSessionHooks = {
  /** Undefined when the session is ready; otherwise why the call is refused without dispatch. */
  ready(): Promise<string | undefined>;
  done(): void;
};

/**
 * What a connected server's calls may carry beyond the call itself, from the
 * service: the pages it shows, the identity assertion it may ask for, and the
 * entitlements its tools may require.
 */
export type McpCallServices = {
  pages?: {
    /** Where a server reports on its pages: `<base>/pages/<id>/outcome`. */
    reportBase: string;
    reportKey(pageId: string): string;
    open(input: OpenPageInput): Promise<JsonObject>;
  };
  identity?: IdentitySigner;
  /** What the person holds, for the identity assertion. */
  entitlements(sql: Query, principalId: string | null): Promise<readonly string[]>;
  /** What the person is told when a tool requires an entitlement they lack. */
  gateMessage?: string;
};

/**
 * Keeps a server's notes on using its tools on its connection, in the
 * connection's configuration as `server_notes`, so an attempt is told them
 * even before the server next runs. Written only when they changed.
 */
export const keepServerNotes =
  (sql: Sql, connectionId: string) =>
  async ({ instructions }: { instructions: string | null }): Promise<void> => {
    await sql`update connection
      set configuration = case when ${instructions}::text is null
        then configuration - 'server_notes'
        else configuration || jsonb_build_object('server_notes', ${instructions}::text) end
      where id = ${connectionId} and provider = 'mcp'
        and configuration->>'server_notes' is distinct from ${instructions}::text`;
  };

/** The operator's entitlements for one brokered tool name. */
function requiredFor(config: McpServerConfig | undefined, kind: string): readonly EntitlementKey[] {
  const tool = config?.tools.find((entry) => `mcp_${config.id}.${entry.alias}` === kind);
  return tool?.requires_entitlements ?? [];
}

/** Service-side adapter; only the transport receives remote data or launches a worker. */
export function mcpConnector(
  worker: McpWorker,
  binding: { connectionId: string; spaceId: string },
  sql: Sql,
  credentials?: ReturnType<typeof mcpCredentialAccess>,
  session?: McpSessionHooks,
  config?: McpServerConfig,
  services?: McpCallServices,
): Connector {
  async function granted(action: Action, context: ConnectorContext) {
    const [row] = await sql`select c.scopes, c.shared_use, s.audience, s.kind,
        coalesce(s.owner_principal_id, (select id from owner limit 1)) as space_owner_id,
        coalesce(j.principal_id, (select id from owner limit 1)) as principal_id,
        coalesce(j.requested_by_principal_id, j.principal_id, (select id from owner limit 1)) as person_id,
        j.audience as job_audience, j.constraints
      from connection c
      join space s on s.id = c.space_id
      join job j on j.space_id = s.id and j.id = ${context.job_id}
      where c.id = ${binding.connectionId} and c.space_id = ${binding.spaceId}
        and c.provider = 'mcp' and c.status = 'active'`;
    const tool = worker.tools.find((tool) => tool.name === action.kind);
    return row &&
      tool &&
      (row.audience === 'owner' || row.audience === 'space') &&
      // In a room, the server serves only the jobs its sharing names.
      connectionServesJob(
        {
          kind: String(row.kind),
          spaceOwnerId: row.space_owner_id ?? null,
          principalId: row.principal_id ?? null,
          audience: String(row.job_audience),
        },
        String(row.shared_use),
      ) &&
      action.connection_id === binding.connectionId &&
      context.space_id === binding.spaceId &&
      !jobConstraints.parse(row.constraints).public_compartment &&
      [action.kind, ...tool.required_scopes].every((scope) => row.scopes.includes(scope))
      ? row
      : null;
  }

  /**
   * Refuses unless the person the job is for holds what the tool requires.
   * Read from the entitlement table, never from the call: a model cannot talk
   * its way past it.
   */
  const gate = (tx: Query, kind: string, personId: string | null) =>
    requireEntitlement(
      tx,
      personId,
      requiredFor(config, kind),
      services?.gateMessage ?? DEFAULT_GATE_MESSAGE,
    );

  /** Melete's own `_meta` and headers for one call, and what to do with a page it opens. */
  async function extras(action: Action, personId: string | null) {
    const meta: JsonObject = {};
    const headers: Record<string, string> = {};
    const endpoint = config?.endpoint.transport === 'http' ? config.endpoint.url : null;
    const raw = config?.tools.find(
      (entry) => `mcp_${config.id}.${entry.alias}` === action.kind,
    )?.name;
    if (config?.identity && services?.identity && endpoint && personId)
      headers[IDENTITY_HEADER] = services.identity.issue({
        audience: identityAudience(endpoint),
        principalId: personId,
        entitlements: await services.entitlements(sql, personId),
        actionId: action.id,
        tool: raw ?? action.kind,
      });
    const pages = services?.pages;
    if (!pages || !endpoint || !worker.pageUri(action.kind)) return { meta, headers };
    const pageId = newId('cpg');
    const base = (config?.pages?.report_base_url ?? pages.reportBase).replace(/\/+$/, '');
    meta[PAGE_META_KEY] = {
      id: pageId,
      report_url: `${base}/pages/${pageId}/outcome`,
      report_key: pages.reportKey(pageId),
    };
    const allowed = connectionOrigins(endpoint, config?.pages?.origins ?? []);
    return {
      meta,
      headers,
      opened: (page: OpenedPage) =>
        pages.open({
          pageId,
          action,
          connectionId: binding.connectionId,
          spaceId: binding.spaceId,
          serverOrigin: new URL(endpoint).origin,
          allowedOrigins: allowed,
          source: page,
        }),
    };
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
    readOnlyDeclared: (kind) => worker.readOnly.includes(kind),
    // Refused at the proposal, before anyone is asked and before anything is
    // sent: a tool that requires an entitlement the person lacks.
    ...(config?.tools.some((tool) => tool.requires_entitlements?.length)
      ? {
          async prepare(payload: JsonObject, context: ConnectorContext, tx: Query, kind?: string) {
            if (!kind || !requiredFor(config, kind).length) return payload;
            const [job] = await tx`select coalesce(requested_by_principal_id, principal_id,
                (select id from owner limit 1)) as person_id from job where id = ${context.job_id}`;
            await gate(tx, kind, job?.person_id ?? null);
            return payload;
          },
        }
      : {}),
    rawToolName: (kind) => worker.rawNames?.get(kind),
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
      // An entitlement taken away since the proposal stops the call here too.
      try {
        await gate(sql, action.kind, row.person_id ?? null);
      } catch (error) {
        if (!(error instanceof BrokerFault)) throw error;
        return { outcome: 'failed', reason: error.message, retryable: false };
      }
      // A server started on demand starts only for a call that is already authorized.
      const refused = await session?.ready();
      if (refused) return { outcome: 'failed', reason: refused, retryable: false };
      try {
        const extra = await extras(action, row.person_id ?? null);
        return await worker.execute(action, {
          ...context,
          audience: row.audience,
          scopes: row.scopes,
          ...extra,
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
  services?: McpCallServices,
): Promise<Connector> {
  // A container server is opened with its launcher in mcp-stdio.ts; nothing here can start one.
  if (config.endpoint.transport !== 'http') {
    throw new Error('MCP stdio requires an isolated OS launcher; service launch is disabled');
  }
  const [row] = await sql`select secret_ref from connection where id = ${binding.connectionId}`;
  if (row?.secret_ref && !secrets) throw new Error('MCP credential store is unavailable');
  if (row?.secret_ref) mcpCredentialUrl.parse(config.endpoint.url);
  // Only the setup owner's own space may reach a private address, and no space
  // reaches cloud metadata. Every server and token endpoint is resolved, checked
  // and pinned on every request, so a name that later answers with an address
  // out of reach reaches nothing.
  const pinned = reachFetch({ reach: await spaceReach(sql, binding.spaceId) });
  const credentials = secrets
    ? mcpCredentialAccess(sql, secrets, binding, config.endpoint.url, pinned)
    : undefined;
  const worker = await openMcpWorker(config, binding, {
    ...credentials,
    fetch: pinned,
    // Open requests are limited per connection and across the space's connections.
    space: binding.spaceId,
    onSession: keepServerNotes(sql, binding.connectionId),
  });
  return mcpConnector(worker, binding, sql, credentials, undefined, config, services);
}
