import {
  ACCOUNT_CATALOG,
  accountSignInAvailability,
  accountSignInRequest,
  accountSignInStart,
  accountSignInStatus,
  asksFirst,
  CONNECTION_CHECK_DETAIL,
  CONNECTION_KIND_DESCRIPTORS,
  type ConnectionCatalogEntry,
  type ConnectionCheck,
  type ConnectionInstallation,
  type ConnectionKindDescriptor,
  type CreateConnectionRequest,
  connectionCheck,
  connectionCheckResponse,
  connectionInstallation,
  connectionKindListResponse,
  connectionListResponse,
  connectionRequestProblem,
  connectionResponse,
  connectionView,
  createConnectionRequest,
  type DiscoveredMcpTool,
  DRIVE_CONSENT_WORDS,
  describePlugin,
  installPluginRequest,
  installPluginResponse,
  MAX_DISCOVERED_TOOLS,
  MCP_CATALOG,
  type McpCatalogEntry,
  managedSignInRequest,
  managedSignInStart,
  mcpCatalogConfig,
  mcpCatalogEntry,
  mcpSignInInstall,
  mcpSignInRequest,
  mcpSignInStart,
  mcpSignInStatus,
  mcpToolDiscovery,
  mcpToolDiscoveryRequest,
  PLUGIN_CATALOG,
  pluginEntry,
  pluginInstallation,
  pluginListResponse,
  suggestedEffect,
} from '@melete/contracts';
import { and, asc, eq, ne, not, sql as query } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { Sql } from 'postgres';
import {
  type AccountGrant,
  type AccountProviderName,
  AccountSignIns,
  SignInFailure,
} from '../connectors/account-sign-in.ts';
import { builtinEnvironment, ensureBuiltinConnections } from '../connectors/builtin.ts';
import { CalendarDiscoveryError, discoverCalendar } from '../connectors/caldav-discovery.ts';
import {
  type ComposioAccount,
  ComposioFault,
  type ComposioToolkit,
} from '../connectors/composio.ts';
import {
  type ConnectionSource,
  type ConnectorFactory,
  connectorFactoryFor,
  connectorOptionsFromEnv,
} from '../connectors/configured.ts';
import { asConnectorFault, ConnectorFaultError } from '../connectors/faults.ts';
import { googleProvider } from '../connectors/google.ts';
import { icsFeedTarget } from '../connectors/ics-feed.ts';
import {
  managedAccountInUse,
  queueManagedRemoval,
  settleManagedRemoval,
} from '../connectors/managed-accounts.ts';
import { type ManagedGrant, ManagedSignIns } from '../connectors/managed-sign-in.ts';
import {
  discoverMcpServerTools,
  listMcpServerTools,
  type McpToolDefinition,
  mcpOpenFailure,
  mcpServerConfig,
} from '../connectors/mcp.ts';
import { catalogAppMissing, RETURN_ADDRESS_NEEDED } from '../connectors/mcp-catalog-ready.ts';
import { mcpCredentials, mcpCredentialUrl } from '../connectors/mcp-credentials.ts';
import { clientMetadataDocument, McpSignInFailure } from '../connectors/mcp-oauth.ts';
import { McpSignIns } from '../connectors/mcp-sign-in.ts';
import { microsoftProvider } from '../connectors/microsoft.ts';
import {
  asFetch,
  isPublicEndpoint,
  outOfReach,
  type Reach,
  reachFetch,
  spaceReach,
  UNREACHABLE,
} from '../connectors/public-fetch.ts';
import type { ConnectorRegistry } from '../connectors/registry.ts';
import { PostgresSecretRepository } from '../connectors/secrets.ts';
import type { SignedInCredential } from '../connectors/signed-in.ts';
import { TwilioClient, TwilioFailure } from '../connectors/twilio.ts';
import type { Connector } from '../connectors/types.ts';
import type { Database } from '../db/client.ts';
import { connection, owner, space } from '../db/schema.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { COMMAND_LINE_SERVICE, commandLineAccount } from '../egress/adapters/accounts.ts';
import { awsAccount, awsAdapterConfig } from '../egress/adapters/aws.ts';
import { awsSecret } from '../egress/aws-session.ts';
import type { Env } from '../env.ts';
import { newId } from '../ids.ts';
import { signInStore } from '../ops/signin-store.ts';
import { ownedSpace, spaceAuthority } from '../principals/authority.ts';
import { MULTIPLAYER_UNAVAILABLE, multiplayerEnabled } from '../rooms/preview.ts';
import {
  checkSandboxConfiguration,
  createSandboxProvider,
  probeSandboxProvider,
  sandboxCredentialValue,
} from '../sandbox/connection.ts';
import { SandboxRefusal } from '../sandbox/manifest.ts';
import { SMS_INBOUND_LIMITED, SMS_INBOUND_NEEDS, smsWebhookUrl } from '../sms/inbox.ts';
import { ServiceError } from './errors.ts';
import type { RequestSource } from './listener.ts';

export type ConnectionDeps = { db: Database; sql: Sql; registry: ConnectorRegistry; env: Env };

/**
 * Kinds only this service installs. A sign-in earns their credential, so no
 * request to `POST /connections` can carry one. Mail keeps the `imap` provider
 * and a calendar the `caldav` one, so everything that finds a mailbox or a
 * calendar by provider finds these too. A Google Drive is a `drive`.
 */
const ACCOUNT_KINDS = {
  google: { mail: 'gmail', calendar: 'google_calendar', documents: 'google_drive' },
  microsoft: { mail: 'outlook_mail', calendar: 'outlook_calendar', documents: null },
} as const;
type AccountInstallation = {
  account: string;
  credential: SignedInCredential;
  scopes: string[];
} & (
  | { kind: 'gmail' | 'outlook_mail'; provider: 'imap' }
  | { kind: 'google_calendar' | 'outlook_calendar'; provider: 'caldav' }
  | { kind: 'google_drive'; provider: 'drive' }
);
/** A Google account signed in through Composio: no secret here, only which account it is. */
type ManagedInstallation = {
  managed: true;
  account: string;
  scopes: string[];
  connectedAccountId: string;
} & (
  | { kind: 'gmail'; provider: 'imap' }
  | { kind: 'google_calendar'; provider: 'caldav' }
  | { kind: 'google_drive'; provider: 'drive' }
);
type Installation = ConnectionInstallation | AccountInstallation | ManagedInstallation;
const signedIn = (installation: Installation): installation is AccountInstallation =>
  'credential' in installation;
const managedInstallation = (installation: Installation): installation is ManagedInstallation =>
  'managed' in installation;
/** What a connection signed in through Composio keeps: the account it acts for, never a token. */
const managedConfiguration = (kind: string, account: string, connectedAccountId: string) => ({
  kind,
  account,
  via: 'composio',
  connected_account_id: connectedAccountId,
});
/** What the connect screen says about a Google sign-in through Composio. */
export const COMPOSIO_NOTE =
  'Composio handles this sign-in and keeps the Google access. Your mail, calendar and Drive reach Melete through Composio.';
type ConnectionResponse = ReturnType<typeof connectionResponse.parse>;

const CHECK_TIMEOUT_MS = 25_000;
/** Procedure evaluation spaces are throwaway and never the space a person means. */
const EVALUATION_SPACE_PATH = 'evaluation/%';

