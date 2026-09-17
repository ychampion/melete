import { readFile } from 'node:fs/promises';
import { caldavConnectionConfig, mailConnectionConfig } from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import {
  createSandboxProvider,
  modalEnvironmentRefusal,
  sandboxCredentialValue,
  storedSandboxConnection,
} from '../sandbox/connection.ts';
import { SandboxSessions } from '../sandbox/sessions.ts';
import type { SandboxProvider } from '../sandbox/types.ts';
import { browserArtifactSink } from '../workers/browser/artifacts.ts';
import { type BrowserWorkerEndpoint, BrowserWorkerPool } from '../workers/browser/client.ts';
import { PostgresBrowserRecipeStore } from '../workers/browser/recipes.ts';
import { BrowserSessionService } from '../workers/browser/routes.ts';
import { createArtifactsConnector } from './artifacts.ts';
import { createBrowserConnector } from './browser.ts';
import { builtinEnvironment } from './builtin.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector } from './email.ts';
import { createExecConnector } from './exec.ts';
import { createFilesConnector } from './files.ts';
import { IcsFeedConnector } from './ics-feed.ts';
import { mcpServerConfig } from './mcp.ts';
import { openConfiguredMcpConnector } from './mcp-connector.ts';
import {
  openStdioMcpConnector,
  openStoredStdioConnector,
  type StdioLauncher,
  type StdioLifecycleOptions,
  storedStdioConnection,
} from './mcp-stdio.ts';
import { ConnectorRegistry } from './registry.ts';
import { createSandboxExecConnector } from './sandbox-exec.ts';
import { PostgresSecretRepository, SealedSecretStore } from './secrets.ts';
import { createTestConnector, initializeTestLedger } from './test.ts';
import { createCapabilityConnector } from './tts.ts';
import type { Connector } from './types.ts';
import { createWebConnector } from './web.ts';

const endpoint = z
  .object({
    host: z.string().min(1),
    port: z.number().int().positive().max(65535),
    secure: z.boolean(),
  })
  .strict();
const configuredConnection = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('email'),
      id: z.string(),
      username: z.string(),
      from: z.email(),
      imap: endpoint,
      smtp: endpoint,
      inbox: z.string().optional(),
      sent: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('caldav'),
      id: z.string(),
      calendarUrl: z.url(),
      username: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal('ics'), id: z.string(), icsPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('mcp'), id: z.string().min(1), server: mcpServerConfig }).strict(),
  z
    .object({
      kind: z.literal('browser'),
      id: z.string(),
      worker_url: z.url().optional(),
      worker_token_env: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional(),
    })
    .strict(),
]);
export type ConfiguredConnection = z.infer<typeof configuredConnection>;

