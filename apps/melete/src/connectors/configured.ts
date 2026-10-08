import { readFile } from 'node:fs/promises';
import {
  type ConnectorHealth,
  caldavConnectionConfig,
  mailConnectionConfig,
  sandboxAdapterTakesKey,
} from '@melete/contracts';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { jobPaidMeter } from '../broker/paid-meter.ts';
import { createDeviceConnector } from '../devices/connector.ts';
import type { DeviceHub } from '../devices/hub.ts';
import {
  COMMAND_LINE_SERVICE,
  type CommandLineCheckOptions,
  commandLineAccount,
} from '../egress/adapters/accounts.ts';
import { awsAccount, awsAdapterConfig } from '../egress/adapters/aws.ts';
import { credentialAdapters } from '../egress/adapters/index.ts';
import { parseAwsSecret, type StsOptions } from '../egress/aws-session.ts';
import { createCommandLineConnector } from '../egress/connector.ts';
import { egressRecorder } from '../egress/records.ts';
import { egressCredentialsFromEnv } from '../egress/wiring.ts';
import type { Env } from '../env.ts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import type { GatewaySpending } from '../gateway/types.ts';
import { multiplayerEnabled } from '../rooms/preview.ts';
import type { DockerSandboxSettings } from '../sandbox/adapters/docker.ts';
import {
  createSandboxProvider,
  modalEnvironmentRefusal,
  sandboxCredentialValue,
  sandboxTeardownProviders,
  storedSandboxConnection,
} from '../sandbox/connection.ts';
import { dockerSandboxSettings } from '../sandbox/docker-default.ts';
import { SandboxProcesses } from '../sandbox/processes.ts';
import { SandboxSessions } from '../sandbox/sessions.ts';
import type { SandboxProvider } from '../sandbox/types.ts';
import { type BlobStore, configuredBlobStore } from '../storage/blob.ts';
import { browserArtifactSink } from '../workers/browser/artifacts.ts';
import { type BrowserWorkerEndpoint, BrowserWorkerPool } from '../workers/browser/client.ts';
import { PostgresBrowserRecipeStore } from '../workers/browser/recipes.ts';
import { BrowserSessionService } from '../workers/browser/routes.ts';
import { createAppsConnector } from './apps.ts';
import { createArtifactsConnector } from './artifacts.ts';
import { createBrowserConnector } from './browser.ts';
import { builtinEnvironment } from './builtin.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector } from './email.ts';
import { createExecConnector } from './exec.ts';
import { createFilesConnector, type SentFiles } from './files.ts';
import { GmailApiTransport } from './gmail.ts';
import { GOOGLE_ENDPOINTS, type GoogleEndpoints, googleIssuer } from './google.ts';
import { GoogleCalendarConnector } from './google-calendar.ts';
import { GoogleDriveConnector } from './google-drive.ts';
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
import { type MicrosoftEndpoints, microsoftEndpoints, microsoftIssuer } from './microsoft.ts';
import { createNotesConnector } from './notes.ts';
import { OutlookCalendarConnector } from './outlook-calendar.ts';
import { OutlookMailTransport } from './outlook-mail.ts';
import { asFetch, reachFetch, spaceReach } from './public-fetch.ts';
import { ConnectorRegistry } from './registry.ts';
import { createRoomConnector } from './room.ts';
import { createSandboxExecConnector } from './sandbox-exec.ts';
import { PostgresSecretRepository, SealedSecretStore } from './secrets.ts';
import { type AccountClient, signedInAccess } from './signed-in.ts';
import { createSkillsConnector } from './skills.ts';
import { createTestConnector, initializeTestLedger } from './test.ts';
import { createTranscriptionConnector } from './transcribe.ts';
import { createCapabilityConnector } from './tts.ts';
import type { Connector } from './types.ts';
import {
  createWebConnector,
  databasePublicReads,
  type PrivateContext,
  type SearchPrivacy,
} from './web.ts';
import {
  type PageExtractor,
  type WebSearch,
  webExtractFromEnv,
  webSearchFromEnv,
} from './web-search.ts';

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
  /** How many days a delete stays in the trash (`MELETE_TRASH_DAYS`). */
  trashDays?: number;
  /** The most one conversation's trash holds, in bytes (`MELETE_TRASH_MAX_MB`). */
  trashMaxBytes?: number;
  masterKey?: string;
  connections?: ConfiguredConnection[];
  enableTestConnector?: boolean;
  /** Reads the same environment the gateway does, so one key configures both. */
  env?: Record<string, string | undefined>;
  browserSessions?: BrowserSessionService;
  /** True when attempts run in a container; a default exec connection is inert without it. */
  cellIsolated?: boolean;
  /**
   * Whether rooms are switched on (`MELETE_PREVIEW_MULTIPLAYER`). Off, a room
   * connection offers nothing. Left out, it is read from `env`.
   */
  multiplayer?: boolean;
  /**
   * Whether a space or agent is private. A private one reads no public web
   * pages beyond what a job was explicitly given. Without it, none is.
   */
  privateContext?: PrivateContext;
  /**
   * Why what is written in a job is private, as memory records it: the agent's
   * notes from a private conversation are read back only on the person's own
   * model. Without it, every note is treated as private.
   */
  privacyOrigin?: (jobId: string, text: string) => Promise<string | null>;
  /** Where `web.search` searches; without one, the keyless search only. */
  webSearch?: WebSearch;
  /** A hosted reader for a public page `web.fetch` got no text from; without one, none. */
  webExtract?: PageExtractor;
  /** The installation's spending caps, which paid search and reading calls count toward. */
  spending?: GatewaySpending;
  /** Whether a query may go to an outside search; without one, none does. */
  searchPrivacy?: SearchPrivacy;
  /** The files people sent in chat, which the agent may save into its workspace. */
  attachments?: SentFiles;
  /** Plaintext mail and CalDAV to a loopback protocol fixture. Never set from a request. */
  insecureLocalFixtures?: boolean;
  /** Starts stdio MCP servers in isolation; without one, a stdio installation offers nothing. */
  stdioLauncher?: StdioLauncher;
  stdioLifecycle?: StdioLifecycleOptions;
  /** Everything a sandbox connection needs besides its own row. */
  sandbox?: SandboxRuntimeOptions;
  /** Where published apps keep their files. Without it, an apps connection offers nothing. */
  blobs?: BlobStore;
  /** Where work for paired computers waits. Left out, the process's shared hub. */
  devices?: DeviceHub;
  /**
   * The operator's Google OAuth client. Without it, Google sign-in is not
   * offered and a Google connection offers nothing. Only a test replaces the
   * endpoints.
   */
  google?: { client: AccountClient; endpoints?: GoogleEndpoints };
  /** The operator's Microsoft client, as for Google; `tenant` is `common` unless named. */
  microsoft?: { client: AccountClient; tenant?: string; endpoints?: MicrosoftEndpoints };
  /** Where a command-line account's own check goes. Only a test replaces it. */
  commandLine?: CommandLineCheckOptions & { awsSts?: StsOptions };
  /** Server addresses for app catalog entries, by entry id. Only a test replaces them. */
  mcpCatalogUrls?: Record<string, string>;
};