function view(row: typeof connection.$inferSelect, readingNote?: string | null) {
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
    ...(Array.isArray(row.configuration.needs_scope) && row.configuration.needs_scope.length
      ? { needs_scope: row.configuration.needs_scope }
      : {}),
    shared_use: row.sharedUse,
    // The account a command-line connection acts as, found when it was connected.
    ...(row.provider === 'command_line' && typeof row.configuration.account === 'string'
      ? { account: row.configuration.account }
      : {}),
    ...(row.configuration.via === 'composio' ? { via: 'composio' } : {}),
    ...(readingNote ? { reading_note: readingNote.slice(0, 400) } : {}),
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

/**
 * Why a connector could not be opened, as a check code. A remote MCP server
 * that answers its first request with 401 or 403 is asking for a sign-in, not
 * reporting a broken service, so it is told apart from a destination that did
 * not answer at all.
 */
function openFailure(error: unknown, provider: string): ConnectionCheck['code'] {
  if (provider !== 'mcp') return 'unavailable';
  const fault = asConnectorFault(error);
  if (fault?.kind === 'expired_credential' || fault?.kind === 'revoked_credential')
    return 'needs_sign_in';
  // Said as what went wrong: nothing answered, what answered is not an MCP
  // server, or the server lacks a tool the installation names.
  return mcpOpenFailure(error) ?? 'unavailable';
}

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
    return result(
      'failing',
      health.reason === 'credential_refused' || health.reason === 'sign_in_required'
        ? health.reason
        : 'unavailable',
    );
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

/** How long a list of connections waits to learn whether one runs, before showing it as it is. */
const LIVENESS_WAIT_MS = 3_000;

/**
 * Whether an active connection has a connector running on this instance. One
 * installed through another instance may not be open here yet, so it is opened
 * now, as the signal poller opens one when it is first due, and kept. Only a
 * row this service cannot run at all (its provider's settings are missing, or
 * it refused to open) is `not_running`; one still opening after a short wait
 * is `unknown`, and its open carries on and is kept.
 */
export function connectorLiveness(deps: ConnectionDeps) {
  const factory = factoryFor(deps);
  const opening = new Map<string, Promise<'running' | 'not_running'>>();
  const open = (row: typeof connection.$inferSelect) => {
    const pending = opening.get(row.id);
    if (pending) return pending;
    const started = (async () => {
      const opened = await factory.open(source(row)).catch(() => undefined);
      if (!opened) return 'not_running' as const;
      if (deps.registry.get(row.id)) await opened.close?.().catch(() => {});
      else factory.register(deps.registry, row.id, opened);
      return 'running' as const;
    })().finally(() => opening.delete(row.id));
    opening.set(row.id, started);
    return started;
  };
  return async (
    row: typeof connection.$inferSelect,
  ): Promise<'running' | 'not_running' | 'unknown'> => {
    if (deps.registry.get(row.id)) return 'running';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        open(row),
        new Promise<'unknown'>((settle) => {
          timer = setTimeout(() => settle('unknown'), LIVENESS_WAIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
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
  // A room's own accounts are installed only while rooms are switched on.
  const multiplayer = multiplayerEnabled(deps.env);
  const installer = async (...args: Parameters<typeof requireInstaller>) => {
    const access = await requireInstaller(...args);
    if (!multiplayer && access.space.kind === 'shared')
      throw new ServiceError(MULTIPLAYER_UNAVAILABLE.code, MULTIPLAYER_UNAVAILABLE.message, 404);
    return access;
  };
  const factory = factoryFor(deps);
  const secrets = factory.secrets;

  /** Where a catalog app's server is: the catalog's address, unless a test replaced it. */
  const catalogUrl = (entry: McpCatalogEntry) =>
    factory.options.mcpCatalogUrls?.[entry.id] ?? entry.url;
  /**
   * The client an app's sign-in needs when it takes no other, from the
   * operator's settings: undefined when it needs none, null when it is unset.
   */
  const catalogClient = (entry: McpCatalogEntry) => {
    if (!entry.client) return undefined;
    const settings = deps.env as unknown as Record<string, string | undefined>;
    const clientId = settings[entry.client.id_setting];
    const clientSecret = settings[entry.client.secret_setting];
    return clientId && clientSecret ? { client_id: clientId, client_secret: clientSecret } : null;
  };

  /** Filled in as each provider's sign-in is mounted, below. */
  const accountSignIns: Partial<Record<AccountProviderName, AccountSignIns<ConnectionResponse>>> =
    {};

  /**
   * Everything a person can connect here, and whether each is offered now: a
   * sign-in needs its provider's client and an address to return to. Why one
   * is not offered is said in plain words; what to set to offer it is for the
   * operator, the installation's owner, alone.
   */
  const catalog = (
    kinds: ConnectionKindDescriptor[],
    operator: boolean,
    /** The address the person's browser opened Melete at, when the trusted proxy said. */
    webOrigin: string | undefined,
  ): ConnectionCatalogEntry[] => {
    const unavailable = (reason: string, hint: string | undefined) =>
      hint === undefined
        ? {}
        : { unavailable_reason: reason, ...(operator ? { setup_hint: hint } : {}) };
    const accounts = ACCOUNT_CATALOG.map((entry): ConnectionCatalogEntry => {
      // With a Composio key, Google signs in through Composio; Microsoft keeps its own sign-in.
      if (entry.provider === 'google' && factory.options.composio) {
        const hint = managedSignIns.redirectUri() ? undefined : RETURN_ADDRESS_NEEDED;
        return {
          id: entry.id,
          title: entry.title,
          description: entry.description,
          covers: [...entry.covers],
          connect: {
            method: 'managed_sign_in',
            provider: 'google',
            via: 'composio',
            start: '/managed-sign-ins',
            note: COMPOSIO_NOTE,
          },
          available: hint === undefined,
          ...unavailable(`Signing in with ${entry.title} is not set up on this Melete yet.`, hint),
        };
      }
      const hint = !factory.options[entry.provider]
        ? `Signing in with ${entry.title} needs its OAuth client. Set ${ACCOUNT_SETTINGS[entry.provider]}.`
        : !accountSignIns[entry.provider]?.redirectUri()
          ? RETURN_ADDRESS_NEEDED
          : undefined;
      return {
        id: entry.id,
        title: entry.title,
        description: entry.description,
        covers: [...entry.covers],
        connect: {
          method: 'sign_in',
          provider: entry.provider,
          start: `/${entry.provider}-sign-ins`,
          issuer: entry.issuer,
          scopes: entry.scopes.map((scope) => ({ ...scope })),
        },
        available: hint === undefined,
        ...unavailable(`Signing in with ${entry.title} is not set up on this Melete yet.`, hint),
      };
    });
    const returnTo = signIns.redirectUri(webOrigin);
    const servers = MCP_CATALOG.map((entry): ConnectionCatalogEntry => {
      const missing = catalogAppMissing(entry, returnTo, Boolean(catalogClient(entry)));
      return {
        id: entry.id,
        title: entry.title,
        description: entry.description,
        covers: ['tools'],
        connect: {
          method: 'mcp_sign_in',
          url: catalogUrl(entry),
          suggested_id: entry.id,
          start: '/mcp-sign-ins',
          tools: entry.tools.map((tool) => ({
            label: tool.label,
            effect_class: tool.effect_class,
            asks_first: asksFirst(tool.effect_class),
          })),
        },
        available: missing === undefined,
        ...(missing ? unavailable(missing.reason, missing.hint) : {}),
        ...(entry.warning ? { warning: entry.warning } : {}),
      };
    });
    const forms = kinds.map(
      (kind): ConnectionCatalogEntry => ({
        id: kind.id,
        title: kind.title,
        description: kind.description,
        covers: [KIND_COVERS[kind.kind]],
        connect: { method: 'form', kind_id: kind.id },
        available: true,
        // Texts can always be sent; receiving them needs an address Twilio can
        // reach. What to set is for the operator alone, as with sign-ins.
        ...(kind.kind === 'sms' && !smsWebhookUrl(deps.env.MELETE_PUBLIC_URL, 'conn_x')
          ? {
              limited_reason: SMS_INBOUND_LIMITED,
              ...(operator ? { setup_hint: SMS_INBOUND_NEEDS } : {}),
            }
          : {}),
      }),
    );
    return [...accounts, ...servers, ...forms];
  };

  // A kind this service cannot run is not offered: stdio servers need an isolating launcher.
  app.get('/connection-kinds', async (c) => {
    const kinds = CONNECTION_KIND_DESCRIPTORS.filter(
      (kind) => kind.kind !== 'mcp_stdio' || factory.options.stdioLauncher,
    );
    const [installation] = await deps.db.select({ id: owner.id }).from(owner).limit(1);
    const operator = installation !== undefined && installation.id === c.get('owner').id;
    return c.json(
      connectionKindListResponse.parse({
        kinds,
        catalog: catalog(kinds, operator, webOriginOf(c)),
      }),
    );
  });
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
    const notes = await readingNotes(
      deps.sql,
      rows.map((row) => row.id),
    );
    return c.json(
      connectionListResponse.parse({
        connections: rows.map((row) => view(row, notes.get(row.id))),
      }),
    );
  });
  app.get('/connections/:id', async (c) => {
    const [row] = await deps.db
      .select()
      .from(connection)
      .where(eq(connection.id, c.req.param('id')));
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    const notes = await readingNotes(deps.sql, [row.id]);
    return c.json(connectionResponse.parse({ connection: view(row, notes.get(row.id)) }));
  });

  /**
   * Test a connection again, and give one whose earlier test failed its
   * connector when this test passes.
   */
  const retest = async (row: typeof connection.$inferSelect) => {
    const id = row.id;
    let connector = deps.registry.get(id);
    let opened: Connector | undefined;
    let refused: ConnectionCheck['code'] | undefined;
    // An installation whose first test failed has no connector yet; a test is how it gets one.
    if (!connector && row.status === 'error') {
      opened = await factory.open(source(row)).catch((error: unknown) => {
        refused = openFailure(error, row.provider);
        return undefined;
      });
      connector = opened;
    }
    // A connector that could not be opened says why, rather than that none is running.
    const outcome = refused ? result('failing', refused) : await check(connector, row.status);
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
    return { connection: current, check: outcome };
  };

  app.post('/connections/:id/health', async (c) => {
    const id = c.req.param('id');
    const [row] = await deps.db.select().from(connection).where(eq(connection.id, id));
    if (!row) throw new ServiceError('not_found', 'Connection not found.', 404);
    if ((await spaceAuthority(deps.db, row.spaceId, c.get('owner').id)).role !== 'owner')
      throw new ServiceError('scope_denied', 'Connection is not accessible.', 403);
    const tested = await retest(row);
    return c.json(
      connectionCheckResponse.parse({ connection: view(tested.connection), check: tested.check }),
    );
  });

  /** One installation, whether its request was written out or built from a plugin entry. */
  const install = async (
    actor: string,
    request: CreateConnectionRequest,
    plugin?: { id: string; version: string; values: Record<string, string> },
    catalogId?: string,
  ) => {
    const resolved = connectionInstallation(request);
    if (!resolved.ok) throw new ServiceError('invalid_request', resolved.error, 400);
    return installResolved(
      actor,
      request.space_id,
      request.label,
      resolved.value,
      plugin,
      catalogId,
    );
  };

  const installResolved = async (
    actor: string,
    requestedSpace: string | undefined,
    label: string,
    installation: Installation,
    plugin?: { id: string; version: string; values: Record<string, string> },
    /** The catalog entry it is connected from, kept so the app is shown as that app. */
    catalogId?: string,
  ) => {
    // Everything but an MCP server without a token or secret variables has something to seal.
    const seals = managedInstallation(installation)
      ? false
      : installation.kind === 'mcp'
        ? Boolean(installation.credentials)
        : installation.kind === 'mcp_stdio'
          ? installation.config.secret_env.length > 0
          : true;
    if (seals && !factory.options.masterKey)
      throw new ServiceError(
        'sealing_unavailable',
        'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
        409,
      );
    const spaceId = requestedSpace ?? (await personalSpace(deps.db, actor));
    // Authority is settled first, so no address in the request is resolved and
    // no connector is opened on the word of someone who may not install here.
    await installer(deps.db, spaceId, actor, installation.kind);
    // An address outside the setup owner's own space must be public; the
    // connector holds it to that again on every connection it makes.
    const reach = await spaceReach(deps.sql, spaceId);
    if (installation.kind === 'mcp' && reach === 'public') {
      const tokenUrl = installation.credentials?.token_url;
      for (const address of [installation.config.url, ...(tokenUrl ? [tokenUrl] : [])])
        if (!(await isPublicEndpoint(address)))
          throw new ServiceError(
            'address_not_reachable',
            `${UNREACHABLE} An MCP server and its token endpoint must be at public addresses.`,
            400,
          );
    }
    // A mail server or calendar service is checked again, and pinned, on every
    // connection; a name that does not resolve yet is left to the first test,
    // as a feed's is.
    const hosts =
      installation.kind === 'mail'
        ? [installation.config.imap.host, installation.config.smtp.host]
        : installation.kind === 'caldav'
          ? [installation.config.calendar_url, installation.config.server_url]
              .filter((address): address is string => !!address)
              .map((address) => new URL(address).hostname)
          : [];
    for (const host of hosts)
      if (await outOfReach(host, reach))
        throw new ServiceError(
          'address_not_reachable',
          reach === 'public' ? `${UNREACHABLE} It must be at a public address.` : UNREACHABLE,
          400,
        );
    const id = newId('conn');
    const stored = await storedShape(
      installation,
      id,
      spaceId,
      factory,
      reach,
      deps.env.MELETE_PUBLIC_URL,
    );
    // Sealed before the event order lock, as renew and reconnect do: the secret
    // store writes on its own pool connection, which the lock holder must not
    // wait for.
    const secretRef = stored.secret ? await secrets.put(spaceId, stored.secret) : null;

    const generation = await serviceTransaction(deps.db, async (tx) => {
      const access = await installer(tx, spaceId, actor, installation.kind, true);
      if (installation.kind === 'sandbox') {
        // One execution backend per space, as one browser worker per space:
        // two would mean two places a command could run, and two answers to
        // where a workspace is.
        const existing = await tx
          .select({ id: connection.id })
          .from(connection)
          .where(
            and(
              eq(connection.spaceId, spaceId),
              eq(connection.provider, 'sandbox'),
              ne(connection.status, 'revoked'),
            ),
          );
        if (existing.length)
          throw new ServiceError(
            'conflict',
            'This space already has an execution backend. Remove it before installing another.',
            409,
          );
      }
      if (installation.kind === 'mcp' || installation.kind === 'mcp_stdio') {
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
          label,
          scopes: stored.scopes,
          secretRef,
          configuration: {
            ...stored.configuration,
            ...(plugin ? { plugin } : {}),
            ...(catalogId ? { catalog: catalogId } : {}),
          },
          status: 'disabled',
          setupState: 'connecting',
          sharedUse: installedUse(access),
        })
        .returning({ generation: connection.generation });
      if (!created) throw new Error('Connection installation was not created');
      return created.generation;
    }).catch(async (error: unknown) => {
      // Nothing points at a secret sealed for an installation that was refused,
      // and nothing else would ever remove it before the space itself goes.
      if (secretRef)
        await new PostgresSecretRepository(deps.sql)
          .forget(secretRef, spaceId)
          .catch((cleanup: unknown) =>
            console.error(
              `connections: a refused installation's secret was not removed (${cleanup instanceof Error ? cleanup.name : 'error'})`,
            ),
          );
      throw error;
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
    let refused: ConnectionCheck['code'] = 'unavailable';
    try {
      const [installed] = await deps.db.select().from(connection).where(eq(connection.id, id));
      if (!installed) throw new Error('Connection was removed during installation');
      worker = await factory.open(source(installed)).catch((error: unknown) => {
        refused = openFailure(error, installed.provider);
        throw error;
      });
      // An MCP worker proved itself by completing its handshake; every other kind is asked once.
      outcome =
        (installation.kind === 'mcp' || installation.kind === 'mcp_stdio') && worker
          ? result('ok', 'ok')
          : await check(worker, 'disabled');
      if (outcome.status === 'failing' || !worker) throw new Error('Connection test failed');
      factory.register(deps.registry, id, worker);
      const health = outcome.status;
      const checkedAt = new Date(outcome.checked_at);
      await serviceTransaction(deps.db, async (tx) => {
        const access = await spaceAuthority(tx, spaceId, actor, true);
        if (!mayInstall(access))
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
        outcome = result('failing', worker ? 'not_running' : refused);
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
    return connectionResponse.parse({ connection: view(row), check: outcome });
  };

  // Signing in to a remote MCP server. The sign-in earns the credential that
  // would otherwise be pasted, and ends on the same installation path.
  // A sign-in may come back to any instance, so they wait in Postgres.
  const pendingSignIns = signInStore(deps.sql, factory.options.masterKey);
  /**
   * Only the setup owner's own space may reach a private address; everyone
   * else's server and authorization server must be public, and are checked and
   * pinned on every request.
   */
  const reachFor = async (spaceId: string) =>
    reachFetch({ reach: await spaceReach(deps.sql, spaceId) });
  const signIns = new McpSignIns({
    store: pendingSignIns,
    publicUrl: deps.env.MELETE_PUBLIC_URL,
    clientMetadata: deps.env.MELETE_OAUTH_CLIENT_METADATA,
    authorize: async (actor, requested) => {
      const spaceId = requested ?? (await personalSpace(deps.db, actor));
      await installer(deps.db, spaceId, actor, 'mcp');
      if (!factory.options.masterKey)
        throw new ServiceError(
          'sealing_unavailable',
          'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
          409,
        );
      return spaceId;
    },
    // The same reach the connection itself will have once installed.
    fetcherFor: (spaceId) => reachFor(spaceId),
    existing: async (actor, connectionId) => {
      const [row] = await deps.db.select().from(connection).where(eq(connection.id, connectionId));
      if (!row || row.provider !== 'mcp' || row.status === 'revoked')
        throw new ServiceError('not_found', 'Connection not found.', 404);
      await installer(deps.db, row.spaceId, actor, 'mcp');
      const server = mcpServerConfig.safeParse(row.configuration.server);
      if (!server.success || server.data.endpoint.transport !== 'http')
        throw new ServiceError('invalid_request', 'Only a remote MCP server is signed in to.', 400);
      if (!factory.options.masterKey)
        throw new ServiceError(
          'sealing_unavailable',
          'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
          409,
        );
      const granted = row.secretRef
        ? await secrets
            .withSecret(row.secretRef, row.spaceId, async (value) =>
              mcpCredentials.parse(JSON.parse(value)),
            )
            .then((credential) => credential.scope?.split(/\s+/) ?? [])
            .catch(() => [])
        : [];
      const needed = Array.isArray(row.configuration.needs_scope)
        ? row.configuration.needs_scope.filter(
            (scope): scope is string => typeof scope === 'string',
          )
        : [];
      return {
        spaceId: row.spaceId,
        url: server.data.endpoint.url,
        scopes: [...new Set([...granted, ...needed])].filter(Boolean),
      };
    },
    renew: async (actor, connectionId, credentials) => {
      const credential = mcpCredentials.parse(credentials);
      const [row] = await deps.db.select().from(connection).where(eq(connection.id, connectionId));
      if (!row || row.provider !== 'mcp' || row.status === 'revoked')
        throw new ServiceError('not_found', 'Connection not found.', 404);
      const secretRef = await secrets.put(row.spaceId, JSON.stringify(credential));
      const updated = await serviceTransaction(deps.db, async (tx) => {
        await installer(tx, row.spaceId, actor, 'mcp', true);
        const { needs_scope: _answered, ...configuration } = row.configuration;
        const [next] = await tx
          .update(connection)
          .set({ secretRef, configuration })
          .where(
            and(
              eq(connection.id, row.id),
              eq(connection.generation, row.generation),
              ne(connection.status, 'revoked'),
            ),
          )
          .returning();
        return next;
      });
      if (!updated)
        throw new ServiceError('generation_conflict', 'Connection changed during sign-in.', 409);
      const tested = await retest(updated);
      return connectionResponse.parse({ connection: view(tested.connection), check: tested.check });
    },
    install: (actor, request) =>
      install(actor, {
        ...(request.space_id ? { space_id: request.space_id } : {}),
        provider: 'mcp',
        label: request.label,
        scopes: [],
        credentials: request.credentials,
        mcp: request.mcp,
      }),
    // A server signed in to by its address: its tools are read with the
    // credential just earned, for the person to choose from.
    discover: async (spaceId, url, credentials) => {
      try {
        return discoveredTools(
          await discoverMcpServerTools(
            { transport: 'http', url },
            {
              accessToken: async () => credentials.access_token,
              fetch: await reachFor(spaceId),
            },
          ),
        );
      } catch (error) {
        throw new McpSignInFailure(`discover_${mcpOpenFailure(error) ?? 'failed'}`);
      }
    },
    catalog: (id) => {
      const entry = mcpCatalogEntry(id);
      if (!entry) throw new McpSignInFailure('catalog_unknown');
      const client = catalogClient(entry);
      if (client === null) throw new McpSignInFailure('catalog_client_unset');
      return { url: catalogUrl(entry), ...(client ? { client } : {}) };
    },
    // The app's server is asked which of the catalog's tools it has now, with
    // the credential just earned, and only those are installed. A tool it has
    // that the catalog does not name is never offered.
    installCatalog: async (actor, request) => {
      const entry = mcpCatalogEntry(request.catalog_id);
      if (!entry) throw new McpSignInFailure('catalog_unknown');
      const url = catalogUrl(entry);
      const fetcher = await reachFor(request.space_id);
      const offered = new Set(
        await listMcpServerTools(
          { transport: 'http', url },
          { accessToken: async () => request.credentials.access_token, fetch: fetcher },
        ).catch((error: unknown) => {
          if (asConnectorFault(error)) throw error;
          throw new McpSignInFailure('catalog_tools_unreadable');
        }),
      );
      const tools = entry.tools.filter((tool) => offered.has(tool.name));
      if (!tools.length) throw new McpSignInFailure('catalog_tools_unavailable');
      return install(
        actor,
        {
          space_id: request.space_id,
          provider: 'mcp',
          label: entry.title,
          scopes: [],
          credentials: request.credentials,
          mcp: mcpCatalogConfig(entry, url, tools),
        },
        undefined,
        entry.id,
      );
    },
  });

  app.post('/mcp-sign-ins', async (c) => {
    const parsed = mcpSignInRequest.safeParse(await c.req.json());
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    try {
      const started = await signIns.start(c.get('owner').id, parsed.data, webOriginOf(c));
      return c.json(
        mcpSignInStart.parse({
          ...started,
          scopes: started.scopes.map((scope) => ({ scope })),
        }),
        201,
      );
    } catch (error) {
      throw signInError(error);
    }
  });

  // The tools a person kept from a server they signed in to by its address.
  app.post('/mcp-sign-ins/:id/install', async (c) => {
    const parsed = mcpSignInInstall.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    try {
      return c.json(
        await signIns.installReady(c.get('owner').id, c.req.param('id'), parsed.data.tools),
        201,
      );
    } catch (error) {
      throw signInError(error);
    }
  });

  // What a server added by its address offers, before anything is installed:
  // its tools with where each would start, or that it wants a sign-in first.
  app.post('/mcp-servers/discover', async (c) => {
    const parsed = mcpToolDiscoveryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    const actor = c.get('owner').id;
    const spaceId = parsed.data.space_id ?? (await personalSpace(deps.db, actor));
    // Authority first, so no address is fetched for someone who may not install here.
    await installer(deps.db, spaceId, actor, 'mcp');
    if (
      (await spaceReach(deps.sql, spaceId)) === 'public' &&
      !(await isPublicEndpoint(parsed.data.url))
    )
      throw new ServiceError(
        'address_not_reachable',
        `${UNREACHABLE} An MCP server must be at a public address.`,
        400,
      );
    const token = parsed.data.access_token;
    if (token && !parsed.data.url.startsWith('https://'))
      throw new ServiceError(
        'invalid_request',
        'A token is only sent to an https:// address. Use the server’s https:// address.',
        400,
      );
    try {
      const tools = await discoverMcpServerTools(
        { transport: 'http', url: parsed.data.url },
        {
          ...(token ? { accessToken: async () => token } : {}),
          fetch: await reachFor(spaceId),
        },
      );
      return c.json(mcpToolDiscovery.parse({ state: 'ready', tools: discoveredTools(tools) }));
    } catch (error) {
      const fault = asConnectorFault(error);
      if (fault?.kind === 'expired_credential' || fault?.kind === 'revoked_credential') {
        // With a token, the server refused it; without one, it wants a sign-in.
        if (token)
          throw new ServiceError(
            'mcp_token_refused',
            'The server refused that token. Check it, or leave it out to sign in instead.',
            400,
          );
        return c.json(mcpToolDiscovery.parse({ state: 'needs_sign_in' }));
      }
      const why = mcpOpenFailure(error);
      throw new ServiceError(
        `mcp_${why ?? 'failed'}`,
        DISCOVERY_FAILURES[why ?? 'failed'],
        why === 'unreachable' ? 502 : 400,
      );
    }
  });

  app.get('/mcp-sign-ins/:id', async (c) => {
    const status = await signIns.status(c.get('owner').id, c.req.param('id'));
    if (!status) throw new ServiceError('not_found', 'No sign-in by that id.', 404);
    return c.json(mcpSignInStatus.parse(status));
  });

  // The authorization server sends the browser here. The page it shows is all
  // the browser needs; the app reads the outcome from the sign-in's status.
  app.get('/oauth/callback', async (c) => {
    try {
      const installed = await signIns.complete(c.get('owner').id, new URL(c.req.url).searchParams);
      if ('ready' in installed)
        return c.html(
          signInPage(
            'Signed in',
            'You signed in. Go back to Melete to choose which of its tools to use. You can close this tab.',
          ),
        );
      const label = installed.connection.label;
      return c.html(
        installed.check?.status === 'failing'
          ? signInPage(
              'Signed in',
              `You signed in to ${label}, but the server did not answer. Test the connection from the app.`,
            )
          : signInPage('Connected', `${label} is connected. You can close this tab.`),
      );
    } catch (error) {
      const refused = signInError(error);
      return c.html(signInPage('Not connected', refused.message), refused.status);
    }
  });

  app.get('/oauth/client-metadata.json', (c) => {
    const clientId = signIns.clientMetadataUrl();
    const redirectUri = signIns.redirectUri();
    if (!clientId || !redirectUri)
      throw new ServiceError('not_found', 'This service publishes no client metadata.', 404);
    return c.json(clientMetadataDocument(clientId, redirectUri));
  });

  app.post('/connections', async (c) => {
    const parsed = createConnectionRequest.safeParse(await c.req.json());
    // The person is told which field to fix, in the words the form uses for it.
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    return c.json(await install(c.get('owner').id, parsed.data), 201);
  });

  /**
   * Signing in again with the same account, after the grant ended or to grant
   * more, gives the connection already made for that account the new
   * credential rather than making a second one.
   */
  /** The Composio client, when the operator set a key. */
  const composio = factory.options.composio;

  /**
   * Remove a Composio account no live connection acts for any more. When
   * Composio cannot be reached, the account is queued and tried again until
   * it is gone; the person is not kept waiting on it.
   */
  const releaseManagedAccount = async (connectedAccountId: string) => {
    if (!composio) return;
    if (await managedAccountInUse(deps.sql, connectedAccountId)) return;
    try {
      await composio.client.removeAccount(connectedAccountId);
    } catch {
      process.stderr.write('connections: a Composio account was not removed yet\n');
      await queueManagedRemoval(deps.sql, [connectedAccountId]);
    }
  };

  /**
   * Move a connection between its native sign-in and Composio, keeping the
   * row: what it already reported is keyed by the connection, so nothing it
   * read before is reported again. Its generation moves on, so a read or a
   * call still on the old way is set aside, and its connector is rebuilt.
   */
  const switchTransport = async (
    actor: string,
    row: typeof connection.$inferSelect,
    next: { configuration: Record<string, unknown>; secretRef: string | null; scopes: string[] },
  ): Promise<ConnectionResponse> => {
    const kind = String(row.configuration.kind) as Installation['kind'];
    const updated = await serviceTransaction(deps.db, async (tx) => {
      await installer(tx, row.spaceId, actor, kind, true);
      const [changed] = await tx
        .update(connection)
        .set({
          configuration: next.configuration,
          secretRef: next.secretRef,
          scopes: next.scopes,
          generation: row.generation + 1,
        })
        .where(
          and(
            eq(connection.id, row.id),
            eq(connection.generation, row.generation),
            ne(connection.status, 'revoked'),
          ),
        )
        .returning();
      return changed;
    });
    if (!updated)
      throw new ServiceError('generation_conflict', 'Connection changed during sign-in.', 409);
    const running = deps.registry.get(row.id);
    if (running) {
      await deps.registry.remove(row.id, running).catch(() => {});
      factory.mailers.delete(row.id);
    }
    if (row.secretRef && row.secretRef !== next.secretRef)
      await new PostgresSecretRepository(deps.sql).forget(row.secretRef, row.spaceId).catch(() => {
        process.stderr.write('connections: a replaced sign-in could not be removed\n');
      });
    const opened = await factory.open(source(updated)).catch(() => undefined);
    if (opened && !deps.registry.get(row.id)) factory.register(deps.registry, row.id, opened);
    const tested = await retest(updated);
    return connectionResponse.parse({ connection: view(tested.connection), check: tested.check });
  };

  const reconnect = async (
    actor: string,
    row: typeof connection.$inferSelect,
    installation: AccountInstallation,
  ): Promise<ConnectionResponse> => {
    const secretRef = await secrets.put(row.spaceId, JSON.stringify(installation.credential));
    // Signed in through Composio until now: the connection moves back to its own sign-in.
    const previous = row.configuration.connected_account_id;
    if (row.configuration.via === 'composio') {
      const switched = await switchTransport(actor, row, {
        configuration: { kind: installation.kind, account: installation.account },
        secretRef,
        scopes: installation.scopes,
      });
      if (typeof previous === 'string') await releaseManagedAccount(previous);
      return switched;
    }
    const updated = await serviceTransaction(deps.db, async (tx) => {
      await installer(tx, row.spaceId, actor, installation.kind, true);
      const [next] = await tx
        .update(connection)
        .set({ secretRef, scopes: installation.scopes })
        .where(
          and(
            eq(connection.id, row.id),
            eq(connection.generation, row.generation),
            ne(connection.status, 'revoked'),
          ),
        )
        .returning();
      return next;
    });
    // Only one sealed copy of a sign-in is kept: the one the connection points at.
    const unused = updated ? row.secretRef : secretRef;
    if (unused && unused !== updated?.secretRef)
      await new PostgresSecretRepository(deps.sql).forget(unused, row.spaceId).catch(() => {
        process.stderr.write('connections: a replaced sign-in could not be removed\n');
      });
    if (!updated)
      throw new ServiceError('generation_conflict', 'Connection changed during sign-in.', 409);
    const tested = await retest(updated);
    return connectionResponse.parse({ connection: view(tested.connection), check: tested.check });
  };

  const installAccount = async (actor: string, grant: AccountGrant) => {
    const kinds = ACCOUNT_KINDS[grant.provider];
    const parts: Array<{ label: string; installation: AccountInstallation }> = [];
    const base = { account: grant.account, credential: grant.credential };
    if (grant.mail)
      parts.push({
        label: grant.mail.label,
        installation: { ...base, kind: kinds.mail, provider: 'imap', scopes: grant.mail.scopes },
      });
    if (grant.calendar)
      parts.push({
        label: grant.calendar.label,
        installation: {
          ...base,
          kind: kinds.calendar,
          provider: 'caldav',
          scopes: grant.calendar.scopes,
        },
      });
    if (grant.documents && kinds.documents)
      parts.push({
        label: grant.documents.label,
        installation: {
          ...base,
          kind: kinds.documents,
          provider: 'drive',
          scopes: grant.documents.scopes,
        },
      });
    const installed: ConnectionResponse[] = [];
    for (const { label, installation } of parts) {
      const [existing] = await deps.db
        .select()
        .from(connection)
        .where(
          and(
            eq(connection.spaceId, grant.spaceId),
            eq(connection.provider, installation.provider),
            ne(connection.status, 'revoked'),
            query`${connection.configuration}->>'kind' = ${installation.kind}`,
            query`${connection.configuration}->>'account' = ${installation.account}`,
          ),
        )
        .orderBy(asc(connection.id))
        .limit(1);
      installed.push(
        existing
          ? await reconnect(actor, existing, installation)
          : await installResolved(actor, grant.spaceId, label, installation),
      );
    }
    return installed;
  };

  /**
   * One part a sign-in through Composio connected. An address already
   * connected in the space natively moves to Composio on its own row; one
   * already connected through another active Composio account is refused.
   */
  const installManaged = async (
    actor: string,
    grant: ManagedGrant,
  ): Promise<ConnectionResponse[]> => {
    const [existing] = await deps.db
      .select()
      .from(connection)
      .where(
        and(
          eq(connection.spaceId, grant.spaceId),
          eq(connection.provider, grant.provider),
          ne(connection.status, 'revoked'),
          query`${connection.configuration}->>'kind' = ${grant.kind}`,
          query`lower(${connection.configuration}->>'account') = ${grant.account}`,
        ),
      )
      .orderBy(asc(connection.id))
      .limit(1);
    const configuration = managedConfiguration(grant.kind, grant.account, grant.connectedAccountId);
    if (!existing) {
      const installation = {
        managed: true,
        kind: grant.kind,
        provider: grant.provider,
        account: grant.account,
        scopes: grant.scopes,
        connectedAccountId: grant.connectedAccountId,
      } as ManagedInstallation;
      return [await installResolved(actor, grant.spaceId, grant.label, installation)];
    }
    if (existing.configuration.via !== 'composio')
      return [
        await switchTransport(actor, existing, {
          configuration,
          secretRef: null,
          scopes: grant.scopes,
        }),
      ];
    const previous = String(existing.configuration.connected_account_id ?? '');
    if (previous === grant.connectedAccountId) {
      const tested = await retest(existing);
      return [
        connectionResponse.parse({ connection: view(tested.connection), check: tested.check }),
      ];
    }
    // The same address through another Composio account: refused while that one still works.
    // Only an account Composio says is gone is replaced; not hearing back is not that.
    let standing: ComposioAccount | null = null;
    try {
      standing = composio ? await composio.client.account(previous) : null;
    } catch (error) {
      if (!(error instanceof ComposioFault && error.kind === 'account_unavailable'))
        throw new SignInFailure('provider_unreachable');
    }
    if (standing && standing.status === 'ACTIVE' && !standing.disabled)
      throw new SignInFailure('account_already_connected');
    const switched = await switchTransport(actor, existing, {
      configuration,
      secretRef: null,
      scopes: grant.scopes,
    });
    if (previous) await releaseManagedAccount(previous);
    return [switched];
  };

  /** This installation's Composio user for a person: stable, and never shown. */
  const managedUser = async (actor: string) => {
    const [installation] = await deps.db.select({ id: owner.id }).from(owner).limit(1);
    if (!installation) throw new ServiceError('unauthorized', 'Setup is required.', 401);
    return `melete:${installation.id}:${actor}`;
  };
  const authConfigSettings: Record<ComposioToolkit, string | undefined> = {
    gmail: deps.env.COMPOSIO_AUTH_CONFIG_GMAIL,
    googlecalendar: deps.env.COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR,
    googledrive: deps.env.COMPOSIO_AUTH_CONFIG_GOOGLEDRIVE,
  };
  const meter = composio?.meter;
  const managedSignIns = new ManagedSignIns<ConnectionResponse>({
    store: pendingSignIns,
    publicUrl: deps.env.MELETE_PUBLIC_URL,
    ...(composio ? { composio: composio.client } : {}),
    authConfig: async (toolkit) => {
      if (!composio) throw new SignInFailure('provider_not_configured');
      return composio.client.authConfig(toolkit, authConfigSettings[toolkit]);
    },
    userId: managedUser,
    authorize: async (actor, requested) => {
      const spaceId = requested ?? (await personalSpace(deps.db, actor));
      await installer(deps.db, spaceId, actor, 'gmail');
      // A sign-in waits sealed with the master key, as every sign-in does.
      if (!factory.options.masterKey)
        throw new ServiceError(
          'sealing_unavailable',
          'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
          409,
        );
      return spaceId;
    },
    install: installManaged,
    connectionId: (installed) => installed.connection.id,
    ...(meter ? { charge: (spaceId: string) => meter.charge(spaceId) } : {}),
    queueRemoval: (connectedAccountId, due) =>
      queueManagedRemoval(deps.sql, [connectedAccountId], new Date(due)),
    settleRemoval: (connectedAccountId) => settleManagedRemoval(deps.sql, connectedAccountId),
  });

  app.post('/managed-sign-ins', async (c) => {
    const parsed = managedSignInRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new ServiceError('invalid_request', connectionRequestProblem(parsed.error.issues), 400);
    try {
      return c.json(
        managedSignInStart.parse(await managedSignIns.start(c.get('owner').id, parsed.data)),
        201,
      );
    } catch (error) {
      throw managedSignInError(error);
    }
  });

  // Composio sends the browser here after each consent page: on to the next
  // one, or a short page once the sign-in is done. The app reads the outcome
  // from the sign-in's status. Mounted before `/:id`, which would take it.
  app.get('/managed-sign-ins/callback', async (c) => {
    try {
      const done = await managedSignIns.complete(
        c.get('owner').id,
        new URL(c.req.url).searchParams,
      );
      if (done.next) return c.redirect(done.next, 302);
      const labels = done.installed.map((item) => item.connection.label).join(' and ');
      return c.html(
        done.installed.some((item) => item.check?.status === 'failing')
          ? signInPage(
              'Signed in',
              `You signed in to ${labels}, but Google did not answer through Composio. Test the connection from the app.`,
            )
          : signInPage('Connected', `${labels} connected. You can close this tab.`),
      );
    } catch (error) {
      const refused = managedSignInError(error);
      return c.html(signInPage('Not connected', refused.message), refused.status);
    }
  });

  app.get('/managed-sign-ins/:id', async (c) => {
    const status = await managedSignIns.status(c.get('owner').id, c.req.param('id'));
    if (!status) throw new ServiceError('not_found', 'No sign-in by that id.', 404);
    return c.json(accountSignInStatus.parse(status));
  });

  const accountProviders = {
    google: factory.options.google
      ? googleProvider(factory.options.google.client, factory.options.google.endpoints)
      : undefined,
    microsoft: factory.options.microsoft
      ? microsoftProvider(factory.options.microsoft.client, {
          tenant: factory.options.microsoft.tenant,
          ...(factory.options.microsoft.endpoints
            ? { endpoints: factory.options.microsoft.endpoints }
            : {}),
        })
      : undefined,
  };

  for (const name of ['google', 'microsoft'] as const) {
    const title = ACCOUNT_TITLES[name];
    const provider = accountProviders[name];
    const signIns = new AccountSignIns<ConnectionResponse>(name, {
      store: pendingSignIns,
      publicUrl: deps.env.MELETE_PUBLIC_URL,
      ...(provider ? { provider } : {}),
      authorize: async (actor, requested) => {
        const spaceId = requested ?? (await personalSpace(deps.db, actor));
        await installer(deps.db, spaceId, actor, ACCOUNT_KINDS[name].mail);
        if (!factory.options.masterKey)
          throw new ServiceError(
            'sealing_unavailable',
            'This service has no master key, so it cannot keep a credential. Set MELETE_MASTER_KEY and start it again.',
            409,
          );
        return spaceId;
      },
      install: installAccount,
      connectionId: (installed) => installed.connection.id,
    });
    accountSignIns[name] = signIns;

    app.get(`/${name}-sign-ins`, (c) =>
      c.json(
        accountSignInAvailability.parse({
          available: signIns.available(),
          redirect_uri: signIns.redirectUri(),
        }),
      ),
    );

    app.post(`/${name}-sign-ins`, async (c) => {
      const parsed = accountSignInRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success)
        throw new ServiceError(
          'invalid_request',
          connectionRequestProblem(parsed.error.issues),
          400,
        );
      try {
        const started = await signIns.start(c.get('owner').id, parsed.data);
        // Each scope with the plain words the catalog shows for it.
        const labels = new Map<string, string>(
          ACCOUNT_CATALOG.flatMap((entry) =>
            [...entry.scopes, ...('later_scopes' in entry ? entry.later_scopes : [])].map(
              (scope) => [scope.scope, scope.label] as const,
            ),
          ),
        );
        return c.json(
          accountSignInStart.parse({
            ...started,
            scopes: started.scopes.map((scope) => {
              const label = labels.get(scope);
              return label ? { scope, label } : { scope };
            }),
            ...(parsed.data.documents ? { reason: DRIVE_CONSENT_WORDS } : {}),
          }),
          201,
        );
      } catch (error) {
        throw accountSignInError(name, error);
      }
    });

    app.get(`/${name}-sign-ins/:id`, async (c) => {
      const status = await signIns.status(c.get('owner').id, c.req.param('id'));
      if (!status) throw new ServiceError('not_found', 'No sign-in by that id.', 404);
      return c.json(accountSignInStatus.parse(status));
    });

    // The provider sends the browser here. The page is all the browser needs;
    // the app reads the outcome from the sign-in's status.
    app.get(`/oauth/${name}/callback`, async (c) => {
      try {
        const installed = await signIns.complete(
          c.get('owner').id,
          new URL(c.req.url).searchParams,
        );
        const labels = installed.map((item) => item.connection.label).join(' and ');
        return c.html(
          installed.some((item) => item.check?.status === 'failing')
            ? signInPage(
                'Signed in',
                `You signed in to ${labels}, but ${title} did not answer. Test the connection from the app.`,
              )
            : signInPage('Connected', `${labels} connected. You can close this tab.`),
        );
      } catch (error) {
        const refused = accountSignInError(name, error);
        return c.html(signInPage('Not connected', refused.message), refused.status);
      }
    });
  }

  /** Plugins a space already runs, by catalog entry. */
  const installedPlugins = async (spaceId: string) => {
    const rows = await deps.db
      .select({ id: connection.id, configuration: connection.configuration })
      .from(connection)
      .where(
        and(
          eq(connection.spaceId, spaceId),
          eq(connection.provider, 'mcp'),
          ne(connection.status, 'revoked'),
        ),
      );
    const found = new Map<string, string>();
    for (const row of rows) {
      const entry = (row.configuration.plugin as { id?: unknown } | undefined)?.id;
      if (typeof entry === 'string') found.set(entry, row.id);
    }
    return found;
  };

  app.get('/plugins', async (c) => {
    if (!factory.options.stdioLauncher) return c.json(pluginListResponse.parse({ plugins: [] }));
    const actor = c.get('owner').id;
    const spaceId = c.req.query('space_id') ?? (await personalSpace(deps.db, actor));
    if ((await spaceAuthority(deps.db, spaceId, actor)).role !== 'owner')
      throw new ServiceError('scope_denied', 'Space owner required.', 403);
    const installed = await installedPlugins(spaceId);
    return c.json(
      pluginListResponse.parse({
        plugins: PLUGIN_CATALOG.map((entry) =>
          describePlugin(entry, installed.get(entry.id) ?? null),
        ),
      }),
    );
  });

  app.post('/plugins/:id', async (c) => {
    const entry = pluginEntry(c.req.param('id'));
    if (!entry) throw new ServiceError('not_found', 'No such plugin.', 404);
    const request = installPluginRequest.parse(await c.req.json());
    const built = pluginInstallation(entry, request.values);
    if (!built.ok) throw new ServiceError('invalid_request', built.error, 400);
    const created = await install(
      c.get('owner').id,
      createConnectionRequest.parse({
        ...(request.space_id ? { space_id: request.space_id } : {}),
        provider: 'mcp',
        label: entry.title,
        mcp_stdio: built.config,
      }),
      {
        id: entry.id,
        version: entry.version,
        // Kept so a later version is built from the same choices; secrets are sealed, never kept here.
        values: Object.fromEntries(
          entry.fields
            .filter((field) => !field.secret && request.values[field.name] !== undefined)
            .map((field) => [field.name, request.values[field.name] ?? '']),
        ),
      },
    );
    return c.json(installPluginResponse.parse(created), 201);
  });
}

/**
 * Installing is an owner's act: the owner of a personal space, adding their own
 * account, or an owner of a room, adding an account the room uses as its own.
 */
function mayInstall(access: Awaited<ReturnType<typeof spaceAuthority>>): boolean {
  return (
    access.role === 'owner' && (access.space.audience === 'owner' || access.space.kind === 'shared')
  );
}

/** How a new connection is shared: a room's account serves the room's requests. */
function installedUse(access: Awaited<ReturnType<typeof spaceAuthority>>): 'owner' | 'room' {
  return access.space.kind === 'shared' ? 'room' : 'owner';
}

/**
 * The same judgement is made before anything in the request is acted on and
 * again under the lock that writes the row.
 */
async function requireInstaller(
  reader: Database | Transaction,
  spaceId: string,
  actor: string,
  kind: Installation['kind'],
  lock = false,
) {
  const access = await spaceAuthority(reader, spaceId, actor, lock);
  if (!mayInstall(access))
    throw new ServiceError(
      'scope_denied',
      kind === 'mcp' || kind === 'mcp_stdio'
        ? 'MCP installation requires its owner and matching audience.'
        : 'Installing a connection requires an owner of the space.',
      403,
    );
  return access;
}

/** The space a request means when it names none: the caller's own first personal space. */
/** What a sign-in failure tells the person, by its fixed code. */
const SIGN_IN_FAILURES: Record<string, { status: 400 | 404 | 409 | 502; message: string }> = {
  callback_unavailable: {
    status: 409,
    message:
      'Signing in needs the address people open this service at. Set MELETE_PUBLIC_URL to an https:// address, or a localhost one.',
  },
  sign_in_not_needed: {
    status: 409,
    message: 'This server answers without signing in. Install it without a credential.',
  },
  client_registration_required: {
    status: 409,
    message:
      "This server's sign-in needs a client registered with it. Register one there, then sign in again with its client ID.",
  },
  pkce_unsupported: {
    status: 502,
    message:
      "This server's sign-in does not offer the protection Melete requires (PKCE with S256).",
  },
  resource_metadata_unavailable: {
    status: 502,
    message: 'This server does not say where to sign in.',
  },
  server_address_refused: {
    status: 400,
    message: 'The server address must be https://, or http:// on this machine.',
  },
  state_mismatch: {
    status: 400,
    message: 'That sign-in response belongs to another sign-in. Start again.',
  },
  issuer_missing: {
    status: 400,
    message: 'The sign-in response did not say who issued it. Start again.',
  },
  sign_in_declined: { status: 400, message: 'The sign-in was not approved.' },
  callback_invalid: { status: 400, message: 'The sign-in response was incomplete. Start again.' },
  sign_in_not_found: {
    status: 404,
    message:
      'That sign-in has expired, was already used, or was started by someone else. Start again.',
  },
  catalog_unknown: { status: 404, message: 'There is no app by that name to connect.' },
  catalog_client_unset: {
    status: 409,
    message: 'Connecting this app is not set up on this Melete yet.',
  },
  catalog_tools_unreadable: {
    status: 502,
    message: 'You signed in, but the app did not say what it can do. Try again shortly.',
  },
  catalog_tools_unavailable: {
    status: 502,
    message: 'You signed in, but the app offers none of the tools Melete uses.',
  },
  discovery_unavailable: { status: 409, message: 'This Melete cannot read a server’s tools.' },
  discover_unreachable: {
    status: 502,
    message: 'You signed in, but the server could not be reached to read its tools. Try again.',
  },
  discover_not_mcp: {
    status: 502,
    message:
      'You signed in, but the server did not answer as an MCP server when asked for its tools.',
  },
  discover_failed: {
    status: 502,
    message: 'You signed in, but the server did not list its tools. Try again shortly.',
  },
  tool_not_listed: {
    status: 400,
    message: 'Choose at least one of the tools the server listed.',
  },
};

/** Why reading a server's tools failed, said as what went wrong. */
const DISCOVERY_FAILURES: Record<'unreachable' | 'not_mcp' | 'tool_missing' | 'failed', string> = {
  unreachable:
    'Melete could not reach that address, or nothing answered in time. Check the address and that the server is running.',
  not_mcp:
    'Something answered at that address, but not as an MCP server. Check that it is the server’s MCP address, which often ends in /mcp.',
  tool_missing: 'The server did not list its tools. Try again shortly.',
  failed: 'The server did not list its tools as expected. Try again shortly.',
};

/** A server's tools as the person first sees them: where each starts, which they can change. */
function discoveredTools(tools: McpToolDefinition[]): DiscoveredMcpTool[] {
  return (
    tools
      // A name an installation could not hold is not offered.
      .filter((tool) => /^[A-Za-z0-9_.-]{1,128}$/.test(tool.name))
      .slice(0, MAX_DISCOVERED_TOOLS * 4)
      .map((tool) => ({
        name: tool.name,
        ...(tool.description
          ? { description: tool.description.replace(/\s+/g, ' ').trim().slice(0, 400) }
          : {}),
        effect_class: suggestedEffect(tool),
      }))
  );
}

/** The address the person's browser opened Melete at, as only the trusted web proxy can say. */
const webOriginOf = (c: Context) => (c.env as RequestSource | undefined)?.webOrigin;

function signInError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof McpSignInFailure) {
    const known = SIGN_IN_FAILURES[error.code];
    return new ServiceError(
      error.code,
      known?.message ?? "The server's sign-in did not answer as expected. Try again shortly.",
      known?.status ?? 502,
    );
  }
  return new ServiceError('sign_in_failed', 'The connection could not be completed.', 502);
}

const ACCOUNT_TITLES = { google: 'Google', microsoft: 'Microsoft' } as const;

/** What a connection of each kind can do, for the catalog. */
const KIND_COVERS = {
  mail: 'mail',
  caldav: 'calendar',
  ics: 'calendar',
  mcp: 'tools',
  mcp_stdio: 'tools',
  sandbox: 'execution',
  command_line: 'execution',
  sms: 'texts',
} as const satisfies Record<
  ConnectionKindDescriptor['kind'],
  ConnectionCatalogEntry['covers'][number]
>;
const ACCOUNT_SETTINGS = {
  google: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET',
  microsoft: 'MICROSOFT_OAUTH_CLIENT_ID and MICROSOFT_OAUTH_CLIENT_SECRET',
} as const;

/** What an account sign-in failure tells the person, by its fixed code. */
function accountSignInFailures(
  name: AccountProviderName,
): Record<string, { status: 400 | 404 | 409 | 502; message: string }> {
  const title = ACCOUNT_TITLES[name];
  return {
    provider_not_configured: {
      status: 409,
      message: `Signing in with ${title} needs an OAuth client. Set ${ACCOUNT_SETTINGS[name]}.`,
    },
    callback_unavailable: {
      status: 409,
      message:
        'Signing in needs the address people open this service at. Set MELETE_PUBLIC_URL to an https:// address, or a localhost one.',
    },
    sign_in_not_found: {
      status: 404,
      message:
        'That sign-in has expired, was already used, or was started by someone else. Start again.',
    },
    sign_in_declined: { status: 400, message: `${title} did not approve the sign-in.` },
    callback_invalid: { status: 400, message: `${title} sent the browser back without a code.` },
    code_exchange_refused: {
      status: 502,
      message: `${title} refused the sign-in code. Start again.`,
    },
    account_unverified: {
      status: 502,
      message: `${title} did not confirm an address for this account.`,
    },
    documents_unavailable: {
      status: 400,
      message: `${title} has no Drive to connect.`,
    },
    access_not_granted: {
      status: 400,
      message: `Nothing was connected: allow reading mail or managing calendar events on the ${title} consent screen.`,
    },
  };
}

function accountSignInError(name: AccountProviderName, error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof SignInFailure) {
    const known = accountSignInFailures(name)[error.code];
    return new ServiceError(
      error.code,
      known?.message ??
        `${ACCOUNT_TITLES[name]} could not be reached for sign-in. Try again shortly.`,
      known?.status ?? 502,
    );
  }
  return new ServiceError('sign_in_failed', 'The connection could not be completed.', 502);
}

/** What a sign-in through Composio tells the person, by its fixed code. */
const MANAGED_SIGN_IN_FAILURES: Record<string, { status: 400 | 404 | 409 | 502; message: string }> =
  {
    provider_not_configured: {
      status: 409,
      message:
        'Signing in with Google through Composio needs a Composio key. Set COMPOSIO_API_KEY.',
    },
    callback_unavailable: {
      status: 409,
      message:
        'Signing in needs the address people open this service at. Set MELETE_PUBLIC_URL to an https:// address, or a localhost one.',
    },
    sign_in_not_found: {
      status: 404,
      message:
        'That sign-in has expired, was already used, or was started by someone else. Start again.',
    },
    sign_in_declined: { status: 400, message: 'Google did not approve the sign-in.' },
    account_mismatch: {
      status: 400,
      message: 'That sign-in came back for another account than the one it started. Start again.',
    },
    account_foreign: {
      status: 400,
      message: 'That account belongs to another sign-in. Start again.',
    },
    account_inactive: {
      status: 400,
      message: 'Composio did not finish connecting the account. Start again.',
    },
    account_unverified: {
      status: 502,
      message: 'Google did not confirm an address for this account.',
    },
    account_already_connected: {
      status: 409,
      message: 'This Google account is already connected here.',
    },
    provider_unreachable: {
      status: 502,
      message: 'Composio could not be reached for sign-in. Try again shortly.',
    },
  };

function managedSignInError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof SignInFailure) {
    const known = MANAGED_SIGN_IN_FAILURES[error.code];
    return new ServiceError(
      error.code,
      known?.message ?? 'Composio could not be reached for sign-in. Try again shortly.',
      known?.status ?? 502,
    );
  }
  return new ServiceError('sign_in_failed', 'The connection could not be completed.', 502);
}

/** Why each watched account is read less often than usual, or could not be read. */
async function readingNotes(sql: Sql, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await sql`select connection_id, last_error from source_cursor
    where connection_id in ${sql(ids)} and last_error is not null
    order by connection_id, stream`;
  const notes = new Map<string, string>();
  for (const row of rows)
    if (!notes.has(String(row.connection_id)))
      notes.set(String(row.connection_id), String(row.last_error));
  return notes;
}

/** What installing text messages says when Twilio did not answer as it should. */
function twilioRefusal(error: unknown): string {
  if (error instanceof TwilioFailure && error.code === 'credential_refused')
    return 'Twilio refused the account SID or auth token. Copy both again from the Twilio Console.';
  if (error instanceof TwilioFailure && error.code !== 'unavailable')
    return 'Twilio refused the request for this number. Check that it can send and receive texts.';
  return 'Twilio could not be reached. Try again shortly.';
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The small page the browser lands on after signing in. */
function signInPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

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
  installation: Installation,
  id: string,
  spaceId: string,
  factory: ConnectorFactory,
  reach: Reach,
  publicUrl: string | undefined,
): Promise<{ scopes: string[]; secret: string | null; configuration: Record<string, unknown> }> {
  if (managedInstallation(installation))
    return {
      scopes: installation.scopes,
      secret: null,
      configuration: managedConfiguration(
        installation.kind,
        installation.account,
        installation.connectedAccountId,
      ),
    };
  if (signedIn(installation))
    return {
      scopes: installation.scopes,
      secret: JSON.stringify(installation.credential),
      configuration: { kind: installation.kind, account: installation.account },
    };
  return requestedShape(installation, id, spaceId, factory, reach, publicUrl);
}

async function requestedShape(
  installation: ConnectionInstallation,
  id: string,
  spaceId: string,
  factory: ConnectorFactory,
  reach: Reach,
  publicUrl: string | undefined,
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
        // Each step is checked and pinned as the calendar connector's own requests are.
        fetcher: asFetch(reachFetch({ reach })),
      });
      installation.config = { username: rest.username, calendar_url: found.calendar_url };
    } catch (error) {
      if (error instanceof ConnectorFaultError)
        throw new ServiceError('address_not_reachable', UNREACHABLE, 400);
      throw new ServiceError(
        'invalid_request',
        error instanceof CalendarDiscoveryError
          ? error.message
          : 'The calendar service could not be reached. Check the address and try again.',
        400,
      );
    }
  }
  if (installation.kind === 'mcp_stdio') {
    const { runner, source, command, args, egress, secret_env, ...policy } = installation.config;
    const config = mcpServerConfig.parse({
      ...policy,
      endpoint: {
        transport: 'container',
        launch: {
          runner,
          source,
          ...(command ? { command } : {}),
          args,
          egress,
          secret_env_names: secret_env.map((entry) => entry.name),
        },
      },
    });
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
    const launcher = factory.options.stdioLauncher;
    if (!launcher)
      throw new ServiceError(
        'invalid_request',
        'This service runs stdio MCP servers only when it supervises containers.',
        400,
      );
    if (config.endpoint.transport !== 'container') throw new Error('Unexpected MCP endpoint');
    const refusal = launcher.refuses(config.endpoint.launch);
    if (refusal) throw new ServiceError('invalid_request', refusal, 400);
    // Values are sealed together; the row keeps only their names.
    return {
      scopes: config.allowed_scopes,
      secret: secret_env.length
        ? JSON.stringify(Object.fromEntries(secret_env.map((entry) => [entry.name, entry.value])))
        : null,
      configuration: { server: config },
    };
  }
  if (installation.kind === 'sms') {
    const { credentials, config } = installation;
    if (config.allowed_numbers.includes(credentials.from_number))
      throw new ServiceError(
        'invalid_request',
        'Your phone numbers: the Twilio number itself cannot be one of them.',
        400,
      );
    // The credential is proved, and the number found on its account, while it
    // is still only in memory: a refused one never becomes a row or a secret.
    const client = new TwilioClient(credentials, factory.options.twilio);
    let numberSid: string | null;
    try {
      numberSid = await client.numberSid();
    } catch (error) {
      throw new ServiceError('invalid_request', twilioRefusal(error), 400);
    }
    if (!numberSid)
      throw new ServiceError(
        'invalid_request',
        `This Twilio account has no number ${credentials.from_number}. Use one listed under Phone Numbers in the Twilio Console.`,
        400,
      );
    // With a public address, the number's incoming texts are sent here, so
    // nobody has to paste a webhook address into the Twilio Console.
    const webhook = smsWebhookUrl(publicUrl, id);
    if (webhook)
      try {
        await client.receiveAt(numberSid, webhook);
      } catch (error) {
        throw new ServiceError('invalid_request', twilioRefusal(error), 400);
      }
    return {
      scopes: installation.scopes,
      secret: JSON.stringify(credentials),
      configuration: { kind: 'sms', sms: config },
    };
  }
  if (installation.kind === 'sandbox') {
    const sandbox = factory.options.sandbox;
    if (!sandbox)
      throw new ServiceError(
        'invalid_request',
        'This service has no sandbox project configured, so it cannot own a sandbox. Set MELETE_SANDBOX_PROJECT and start it again.',
        409,
      );
    if (installation.config.adapter === 'modal' && sandbox.modalRefusal)
      throw new ServiceError('invalid_request', sandbox.modalRefusal, 409);
    // The manifest decides first: a configuration the adapter cannot honour is
    // refused here, with its own code, rather than widened at the provider.
    try {
      checkSandboxConfiguration(installation.config, {
        project: sandbox.project,
        spaceId,
        plan: sandbox.e2bPlan,
      });
    } catch (error) {
      if (!(error instanceof SandboxRefusal)) throw error;
      throw new ServiceError('invalid_request', `${error.code}: ${error.message}`, 400);
    }
    // Then the key, while it is still only in memory: a key the provider
    // refuses never becomes a row or a sealed secret. Only the closed code
    // crosses back, never the provider's own words. An adapter with no key is
    // asked whether its engine answers at all.
    const credentials = installation.credentials;
    const probe = createSandboxProvider(installation.config, {
      credential: (use) =>
        credentials
          ? use(sandboxCredentialValue(installation.config.adapter, JSON.stringify(credentials)))
          : Promise.reject(new Error('this adapter takes no key')),
      project: sandbox.project,
      e2bPlan: sandbox.e2bPlan,
      snapshotTtlSeconds: sandbox.snapshotTtlSeconds,
      ...(sandbox.fetch ? { fetch: sandbox.fetch } : {}),
      ...(sandbox.docker ? { docker: sandbox.docker } : {}),
    });
    let answered: 'ok' | 'unavailable';
    try {
      answered = await probeSandboxProvider(probe.provider, AbortSignal.timeout(CHECK_TIMEOUT_MS));
    } finally {
      await probe.close().catch(() => {});
    }
    if (answered !== 'ok')
      throw new ServiceError('invalid_request', CONNECTION_CHECK_DETAIL.unavailable, 400);
    return {
      scopes: installation.scopes,
      secret: credentials ? JSON.stringify(credentials) : null,
      configuration: { kind: 'sandbox', sandbox: installation.config },
    };
  }
  if (installation.kind === 'command_line' && 'access_key_id' in installation.credentials) {
    // The key is asked whose it is (and the role assumed with it) while it is
    // still only in memory: one AWS refuses never becomes a row or a secret.
    const key = installation.credentials;
    const config = {
      region: installation.config.region ?? '',
      ...(installation.config.role_arn ? { role_arn: installation.config.role_arn } : {}),
      ...(installation.config.external_id ? { external_id: installation.config.external_id } : {}),
    };
    const checked = await awsAccount(key, awsAdapterConfig.parse(config), {
      ...(factory.options.commandLine?.awsSts ?? {}),
    });
    if (!checked.ok)
      throw new ServiceError(
        'invalid_request',
        checked.code === 'credential_refused'
          ? installation.config.role_arn
            ? 'AWS did not accept this key, or did not let it assume the role. Check both, then try again.'
            : 'AWS did not accept this key. Check that it is active, then paste it again.'
          : CONNECTION_CHECK_DETAIL.unavailable,
        400,
      );
    return {
      scopes: installation.scopes,
      secret: awsSecret(key),
      configuration: {
        kind: 'command_line',
        adapter: 'aws',
        config,
        account: checked.arn,
      },
    };
  }
  if (installation.kind === 'command_line') {
    if (!('token' in installation.credentials))
      throw new ServiceError('invalid_request', 'A GitHub account needs credentials.token.', 400);
    const { token } = installation.credentials;
    // The token is asked whose it is while it is still only in memory: one
    // the service refuses never becomes a row or a sealed secret.
    const service = installation.config.adapter;
    if (service === 'aws')
      throw new ServiceError(
        'invalid_request',
        'An AWS account needs credentials.access_key_id and credentials.secret_access_key.',
        400,
      );
    const checked = await commandLineAccount(service, installation.credentials.token, {
      ...factory.options.commandLine,
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!checked.ok)
      throw new ServiceError(
        'invalid_request',
        checked.code === 'credential_refused'
          ? `${COMMAND_LINE_SERVICE[service]} did not accept this token. Check that it has not expired, then paste it again.`
          : CONNECTION_CHECK_DETAIL.unavailable,
        400,
      );
    return {
      scopes: installation.scopes,
      secret: token,
      configuration: {
        kind: 'command_line',
        adapter: installation.config.adapter,
        config: {},
        account: checked.login,
      },
    };
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
