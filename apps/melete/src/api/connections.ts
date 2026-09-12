import {
  connectionListResponse,
  connectionResponse,
  connectionView,
  createConnectionRequest,
} from '@melete/contracts';
import { and, eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { mcpServerConfig } from '../connectors/mcp.ts';
import { openConfiguredMcpConnector } from '../connectors/mcp-connector.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Connector } from '../connectors/types.ts';
import type { Database } from '../db/client.ts';
import { connection } from '../db/schema.ts';
import { serviceTransaction } from '../db/transaction.ts';
import { newId } from '../ids.ts';
import { ownedSpace, spaceAuthority } from '../principals/authority.ts';
import { ServiceError } from './errors.ts';

function view(row: typeof connection.$inferSelect) {
  return connectionView.parse({
    id: row.id,
    space_id: row.spaceId,
    provider: row.provider,
    label: row.label,
    scopes: row.scopes,
    status: row.status,
    health: row.health,
    setup_state: row.setupState,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

/** Installation is an owner API action; a model cannot select endpoints or declare tool authority. */
export function mountConnections(
  app: Hono,
  deps: { db: Database; sql: Sql; registry: ConnectorRegistry },
) {
  app.get('/connections', async (c) => {
    const rows = await deps.db
      .select()
      .from(connection)
      .where(
        and(
          ownedSpace(connection.spaceId, c.get('owner').id),
          c.req.query('space_id')
            ? eq(connection.spaceId, c.req.query('space_id') ?? '')
            : undefined,
        ),
      )
      .orderBy(connection.id);
    return c.json(connectionListResponse.parse({ connections: rows.map(view) }));
  });
  app.get('/connections/:id', async (c) => {
    const [row] = await deps.db
      .select()
      .from(connection)
      .where(eq(connection.id, c.req.param('id')));
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    return c.json(connectionResponse.parse({ connection: view(row) }));
  });
  app.post('/connections', async (c) => {
    const request = createConnectionRequest.parse(await c.req.json());
    if (request.provider !== 'mcp')
      throw new ServiceError(
        'invalid_request',
        'This installation route currently accepts MCP connections.',
        400,
      );
    if (!request.mcp || request.credentials || request.scopes.length)
      throw new ServiceError(
        'invalid_request',
        'Supply MCP endpoint and operator policy in mcp.',
        400,
      );
    const { url, ...policy } = request.mcp;
    const config = mcpServerConfig.parse({ ...policy, endpoint: { transport: 'http', url } });
    // Named verbs must also be explicitly granted; tool discovery cannot add them for the operator.
    if (
      !config.tools.every((tool) =>
        config.allowed_scopes.includes(`mcp_${config.id}.${tool.alias}`),
      )
    )
      throw new ServiceError(
        'invalid_request',
        'Allowed scopes must include each named MCP tool.',
        400,
      );
    const actor = c.get('owner').id;
    const id = newId('conn');
    await serviceTransaction(deps.db, async (tx) => {
      const access = await spaceAuthority(tx, request.space_id, actor, true);
      if (access.role !== 'owner' || access.space.audience !== config.audience)
        throw new ServiceError(
          'scope_denied',
          'MCP installation requires its owner and matching audience.',
          403,
        );
      const existing = await tx
        .select({ config: connection.configuration })
        .from(connection)
        .where(eq(connection.spaceId, request.space_id));
      if (
        existing.some((row) => (row.config.server as { id?: string } | undefined)?.id === config.id)
      )
        throw new ServiceError(
          'conflict',
          'An MCP installation with this name already exists.',
          409,
        );
      await tx.insert(connection).values({
        id,
        spaceId: request.space_id,
        provider: 'mcp',
        label: request.label,
        scopes: config.allowed_scopes,
        configuration: { server: config },
        status: 'disabled',
        setupState: 'connecting',
      });
    });
    let worker: Connector | undefined;
    try {
      worker = await openConfiguredMcpConnector(
        config,
        { connectionId: id, spaceId: request.space_id },
        deps.sql,
      );
      deps.registry.register(id, worker);
      await serviceTransaction(deps.db, async (tx) => {
        const access = await spaceAuthority(tx, request.space_id, actor, true);
        if (access.role !== 'owner' || access.space.audience !== config.audience)
          throw new ServiceError('scope_denied', 'Installation authority changed.', 403);
        // Registry publication precedes activation so discovery cannot observe an active row without a worker.
        await tx
          .update(connection)
          .set({
            status: 'active',
            setupState: 'connected',
            health: 'ok',
            lastCheckedAt: new Date(),
          })
          .where(eq(connection.id, id));
      });
    } catch {
      if (worker) {
        if (deps.registry.get(id) === worker)
          await deps.registry.remove(id, worker).catch(() => {});
        else await worker.close?.().catch(() => {});
      }
      await deps.db
        .update(connection)
        .set({ status: 'error', setupState: 'error', health: 'failing', lastCheckedAt: new Date() })
        .where(eq(connection.id, id));
    }
    const [row] = await deps.db.select().from(connection).where(eq(connection.id, id));
    if (!row)
      throw new ServiceError('not_found', 'Connection was removed during installation.', 404);
    return c.json(connectionResponse.parse({ connection: view(row) }), 201);
  });
}