/**
 * What the service brings to a sandbox connection: the session table, the
 * label that says which sandboxes are this installation's, and the settings an
 * adapter cannot decide for itself.
 */
export type SandboxRuntimeOptions = {
  sessions: SandboxSessions;
  /** Background processes in agents' computers, with their caps. */
  processes?: SandboxProcesses;
  project: string;
  e2bPlan: 'hobby' | 'pro';
  snapshotTtlSeconds: number;
  /** The whole installation's ceiling, over every connection. */
  maxConcurrent: number;
  /** One connection's own allowance, which defaults to that ceiling. */
  maxPerConnection: number;
  /** Set when this environment could redirect Modal's traffic; then Modal is refused. */
  modalRefusal: string | null;
  /** Replaces E2B's HTTP transport. Only a test fixture passes one. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** The engine the docker adapter runs sandboxes on, and their limits. */
  docker?: DockerSandboxSettings;
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
  z.object({ kind: z.literal('gmail'), account: z.email() }),
  z.object({ kind: z.literal('google_calendar'), account: z.email() }),
  z.object({ kind: z.literal('google_drive'), account: z.email() }),
  z.object({ kind: z.literal('outlook_mail'), account: z.email() }),
  z.object({ kind: z.literal('outlook_calendar'), account: z.email() }),
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

  /**
   * Providers for tearing down the sandboxes of any connection, a space under
   * removal included, or undefined when this installation owns no sandboxes.
   */
  sandboxTeardownProviders() {
    const sandbox = this.options.sandbox;
    if (!sandbox) return undefined;
    return sandboxTeardownProviders({
      sql: this.options.sql,
      secrets: this.secrets,
      project: sandbox.project,
      e2bPlan: sandbox.e2bPlan,
      snapshotTtlSeconds: sandbox.snapshotTtlSeconds,
      modalRefusal: sandbox.modalRefusal,
      ...(sandbox.fetch ? { fetch: sandbox.fetch } : {}),
      ...(sandbox.docker ? { docker: sandbox.docker } : {}),
    });
  }

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
      // Speech and transcription are separate default rows, told apart by which default each is.
      if (row.configuration?.builtin === 'transcription') {
        if (!configured.transcription) return undefined;
        return createTranscriptionConnector({
          workRoot: options.workRoot,
          spacesRoot: options.spacesRoot,
          adapter: configured.transcription,
          provider: configured.provider,
          unitCostUsd: configured.transcriptionUnitCostUsd,
        });
      }
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
    if (row.provider === 'room')
      // Rooms switched off: the rows stay, and none of their tools is offered.
      return !(options.multiplayer ?? multiplayerEnabled(options.env ?? process.env))
        ? undefined
        : createRoomConnector({
            sql: options.sql,
            workRoot: options.workRoot,
            spacesRoot: options.spacesRoot,
          });
    if (row.provider === 'skills')
      return createSkillsConnector({ sql: options.sql, spacesRoot: options.spacesRoot });
    if (row.provider === 'notes')
      return createNotesConnector({
        sql: options.sql,
        ...(options.privacyOrigin ? { privacyOrigin: options.privacyOrigin } : {}),
      });
    if (row.provider === 'artifacts')
      return createArtifactsConnector({
        sql: options.sql,
        workRoot: options.workRoot,
        spacesRoot: options.spacesRoot,
        mailers: this.mailers,
      });
    if (row.provider === 'apps')
      return options.blobs
        ? createAppsConnector({
            sql: options.sql,
            workRoot: options.workRoot,
            blobs: options.blobs,
          })
        : undefined;
    if (row.provider === 'web' && setting?.kind === 'browser') {
      if (!options.browserSessions) throw new Error('Browser session service is not configured');
      return createBrowserConnector({
        sessions: options.browserSessions,
        artifacts: browserArtifactSink(options.sql, options.spacesRoot),
        recipes: new PostgresBrowserRecipeStore(options.sql),
        spaceId: row.spaceId,
      });
    }
    if (row.provider === 'web')
      return createWebConnector({
        publicReads: databasePublicReads({
          sql: options.sql,
          connectionId: row.id,
          privateContext: options.privateContext,
        }),
        ...(options.webSearch ? { search: options.webSearch } : {}),
        ...(options.webExtract ? { extract: options.webExtract } : {}),
        // Paid search and reading calls are charged to the job that made them.
        meter: jobPaidMeter(options.sql, options.spending),
        ...(options.searchPrivacy ? { searchPrivacy: options.searchPrivacy } : {}),
      });
    if (row.provider === 'sandbox' && stored?.kind === 'sandbox') {
      const sandbox = options.sandbox;
      const keyed = sandboxAdapterTakesKey(stored.sandbox.adapter);
      if (!sandbox || (keyed && !row.secretRef)) return undefined;
      if (stored.sandbox.adapter === 'modal' && sandbox.modalRefusal)
        throw new Error(sandbox.modalRefusal);
      const config = stored.sandbox;
      const opened = createSandboxProvider(config, {
        // The key is read from the row on every call rather than kept from
        // when this connector was built: a key switch replaces it in place,
        // and a revocation removes it, without this connector being rebuilt.
        credential: async (use) => {
          const [current] = await options.sql`select status, secret_ref from connection
            where id = ${row.id}`;
          if (!current?.secret_ref || current.status === 'revoked')
            throw new Error('this sandbox connection no longer holds a provider key');
          return this.secrets.withSecret(String(current.secret_ref), row.spaceId, (sealed) =>
            use(sandboxCredentialValue(config.adapter, sealed)),
          );
        },
        project: sandbox.project,
        e2bPlan: sandbox.e2bPlan,
        snapshotTtlSeconds: sandbox.snapshotTtlSeconds,
        ...(sandbox.fetch ? { fetch: sandbox.fetch } : {}),
        ...(sandbox.docker ? { docker: sandbox.docker } : {}),
      });
      this.sandboxProviders.set(row.id, {
        adapter: config.adapter,
        provider: opened.provider,
      });
      const connector = createSandboxExecConnector({
        sessions: sandbox.sessions,
        provider: opened.provider,
        config,
        connectionId: row.id,
        spaceId: row.spaceId,
        project: sandbox.project,
        workRoot: options.workRoot,
        sql: options.sql,
        ...(options.trashDays ? { trashDays: options.trashDays } : {}),
        ...(options.trashMaxBytes ? { trashMaxBytes: options.trashMaxBytes } : {}),
        e2bPlan: sandbox.e2bPlan,
        maxConcurrent: sandbox.maxConcurrent,
        maxPerConnection: sandbox.maxPerConnection,
        ...(sandbox.processes ? { processes: sandbox.processes } : {}),
        close: opened.close,
      });
      // A sandbox runs whatever it is asked to, so it is never offered to a public compartment.
      return ownerOnly(connector);
    }
    if (row.provider === 'device') {
      // The computer's own row says whether it still stands; a revoked one offers nothing.
      const deviceId = row.configuration?.device_id;
      if (typeof deviceId !== 'string') return undefined;
      const [device] = await options.sql`select id, name from paired_device
        where id = ${deviceId} and connection_id = ${row.id} and revoked_at is null`;
      if (!device) return undefined;
      return ownerOnly(
        createDeviceConnector({
          deviceId,
          connectionId: row.id,
          name: String(device.name),
          sql: options.sql,
          workRoot: options.workRoot,
          ...(options.devices ? { hub: options.devices } : {}),
        }),
      );
    }
    if (row.provider === 'test' && options.enableTestConnector)
      return createTestConnector(options.sql);
    if (row.provider === 'command_line') {
      // Its account is used by the egress relay; the connector only carries its writes' admission.
      const adapter = row.configuration?.kind === 'command_line' ? row.configuration.adapter : null;
      const offered = credentialAdapters({ test: options.enableTestConnector === true });
      if (typeof adapter !== 'string' || !offered.has(adapter as never)) return undefined;
      const secretRef = row.secretRef;
      // An account is checked by asking its service whose token it is.
      const service =
        adapter in COMMAND_LINE_SERVICE ? (adapter as keyof typeof COMMAND_LINE_SERVICE) : null;
      const health =
        service && secretRef
          ? async (): Promise<ConnectorHealth> => {
              const checked = await this.secrets.withSecret(secretRef, row.spaceId, (token) =>
                commandLineAccount(service, token, {
                  ...options.commandLine,
                  signal: AbortSignal.timeout(20_000),
                }),
              );
              const checkedAt = new Date().toISOString();
              const name = COMMAND_LINE_SERVICE[service];
              return checked.ok
                ? { status: 'ok', detail: `${name} answered.`, checked_at: checkedAt }
                : {
                    status: 'failing',
                    detail: `${name} did not answer for this account.`,
                    checked_at: checkedAt,
                    ...(checked.code === 'credential_refused'
                      ? { reason: 'credential_refused' as const }
                      : {}),
                  };
            }
          : adapter === 'aws' && secretRef
            ? async (): Promise<ConnectorHealth> => {
                const checked = await this.secrets
                  .withSecret(secretRef, row.spaceId, async (secret) =>
                    awsAccount(
                      parseAwsSecret(secret),
                      awsAdapterConfig.parse(
                        (row.configuration as { config?: unknown } | null)?.config,
                      ),
                      options.commandLine?.awsSts ?? {},
                    ),
                  )
                  .catch(() => ({ ok: false as const, code: 'unavailable' as const }));
                const checkedAt = new Date().toISOString();
                return checked.ok
                  ? { status: 'ok', detail: 'AWS answered.', checked_at: checkedAt }
                  : {
                      status: 'failing',
                      detail: 'AWS did not answer for this account.',
                      checked_at: checkedAt,
                      ...(checked.code === 'credential_refused'
                        ? { reason: 'credential_refused' as const }
                        : {}),
                    };
              }
            : undefined;
      return ownerOnly(createCommandLineConnector(adapter as never, health ? { health } : {}));
    }
    if (
      (stored?.kind === 'gmail' && row.provider === 'imap') ||
      (stored?.kind === 'google_calendar' && row.provider === 'caldav') ||
      (stored?.kind === 'google_drive' && row.provider === 'drive')
    ) {
      const google = options.google;
      if (!google || !row.secretRef) return undefined;
      const endpoints = google.endpoints ?? GOOGLE_ENDPOINTS;
      const access = signedInAccess({
        sql: options.sql,
        secrets: this.secrets,
        connectionId: row.id,
        spaceId: row.spaceId,
        // A refresh sends no redirect address.
        issuer: googleIssuer(google.client, '', endpoints),
      });
      if (stored.kind === 'google_drive')
        return ownerOnly(
          new GoogleDriveConnector({
            id: row.id,
            spaceId: row.spaceId,
            base: endpoints.drive,
            access,
          }),
        );
      if (stored.kind === 'google_calendar')
        return ownerOnly(
          new GoogleCalendarConnector({
            id: row.id,
            spaceId: row.spaceId,
            base: endpoints.calendar,
            access,
          }),
        );
      const transport = new GmailApiTransport({
        base: endpoints.gmail,
        from: stored.account,
        access,
      });
      return ownerOnly(
        new EmailConnector({
          kind: 'api',
          id: row.id,
          spaceId: row.spaceId,
          from: stored.account,
          session: (work) => work(transport),
        }),
      );
    }
    if (
      (stored?.kind === 'outlook_mail' && row.provider === 'imap') ||
      (stored?.kind === 'outlook_calendar' && row.provider === 'caldav')
    ) {
      const microsoft = options.microsoft;
      if (!microsoft || !row.secretRef) return undefined;
      const endpoints = microsoft.endpoints ?? microsoftEndpoints(microsoft.tenant);
      const access = signedInAccess({
        sql: options.sql,
        secrets: this.secrets,
        connectionId: row.id,
        spaceId: row.spaceId,
        issuer: microsoftIssuer(microsoft.client, '', endpoints),
      });
      if (stored.kind === 'outlook_calendar')
        return ownerOnly(
          new OutlookCalendarConnector({
            id: row.id,
            spaceId: row.spaceId,
            base: endpoints.graph,
            access,
          }),
        );
      const transport = new OutlookMailTransport({
        base: endpoints.graph,
        from: stored.account,
        access,
      });
      return ownerOnly(
        new EmailConnector({
          kind: 'api',
          id: row.id,
          spaceId: row.spaceId,
          from: stored.account,
          session: (work) => work(transport),
        }),
      );
    }
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
            // Added in the app, so its servers are held to the space's reach.
            reach: await spaceReach(options.sql, row.spaceId),
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
          // Added in the app: every request is checked and pinned to the space's reach.
          asFetch(reachFetch({ reach: await spaceReach(options.sql, row.spaceId) })),
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
  // A key switch pauses its connection while it undoes what the old key did,
  // and puts it back if the switch does not commit. A process that stopped
  // part way never did, so a restart does: the switch was not made, the old
  // key is still the connection's, and the person can switch again. An
  // interrupted revocation is finished instead (`finishInterruptedRevocations`),
  // and a connection disabled for any other reason is left alone.
  await options.sql`update connection set status = 'active', key_change = null
    where status = 'disabled' and key_change = 'switch'`;
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
  privateContext?: PrivateContext;
  privacyOrigin?: ConnectorOptions['privacyOrigin'];
  webSearch?: WebSearch;
  searchPrivacy?: SearchPrivacy;
  attachments?: SentFiles;
  spending?: GatewaySpending;
};

