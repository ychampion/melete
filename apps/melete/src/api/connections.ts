import {
  CONNECTION_CHECK_DETAIL,
  CONNECTION_KIND_DESCRIPTORS,
  type ConnectionCheck,
  type ConnectionInstallation,
  connectionCheck,
  connectionCheckResponse,
  connectionInstallation,
  connectionKindListResponse,
  connectionListResponse,
  connectionRequestProblem,
  connectionResponse,
  connectionView,
  createConnectionRequest,
} from '@melete/contracts';
import { and, asc, eq, ne, not, sql as query } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { Sql } from 'postgres';
import { builtinEnvironment, ensureBuiltinConnections } from '../connectors/builtin.ts';
import { CalendarDiscoveryError, discoverCalendar } from '../connectors/caldav-discovery.ts';
import {
  type ConnectionSource,
  type ConnectorFactory,
  connectorFactoryFor,
  connectorOptionsFromEnv,
} from '../connectors/configured.ts';
import { icsFeedTarget } from '../connectors/ics-feed.ts';
import { mcpServerConfig } from '../connectors/mcp.ts';
import { mcpCredentials, mcpCredentialUrl } from '../connectors/mcp-credentials.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import type { Connector } from '../connectors/types.ts';
import type { Database } from '../db/client.ts';
import { connection, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import { ownedSpace, spaceAuthority } from '../principals/authority.ts';
import { ServiceError } from './errors.ts';

export type ConnectionDeps = { db: Database; sql: Sql; registry: ConnectorRegistry; env: Env };

const CHECK_TIMEOUT_MS = 25_000;
/** Procedure evaluation spaces are throwaway and never the space a person means. */
const EVALUATION_SPACE_PATH = 'evaluation/%';

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
    generation: row.generation,
    ...(row.configuration.builtin === undefined ? {} : { builtin: true }),
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

const source = (row: typeof connection.$inferSelect): ConnectionSource => ({
  id: row.id,
  spaceId: row.spaceId,
  provider: row.provider,
  secretRef: row.secretRef,
  configuration: row.configuration,
});

const factoryFor = (deps: ConnectionDeps): ConnectorFactory =>
  connectorFactoryFor(deps.registry, () => connectorOptionsFromEnv(deps.sql, deps.env));

/** A check is a code and the sentence that belongs to it, nothing else. */
const result = (state: ConnectionCheck['status'], code: ConnectionCheck['code']): ConnectionCheck =>
  connectionCheck.parse({
    status: state,
    code,
    detail: CONNECTION_CHECK_DETAIL[code],
    checked_at: new Date().toISOString(),
  });

/**
 * Ask a connector whether its destination answers. Only the connector's own
 * three-way status crosses this function: whatever a transport threw, and
 * whatever sentence a connector wrote, stays behind it.
 */
async function check(connector: Connector | undefined, status: string): Promise<ConnectionCheck> {
  if (status === 'revoked') return result('failing', 'revoked');
  if (!connector) return result('failing', 'not_running');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const health = await Promise.race([
      connector.health(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('check timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    if (health.status === 'ok') return result('ok', 'ok');
    if (health.status === 'degraded') return result('degraded', 'degraded');
    return result('failing', 'unavailable');
  } catch {
    return result('failing', 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Give a space, or every space, the default connections it lacks and publish
 * their connectors at once, so a first conversation already has tools. The work
 * is idempotent, and a failure leaves whatever asked for it untouched: the next
 * start repeats it.
 */
export async function ensureDefaultConnections(deps: ConnectionDeps, spaceId?: string) {
  try {
    const factory = factoryFor(deps);
    for (const created of await ensureBuiltinConnections(
      deps.sql,
      builtinEnvironment(deps.env),
      spaceId,
    )) {
      const connector = await factory.open(created);
      if (connector) factory.register(deps.registry, created.id, connector);
    }
  } catch {
    process.stderr.write('default connections could not be ensured\n');
  }
}

/**
 * A space an account makes by signing up, by being provisioned, or by asking
 * for a shared one is furnished once that request has answered, and only that
 * space: the route names it, so no other space is read or written under the
 * lock. A space the session itself had to make, for an account that had none,
 * is furnished where it is made instead, so the request that made it already
 * reads it furnished.
 */
export function mountDefaultConnections(app: Hono, deps: ConnectionDeps) {
  app.use('*', async (c, next) => {
    await next();
    const made = c.get('createdSpaceId');
    if (made) await ensureDefaultConnections(deps, made);
  });
}

/** Installation is an owner API action; a model cannot select endpoints or declare tool authority. */
export function mountConnections(app: Hono, deps: ConnectionDeps) {
  const factory = factoryFor(deps);
  const secrets = factory.secrets;

  app.get('/connection-kinds', (c) =>
    c.json(connectionKindListResponse.parse({ kinds: CONNECTION_KIND_DESCRIPTORS })),
  );
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

  app.post('/connections/:id/health', async (c) => {
    const id = c.req.param('id');
    const [row] = await deps.db.select().from(connection).where(eq(connection.id, id));
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    if ((await spaceAuthority(deps.db, row.spaceId, c.get('owner').id)).role !== 'owner')
      throw new ServiceError('scope_denied', 'Connection is not accessible.', 403);
    let connector = deps.registry.get(id);
    let opened: Connector | undefined;
    // An installation whose first test failed has no connector yet; a test is how it gets one.
    if (!connector && row.status === 'error') {
      opened = await factory.open(source(row)).catch(() => undefined);
      connector = opened;
    }
    const outcome = await check(connector, row.status);
    const unchanged = and(eq(connection.id, id), eq(connection.generation, row.generation));
    if (row.status !== 'revoked')
      await deps.db
        .update(connection)
        .set({ health: outcome.status, lastCheckedAt: new Date(outcome.checked_at) })
        .where(unchanged);
    if (opened) {
      let published = false;
      if (outcome.status !== 'failing' && !deps.registry.get(id)) {
        // Registry publication precedes activation so discovery cannot observe an active row without a worker.
        factory.register(deps.registry, id, opened);
        const rows = await deps.db
          .update(connection)
          .set({ status: 'active', setupState: 'connected' })
          .where(and(unchanged, eq(connection.status, 'error')))
          .returning({ id: connection.id });
        published = rows.length === 1;
        if (!published) {
          await deps.registry.remove(id, opened).catch(() => {});
          factory.mailers.delete(id);
        }
      }
      if (!published && deps.registry.get(id) !== opened) await opened.close?.().catch(() => {});
    }
    const [current] = await deps.db.select().from(connection).where(eq(connection.id, id));
    if (!current) throw new ServiceError('not_found', 'Connection not found.', 404);
    return c.json(connectionCheckResponse.parse({ connection: view(current), check: outcome }));
  });

  app.post('/connections', async (c) => {
    const parsed = createConnectionRequest.safeParse(await c.req.json());
    // The person is told which field to fix, in the words the form uses for it.
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    const request = parsed.data;
    const resolved = connectionInstallation(request);
    if (!resolved.ok) throw new ServiceError('invalid_request', resolved.error, 400);
    const installation = resolved.value;
    // Everything but an MCP server without a token has something to seal.
    if ((installation.kind !== 'mcp' || installation.credentials) && !factory.options.masterKey)
      throw new ServiceError(
        'sealing_unavailable',
        'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
        409,
      );
    const actor = c.get('owner').id;
    const spaceId = request.space_id ?? (await personalSpace(deps.db, actor));
    // Authority is settled first, so no address in the request is resolved and
    // no connector is opened on the word of someone who may not install here.
    await requireInstaller(deps.db, spaceId, actor, installation.kind);
    const id = newId('conn');
    const stored = await storedShape(installation, id, spaceId, factory);

    const generation = await serviceTransaction(deps.db, async (tx) => {
      await requireInstaller(tx, spaceId, actor, installation.kind, true);
      if (installation.kind === 'mcp') {
        // A removed installation keeps its row for the ledger but not its short
        // name, so the same server can be installed again with a new credential.
        const existing = await tx
          .select({ config: connection.configuration })
          .from(connection)
          .where(and(eq(connection.spaceId, spaceId), ne(connection.status, 'revoked')));
        if (
          existing.some(
            (row) =>
              (row.config.server as { id?: string } | undefined)?.id === installation.config.id,
          )
        )
          throw new ServiceError(
            'conflict',
            'An MCP installation with this name already exists.',
            409,
          );
      }
      const [created] = await tx
        .insert(connection)
        .values({
          id,
          spaceId,
          provider: installation.provider,
          label: request.label,
          scopes: stored.scopes,
          secretRef: stored.secret ? await secrets.put(spaceId, stored.secret) : null,
          configuration: stored.configuration,
          status: 'disabled',
          setupState: 'connecting',
        })
        .returning({ generation: connection.generation });
      if (!created) throw new Error('Connection installation was not created');
      return created.generation;
    });
    // A lifecycle change during the handshake owns the newer state, on both success and failure.
    const stillInstalling = and(
      eq(connection.id, id),
      eq(connection.generation, generation),
      eq(connection.status, 'disabled'),
      eq(connection.setupState, 'connecting'),
    );
    let worker: Connector | undefined;
    let outcome: ConnectionCheck | undefined;
    try {
      const [installed] = await deps.db.select().from(connection).where(eq(connection.id, id));
      if (!installed) throw new Error('Connection was removed during installation');
      worker = await factory.open(source(installed));
      // An MCP worker proved itself by completing its handshake; every other kind is asked once.
      outcome =
        installation.kind === 'mcp' && worker
          ? result('ok', 'ok')
          : await check(worker, 'disabled');
      if (outcome.status === 'failing' || !worker) throw new Error('Connection test failed');
      factory.register(deps.registry, id, worker);
      const health = outcome.status;
      const checkedAt = new Date(outcome.checked_at);
      await serviceTransaction(deps.db, async (tx) => {
        const access = await spaceAuthority(tx, spaceId, actor, true);
        if (access.role !== 'owner' || access.space.audience !== 'owner')
          throw new ServiceError('scope_denied', 'Installation authority changed.', 403);
        // Registry publication precedes activation so discovery cannot observe an active row without a worker.
        const [published] = await tx
          .update(connection)
          .set({ status: 'active', setupState: 'connected', health, lastCheckedAt: checkedAt })
          .where(stillInstalling)
          .returning({ id: connection.id });
        if (!published)
          throw new ServiceError('generation_conflict', 'Installation authority changed.');
      });
    } catch {
      if (worker) {
        if (deps.registry.get(id) === worker)
          await deps.registry.remove(id, worker).catch(() => {});
        else await worker.close?.().catch(() => {});
      }
      factory.mailers.delete(id);
      // Opening failed: the destination did not answer. Opened but never published: nothing is running.
      if (outcome?.status !== 'failing')
        outcome = result('failing', worker ? 'not_running' : 'unavailable');
      await deps.db
        .update(connection)
        .set({ status: 'error', setupState: 'error', health: 'failing', lastCheckedAt: new Date() })
        .where(stillInstalling);
    }
    const [row] = await deps.db.select().from(connection).where(eq(connection.id, id));
    if (!row)
      throw new ServiceError('not_found', 'Connection was removed during installation.', 404);
    if (row.generation !== generation)
      throw new ServiceError('generation_conflict', 'Connection changed during installation.');
    return c.json(connectionResponse.parse({ connection: view(row), check: outcome }), 201);
  });
}

/**
 * Installing is the owner's own act, in a space whose audience is the owner
 * alone. The same judgement is made before anything in the request is acted on
 * and again under the lock that writes the row.
 */
async function requireInstaller(
  reader: Database | Transaction,
  spaceId: string,
  actor: string,
  kind: ConnectionInstallation['kind'],
  lock = false,
) {
  const access = await spaceAuthority(reader, spaceId, actor, lock);
  if (access.role !== 'owner' || access.space.audience !== 'owner')
    throw new ServiceError(
      'scope_denied',
      kind === 'mcp'
        ? 'MCP installation requires its owner and matching audience.'
        : 'Installing a connection requires the owner of an owner-audience space.',
      403,
    );
  return access;
}

/** The space a request means when it names none: the caller's own first personal space. */
async function personalSpace(db: Database, actor: string): Promise<string> {
  const [row] = await db
    .select({ id: space.id })
    .from(space)
    .where(
      and(
        eq(space.kind, 'personal'),
        ownedSpace(space.id, actor),
        not(query`${space.gitPath} like ${EVALUATION_SPACE_PATH}`),
      ),
    )
    .orderBy(asc(space.createdAt), asc(space.id))
    .limit(1);
  if (!row) throw new ServiceError('invalid_request', 'Name the space to install into.', 400);
  return row.id;
}

/**
 * What the row will hold. Everything secret goes to the sealed store and the
 * configuration keeps only what is safe to read back from a database dump of
 * that column: endpoints and account names, never a password, token or feed address.
 */
async function storedShape(
  installation: ConnectionInstallation,
  id: string,
  spaceId: string,
  factory: ConnectorFactory,
): Promise<{ scopes: string[]; secret: string | null; configuration: Record<string, unknown> }> {
  if (installation.kind === 'mcp') {
    const { url, ...policy } = installation.config;
    const config = mcpServerConfig.parse({ ...policy, endpoint: { transport: 'http', url } });
    const credential = installation.credentials
      ? mcpCredentials.parse(installation.credentials)
      : undefined;
    if (credential) mcpCredentialUrl.parse(url);
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
    return {
      scopes: config.allowed_scopes,
      secret: credential ? JSON.stringify(credential) : null,
      configuration: { server: config },
    };
  }
  // A calendar service's address is enough: the calendar itself is found with
  // the account's own credential, and only its address is stored.
  if (installation.kind === 'caldav' && installation.config.server_url) {
    const { server_url: serverUrl, ...rest } = installation.config;
    try {
      const found = await discoverCalendar({
        serverUrl,
        username: rest.username,
        password: installation.credentials.password,
        allowInsecureLocalForTests: factory.options.insecureLocalFixtures === true,
      });
      installation.config = { username: rest.username, calendar_url: found.calendar_url };
    } catch (error) {
      throw new ServiceError(
        'invalid_request',
        error instanceof CalendarDiscoveryError
          ? error.message
          : 'The calendar service could not be reached. Check the address and try again.',
        400,
      );
    }
  }
  const shape =
    installation.kind === 'mail'
      ? {
          secret: installation.credentials.password,
          configuration: { kind: 'mail', mail: installation.config },
        }
      : installation.kind === 'caldav'
        ? {
            secret: installation.credentials.password,
            configuration: { kind: 'caldav', caldav: installation.config },
          }
        : { secret: installation.config.url, configuration: { kind: 'ics' } };
  // A feed's address is sealed before the connector ever sees it, so it is checked here. A name
  // that does not resolve right now is left to the first test, which keeps the row in error.
  if (installation.kind === 'ics') {
    const target = await icsFeedTarget(
      installation.config.url,
      factory.options.insecureLocalFixtures === true,
    );
    if (!target.usable && target.reason === 'refused')
      throw new ServiceError(
        'invalid_request',
        'A calendar feed must be a public HTTPS address.',
        400,
      );
  }
  // Construct once before anything is written, so an endpoint the connector
  // would refuse is a plain 400 and never a stored row or a sealed secret.
  try {
    const probe = await factory.open({
      id,
      spaceId,
      provider: installation.provider,
      secretRef: 'pending',
      configuration: shape.configuration,
    });
    if (!probe) throw new Error('No connector');
    await probe.close?.();
  } catch {
    throw new ServiceError(
      'invalid_request',
      'This service cannot use that endpoint. Mail and calendar endpoints must use TLS.',
      400,
    );
  }
  return { scopes: installation.scopes, ...shape };
}