/** This owner-controlled file contains endpoints, never passwords or runtime-provided settings. */
export async function readConnectionConfig(path?: string): Promise<ConfiguredConnection[]> {
  if (!path) return [];
  // The owner edits this file by hand, so a mistake in it is named with the
  // file and the entry, rather than as a bare parser error at start-up.
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(`${path} (MELETE_CONNECTIONS_FILE) is not valid JSON: ${error.message}`);
  }
  const parsed = z.array(configuredConnection).safeParse(value);
  if (!parsed.success)
    throw new Error(
      `${path} (MELETE_CONNECTIONS_FILE) is not a list of connections: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

/** Worker addresses are owner configuration and credentials remain on the service side. */
export async function configuredBrowserSessions(options: {
  sql: Sql;
  env: Env;
  connections: ConfiguredConnection[];
  workerTokens?: Record<string, string | undefined>;
}) {
  const browserConnections = options.connections.filter((entry) => entry.kind === 'browser');
  if (!browserConnections.length) return undefined;
  const rows =
    await options.sql`select id, space_id from connection where provider = 'web' and status = 'active'`;
  const endpoints: BrowserWorkerEndpoint[] = [];
  for (const setting of browserConnections) {
    const row = rows.find((entry) => entry.id === setting.id);
    if (!row) continue;
    const url =
      setting.worker_url ??
      (row.space_id === options.env.MELETE_BROWSER_SPACE
        ? options.env.MELETE_BROWSER_URL
        : undefined);
    const token = setting.worker_token_env
      ? (options.workerTokens ?? process.env)[setting.worker_token_env]
      : options.env.MELETE_BROWSER_TOKEN;
    if (url) {
      const parsed = new URL(url);
      if (
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        !token ||
        token.length < 32
      )
        throw new Error(
          'A browser worker needs an HTTP(S) URL and a service-owned token of at least 32 characters',
        );
      const existing = endpoints.find((entry) => entry.spaceId === row.space_id);
      if (existing && (existing.url !== url || existing.token !== token))
        throw new Error('A space may use only one browser worker');
      if (!existing) endpoints.push({ spaceId: row.space_id, url, token });
    } else if (options.env.NODE_ENV === 'production') {
      throw new Error('Production browser connections require an isolated worker endpoint');
    }
  }
  const pool = new BrowserWorkerPool({
    spacesRoot: options.env.MELETE_SPACES_DIR,
    idleMs: options.env.MELETE_BROWSER_IDLE_MS,
    allowLocalProcess: options.env.NODE_ENV !== 'production',
    endpoints,
  });
  return { pool, sessions: new BrowserSessionService(options.sql, pool) };
}

export type ConnectorOptions = {
  sql: Sql;
  workRoot: string;
  spacesRoot: string;
  masterKey?: string;
  connections?: ConfiguredConnection[];
  enableTestConnector?: boolean;
  /** Reads the same environment the gateway does, so one key configures both. */
  env?: Record<string, string | undefined>;
  browserSessions?: BrowserSessionService;
  /** True when attempts run in a container; a default exec connection is inert without it. */
  cellIsolated?: boolean;
  /** Plaintext mail and CalDAV to a loopback protocol fixture. Never set from a request. */
  insecureLocalFixtures?: boolean;
  /** Starts stdio MCP servers in isolation; without one, a stdio installation offers nothing. */
  stdioLauncher?: StdioLauncher;
  stdioLifecycle?: StdioLifecycleOptions;
  /** Everything a sandbox connection needs besides its own row. */
  sandbox?: SandboxRuntimeOptions;
};

/**
 * What the service brings to a sandbox connection: the session table, the
 * label that says which sandboxes are this installation's, and the settings an
 * adapter cannot decide for itself.
 */
export type SandboxRuntimeOptions = {
  sessions: SandboxSessions;
  project: string;
  e2bPlan: 'hobby' | 'pro';
  snapshotTtlSeconds: number;
  maxConcurrent: number;
  /** Set when this environment could redirect Modal's traffic; then Modal is refused. */
  modalRefusal: string | null;
  /** Replaces E2B's HTTP transport. Only a test fixture passes one. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

/** What a connector is built from: the persisted row, never a request payload. */
export type ConnectionSource = {
  id: string;
  spaceId: string;
  provider: string;
  secretRef: string | null;
  configuration: Record<string, unknown> | null;
};

/** What `POST /connections` stores for the kinds that carry their own configuration. */
const storedConfiguration = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mail'), mail: mailConnectionConfig }),
  z.object({ kind: z.literal('caldav'), caldav: caldavConnectionConfig }),
  z.object({ kind: z.literal('ics') }),
  storedSandboxConnection,
]);

/**
 * A connection a person installed carries their own account. It is offered only
 * in an owner-audience space and never to a public compartment, which is the
 * rule an installed MCP server already follows.
 */
function ownerOnly<T extends Connector>(connector: T): T {
  return Object.assign(connector, {
    catalog: { ...connector.catalog, audience: 'owner' as const },
  });
}

/**
 * Builds the connector a connection row selects. Startup uses it for every
 * active row; the API uses the same instance for a row installed later, so both
 * paths construct a connector one way and share the mailboxes publishing uses.
 */
export class ConnectorFactory {
  readonly secrets: SealedSecretStore;
  readonly mailers = new Map<string, ReturnType<EmailConnector['asMailer']>>();
  /** Each sandbox connection's provider, so boot reconciliation and the sweep use it too. */
  readonly sandboxProviders = new Map<string, { adapter: string; provider: SandboxProvider }>();
  private readonly overrides: Map<string, ConfiguredConnection>;

  constructor(readonly options: ConnectorOptions) {
    this.secrets = new SealedSecretStore(
      new PostgresSecretRepository(options.sql),
      () => options.masterKey,
    );
    this.overrides = new Map((options.connections ?? []).map((entry) => [entry.id, entry]));
    if (this.overrides.size !== (options.connections ?? []).length)
      throw new Error('Duplicate configured connection id');
  }

  /** Undefined when the row selects nothing this service can run. */
  async open(row: ConnectionSource): Promise<Connector | undefined> {
    const options = this.options;
    // The owner-controlled file wins over what the row stores, so an operator can still pin an endpoint.
    const setting =
      this.overrides.get(row.id) ??
      (row.provider === 'mcp' && row.configuration?.server
        ? {
            kind: 'mcp' as const,
            id: row.id,
            server: mcpServerConfig.parse(row.configuration.server),
          }
        : undefined);
    const stored = setting ? undefined : storedConfiguration.safeParse(row.configuration).data;
    if (row.provider === 'generation') {
      // A capability is registered like any other connector, so a generation
      // call takes the path approval, fencing, budget and idempotency already
      // hold. A second path to the world would be a second place to get those
      // right.
      const configured = capabilitiesFromEnv(options.env ?? process.env);
      if (!configured.speech) return undefined;
      return createCapabilityConnector({
        spacesRoot: options.spacesRoot,
        adapter: configured.speech,
        provider: configured.provider,
        unitCostUsd: configured.unitCostUsd,
      });
    }
    if (row.provider === 'files') return createFilesConnector(options);
    if (row.provider === 'exec')
      // A default exec row outlives a change of runtime; without a container it offers nothing.
      return row.configuration?.builtin && !options.cellIsolated
        ? undefined
        : createExecConnector(options);
    if (row.provider === 'artifacts')
      return createArtifactsConnector({
        sql: options.sql,
        workRoot: options.workRoot,
        spacesRoot: options.spacesRoot,
        mailers: this.mailers,
      });
    if (row.provider === 'web' && setting?.kind === 'browser') {
      if (!options.browserSessions) throw new Error('Browser session service is not configured');
      return createBrowserConnector({
        sessions: options.browserSessions,
        artifacts: browserArtifactSink(options.sql, options.spacesRoot),
        recipes: new PostgresBrowserRecipeStore(options.sql),
        spaceId: row.spaceId,
      });
    }
    if (row.provider === 'web') return createWebConnector();
    if (row.provider === 'sandbox' && stored?.kind === 'sandbox') {
      const sandbox = options.sandbox;
      const secretRef = row.secretRef;
      if (!sandbox || !secretRef) return undefined;
      if (stored.sandbox.adapter === 'modal' && sandbox.modalRefusal)
        throw new Error(sandbox.modalRefusal);
      const config = stored.sandbox;
      const opened = createSandboxProvider(config, {
        credential: (use) =>
          this.secrets.withSecret(secretRef, row.spaceId, (sealed) =>
            use(sandboxCredentialValue(config.adapter, sealed)),
          ),
        project: sandbox.project,
        e2bPlan: sandbox.e2bPlan,
        snapshotTtlSeconds: sandbox.snapshotTtlSeconds,
        ...(sandbox.fetch ? { fetch: sandbox.fetch } : {}),
      });
      this.sandboxProviders.set(row.id, {
        adapter: config.adapter,
        provider: opened.provider,
      });
      return ownerOnly(
        createSandboxExecConnector({
          sessions: sandbox.sessions,
          provider: opened.provider,
          config,
          connectionId: row.id,
          spaceId: row.spaceId,
          project: sandbox.project,
          workRoot: options.workRoot,
          sql: options.sql,
          e2bPlan: sandbox.e2bPlan,
          maxConcurrent: sandbox.maxConcurrent,
          close: opened.close,
        }),
      );
    }
    if (row.provider === 'test' && options.enableTestConnector)
      return createTestConnector(options.sql);
    if (row.provider === 'imap' && setting?.kind === 'email' && row.secretRef)
      return new EmailConnector(
        { ...setting, spaceId: row.spaceId, secretRef: row.secretRef },
        this.secrets,
      );
    if (row.provider === 'imap' && stored?.kind === 'mail' && row.secretRef)
      return ownerOnly(
        new EmailConnector(
          {
            ...stored.mail,
            id: row.id,
            spaceId: row.spaceId,
            secretRef: row.secretRef,
            allowInsecureLocalForTests: options.insecureLocalFixtures,
          },
          this.secrets,
        ),
      );
    if (row.provider === 'caldav' && setting?.kind === 'caldav' && row.secretRef)
      return new CalendarConnector(
        { ...setting, spaceId: row.spaceId, secretRef: row.secretRef, mode: 'caldav' },
        this.secrets,
      );
    if (row.provider === 'caldav' && stored?.kind === 'caldav' && row.secretRef)
      return ownerOnly(
        new CalendarConnector(
          {
            id: row.id,
            spaceId: row.spaceId,
            mode: 'caldav',
            calendarUrl: stored.caldav.calendar_url,
            username: stored.caldav.username,
            secretRef: row.secretRef,
            allowInsecureLocalForTests: options.insecureLocalFixtures,
          },
          this.secrets,
        ),
      );
    if (row.provider === 'caldav' && stored?.kind === 'ics' && row.secretRef)
      return ownerOnly(
        new IcsFeedConnector(
          {
            id: row.id,
            spaceId: row.spaceId,
            secretRef: row.secretRef,
            allowInsecureLocalForTests: options.insecureLocalFixtures,
          },
          this.secrets,
        ),
      );
    if (
      row.provider === 'mcp' &&
      setting?.kind === 'mcp' &&
      setting.server.endpoint.transport === 'container'
    ) {
      if (!options.stdioLauncher) return undefined;
      // The catalog recorded at installation lets the service start without running the server.
      if (!this.overrides.has(row.id) && storedStdioConnection.safeParse(row.configuration).success)
        return openStoredStdioConnector(
          row,
          options.sql,
          this.secrets,
          options.stdioLauncher,
          options.stdioLifecycle,
        );
      return openStdioMcpConnector(
        setting.server,
        { connectionId: row.id, spaceId: row.spaceId },
        options.sql,
        this.secrets,
        options.stdioLauncher,
        options.stdioLifecycle,
      );
    }
    if (row.provider === 'mcp' && setting?.kind === 'mcp')
      return openConfiguredMcpConnector(
        setting.server,
        { connectionId: row.id, spaceId: row.spaceId },
        options.sql,
        this.secrets,
      );
    if (row.provider === 'caldav' && setting?.kind === 'ics')
      return new CalendarConnector(
        {
          id: row.id,
          spaceId: row.spaceId,
          mode: 'ics',
          ics: await readFile(setting.icsPath, 'utf8'),
        },
        this.secrets,
      );
    return undefined;
  }

  /** Publishing by email uses whichever mailbox connectors are registered, whenever they arrive. */
  register(registry: ConnectorRegistry, id: string, connector: Connector): void {
    registry.register(id, connector);
    if (connector instanceof EmailConnector) this.mailers.set(id, connector.asMailer());
  }
}

const factories = new WeakMap<ConnectorRegistry, ConnectorFactory>();

/** The factory that built a registry, so a later installation is built the same way. */
export function connectorFactoryFor(
  registry: ConnectorRegistry,
  fallback: () => ConnectorOptions,
): ConnectorFactory {
  let factory = factories.get(registry);
  if (!factory) {
    factory = new ConnectorFactory(fallback());
    factories.set(registry, factory);
  }
  return factory;
}

/** Bind a registry to a factory built elsewhere, as a protocol fixture does. */
export function useConnectorFactory(registry: ConnectorRegistry, factory: ConnectorFactory): void {
  factories.set(registry, factory);
  keepReleasing(registry, factory.options);
}

/** A stdio server's volumes outlive its connector; a gone connection's are removed all the same. */
function keepReleasing(registry: ConnectorRegistry, options: ConnectorOptions): void {
  const launcher = options.stdioLauncher;
  if (launcher) registry.addReleaser((connectionId) => launcher.destroy(connectionId));
}

export async function configuredConnectors(options: ConnectorOptions) {
  const registry = new ConnectorRegistry();
  const factory = new ConnectorFactory(options);
  factories.set(registry, factory);
  keepReleasing(registry, options);
  // Publishing by email uses the mailbox the owner already configured. The
  // artifacts connector is therefore registered after the loop, so the order
  // connections happen to appear in does not decide whether it can mail.
  const pending: Array<() => Promise<void>> = [];
  // A space under removal is never served again, including by a process that
  // starts while its removal is still running or is waiting on something that
  // blocked it. Its connection rows go in a later phase of that removal.
  const connections = await options.sql`select c.* from connection c
    join space s on s.id = c.space_id
    where c.status = 'active' and s.removed_at is null
    order by c.id`;
  if (options.enableTestConnector) await initializeTestLedger(options.sql);
  try {
    for (const row of connections) {
      const source: ConnectionSource = {
        id: row.id,
        spaceId: row.space_id,
        provider: row.provider,
        secretRef: row.secret_ref,
        configuration: row.configuration,
      };
      // One connection that cannot be opened is that connection's problem, not
      // the service's: it is marked failing, as a failed installation is, and
      // testing it again reopens it. Nothing it threw is written anywhere. A
      // connection the operator configured is the deployment's own setting, so
      // a refusal there (an unisolated stdio launch, say) still stops the start.
      const operatorConfigured = options.connections?.some((entry) => entry.id === source.id);
      const open = async () => {
        let connector: Connector | undefined;
        try {
          connector = await factory.open(source);
        } catch (error) {
          if (operatorConfigured) throw error;
          await options.sql`update connection set status = 'error', setup_state = 'error',
            health = 'failing', last_checked_at = now()
            where id = ${source.id} and status = 'active'`;
          process.stderr.write(`connection ${source.id} could not be opened and is marked failing
`);
          return;
        }
        if (connector) factory.register(registry, source.id, connector);
      };
      if (row.provider === 'artifacts') pending.push(open);
      else await open();
    }
    for (const register of pending) await register();
  } catch (error) {
    await registry.close();
    throw error;
  }
  return registry;
}

/** The connector options a validated environment implies. */
type ConnectorExtras = {
  connections?: ConfiguredConnection[];
  browserSessions?: BrowserSessionService;
  stdioLauncher?: StdioLauncher;
  stdioLifecycle?: StdioLifecycleOptions;
};

export function connectorOptionsFromEnv(
  sql: Sql,
  env: Env,
  extra: ConnectorExtras = {},
): ConnectorOptions {
  return {
    sql,
    workRoot: env.MELETE_WORK_DIR,
    spacesRoot: env.MELETE_SPACES_DIR,
    masterKey: env.MELETE_MASTER_KEY,
    connections: extra.connections,
    enableTestConnector: env.MELETE_ENABLE_TEST_CONNECTOR,
    browserSessions: extra.browserSessions,
    stdioLauncher: extra.stdioLauncher,
    stdioLifecycle: { idleMs: env.MELETE_MCP_IDLE_MS },
    cellIsolated: builtinEnvironment(env).cellIsolated,
    ...(env.MELETE_SANDBOX_PROJECT
      ? {
          sandbox: {
            sessions: new SandboxSessions(sql, {
              leaseSeconds: env.MELETE_SANDBOX_LEASE_SECONDS,
              workspaceRetentionSeconds: env.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS,
            }),
            project: env.MELETE_SANDBOX_PROJECT,
            e2bPlan: env.MELETE_E2B_PLAN,
            snapshotTtlSeconds: env.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS,
            maxConcurrent: env.MELETE_SANDBOX_MAX_CONCURRENT,
            modalRefusal: modalEnvironmentRefusal(
              process.env,
              env.MELETE_SANDBOX_ALLOW_PROXY_ENVIRONMENT,
            ),
          },
        }
      : {}),
    env: {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
      OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
      MELETE_SPEECH_MODEL: env.MELETE_SPEECH_MODEL,
      MELETE_ENABLE_FAKE_PROVIDER: String(env.MELETE_ENABLE_FAKE_PROVIDER),
    },
  };
}

/** Both listeners build catalogs from the validated startup environment. */
export async function connectorsFromEnv(sql: Sql, env: Env, extra: ConnectorExtras = {}) {
  return configuredConnectors(
    connectorOptionsFromEnv(sql, env, {
      ...extra,
      connections: extra.connections ?? (await readConnectionConfig(env.MELETE_CONNECTIONS_FILE)),
    }),
  );
}