/** The docker settings, with egress records and, where offered, command-line accounts. */
function dockerWithEgress(sql: Sql, env: Env): DockerSandboxSettings {
  const accounts = egressCredentialsFromEnv(sql, env);
  return {
    ...dockerSandboxSettings(env),
    egressRecords: egressRecorder(sql),
    ...(accounts
      ? { egressCredentials: accounts.credentials, egressIntercept: accounts.intercept }
      : {}),
  };
}

function sandboxOptions(sql: Sql, env: Env): NonNullable<ConnectorOptions['sandbox']> {
  const sessions = new SandboxSessions(sql, {
    leaseSeconds: env.MELETE_SANDBOX_LEASE_SECONDS,
    workspaceRetentionSeconds: env.MELETE_SANDBOX_WORKSPACE_RETENTION_SECONDS,
  });
  return {
    sessions,
    processes: new SandboxProcesses(sql, {
      limits: {
        maxPerComputer: env.MELETE_PROCESS_MAX_PER_COMPUTER,
        maxPerSpace: env.MELETE_PROCESS_MAX_PER_SPACE,
        defaultTtlMinutes: env.MELETE_PROCESS_DEFAULT_TTL_MINUTES,
        maxTtlMinutes: env.MELETE_PROCESS_MAX_TTL_MINUTES,
        outputMaxBytes: env.MELETE_PROCESS_OUTPUT_MAX_BYTES,
        awakeSecondsPerDay: env.MELETE_SANDBOX_AWAKE_SECONDS_PER_DAY,
      },
    }),
    project: env.MELETE_SANDBOX_PROJECT ?? '',
    e2bPlan: env.MELETE_E2B_PLAN,
    snapshotTtlSeconds: env.MELETE_SANDBOX_SNAPSHOT_TTL_SECONDS,
    maxConcurrent: env.MELETE_SANDBOX_MAX_CONCURRENT,
    maxPerConnection:
      env.MELETE_SANDBOX_MAX_CONCURRENT_PER_CONNECTION ?? env.MELETE_SANDBOX_MAX_CONCURRENT,
    modalRefusal: modalEnvironmentRefusal(process.env, env.MELETE_SANDBOX_ALLOW_PROXY_ENVIRONMENT),
    // The idle stop asks the process records which containers are in use.
    docker: { ...dockerWithEgress(sql, env), awake: () => sessions.awakeSandboxes('docker') },
  };
}

export function connectorOptionsFromEnv(
  sql: Sql,
  env: Env,
  extra: ConnectorExtras = {},
): ConnectorOptions {
  return {
    sql,
    workRoot: env.MELETE_WORK_DIR,
    spacesRoot: env.MELETE_SPACES_DIR,
    trashDays: env.MELETE_TRASH_DAYS,
    trashMaxBytes: env.MELETE_TRASH_MAX_MB * 1024 * 1024,
    masterKey: env.MELETE_MASTER_KEY,
    connections: extra.connections,
    enableTestConnector: env.MELETE_ENABLE_TEST_CONNECTOR,
    browserSessions: extra.browserSessions,
    stdioLauncher: extra.stdioLauncher,
    stdioLifecycle: { idleMs: env.MELETE_MCP_IDLE_MS },
    privateContext: extra.privateContext,
    ...(extra.privacyOrigin ? { privacyOrigin: extra.privacyOrigin } : {}),
    // Configured search keys apply even where no model gateway searches.
    webSearch: extra.webSearch ?? webSearchFromEnv(env),
    webExtract: webExtractFromEnv(env),
    ...(extra.spending ? { spending: extra.spending } : {}),
    ...(extra.searchPrivacy ? { searchPrivacy: extra.searchPrivacy } : {}),
    attachments: extra.attachments,
    cellIsolated: builtinEnvironment(env).cellIsolated,
    multiplayer: env.MELETE_PREVIEW_MULTIPLAYER,
    // Nothing is created until the first write.
    blobs: configuredBlobStore(env),
    ...(env.MICROSOFT_OAUTH_CLIENT_ID && env.MICROSOFT_OAUTH_CLIENT_SECRET
      ? {
          microsoft: {
            client: {
              clientId: env.MICROSOFT_OAUTH_CLIENT_ID,
              clientSecret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
            },
            tenant: env.MICROSOFT_OAUTH_TENANT,
          },
        }
      : {}),
    ...(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
      ? {
          google: {
            client: {
              clientId: env.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            },
          },
        }
      : {}),
    ...(env.MELETE_SANDBOX_PROJECT ? { sandbox: sandboxOptions(sql, env) } : {}),
    // Everything capabilitiesFromEnv reads: the default speech and transcription
    // rows are created from the full environment, so a provider left out here
    // would leave them installed with nothing running behind them.
    env: {
      ELEVENLABS_API_KEY: env.ELEVENLABS_API_KEY,
      ELEVENLABS_VOICE_ID: env.ELEVENLABS_VOICE_ID,
      ELEVENLABS_SECOND_VOICE_ID: env.ELEVENLABS_SECOND_VOICE_ID,
      ELEVENLABS_SPEECH_MODEL: env.ELEVENLABS_SPEECH_MODEL,
      ELEVENLABS_STREAMING_MODEL: env.ELEVENLABS_STREAMING_MODEL,
      ELEVENLABS_TRANSCRIPTION_MODEL: env.ELEVENLABS_TRANSCRIPTION_MODEL,
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
