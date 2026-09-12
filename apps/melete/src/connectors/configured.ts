import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { capabilitiesFromEnv } from '../gateway/capabilities.ts';
import { browserArtifactSink } from '../workers/browser/artifacts.ts';
import { type BrowserWorkerEndpoint, BrowserWorkerPool } from '../workers/browser/client.ts';
import { PostgresBrowserRecipeStore } from '../workers/browser/recipes.ts';
import { BrowserSessionService } from '../workers/browser/routes.ts';
import { createArtifactsConnector } from './artifacts.ts';
import { createBrowserConnector } from './browser.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector } from './email.ts';
import { createExecConnector } from './exec.ts';
import { createFilesConnector } from './files.ts';
import { mcpServerConfig } from './mcp.ts';
import { openConfiguredMcpConnector } from './mcp-connector.ts';
import { ConnectorRegistry } from './registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from './secrets.ts';
import { createTestConnector, initializeTestLedger } from './test.ts';
import { createCapabilityConnector } from './tts.ts';
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
  return path ? z.array(configuredConnection).parse(JSON.parse(await readFile(path, 'utf8'))) : [];
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

export async function configuredConnectors(options: {
  sql: Sql;
  workRoot: string;
  spacesRoot: string;
  masterKey?: string;
  connections?: ConfiguredConnection[];
  enableTestConnector?: boolean;
  /** Reads the same environment the gateway does, so one key configures both. */
  env?: Record<string, string | undefined>;
  browserSessions?: BrowserSessionService;
}) {
  const registry = new ConnectorRegistry();
  // Publishing by email uses the mailbox the owner already configured. The
  // artifacts connector is therefore registered after the loop, so the order
  // connections happen to appear in does not decide whether it can mail.
  const pending: Array<() => void> = [];
  const mailers = new Map<string, ReturnType<EmailConnector['asMailer']>>();
  const secrets = new SealedSecretStore(
    new PostgresSecretRepository(options.sql),
    () => options.masterKey,
  );
  const config = new Map((options.connections ?? []).map((entry) => [entry.id, entry]));
  if (config.size !== (options.connections ?? []).length)
    throw new Error('Duplicate configured connection id');
  const connections =
    await options.sql`select * from connection where status = 'active' order by id`;
  if (options.enableTestConnector) await initializeTestLedger(options.sql);
  try {
    for (const row of connections) {
      const setting =
        config.get(row.id) ??
        (row.provider === 'mcp' && row.configuration?.server
          ? {
              kind: 'mcp' as const,
              id: row.id,
              server: mcpServerConfig.parse(row.configuration.server),
            }
          : undefined);
      if (row.provider === 'generation') {
        // A capability is registered like any other connector, so a generation
        // call takes the path approval, fencing, budget and idempotency already
        // hold. A second path to the world would be a second place to get those
        // right.
        const configured = capabilitiesFromEnv(options.env ?? process.env);
        if (!configured.speech) continue;
        registry.register(
          row.id,
          createCapabilityConnector({
            spacesRoot: options.spacesRoot,
            adapter: configured.speech,
            provider: configured.provider,
            unitCostUsd: configured.unitCostUsd,
          }),
        );
      } else if (row.provider === 'files') registry.register(row.id, createFilesConnector(options));
      else if (row.provider === 'exec') registry.register(row.id, createExecConnector(options));
      else if (row.provider === 'artifacts') {
        const id = row.id;
        pending.push(() =>
          registry.register(
            id,
            createArtifactsConnector({
              sql: options.sql,
              workRoot: options.workRoot,
              spacesRoot: options.spacesRoot,
              mailers,
            }),
          ),
        );
      } else if (row.provider === 'web' && setting?.kind === 'browser') {
        if (!options.browserSessions) throw new Error('Browser session service is not configured');
        registry.register(
          row.id,
          createBrowserConnector({
            sessions: options.browserSessions,
            artifacts: browserArtifactSink(options.sql, options.spacesRoot),
            recipes: new PostgresBrowserRecipeStore(options.sql),
            spaceId: row.space_id,
          }),
        );
      } else if (row.provider === 'web') registry.register(row.id, createWebConnector());
      else if (row.provider === 'test' && options.enableTestConnector)
        registry.register(row.id, createTestConnector(options.sql));
      else if (row.provider === 'imap' && setting?.kind === 'email' && row.secret_ref) {
        const email = new EmailConnector(
          { ...setting, spaceId: row.space_id, secretRef: row.secret_ref },
          secrets,
        );
        registry.register(row.id, email);
        mailers.set(row.id, email.asMailer());
      } else if (row.provider === 'caldav' && setting?.kind === 'caldav' && row.secret_ref) {
        registry.register(
          row.id,
          new CalendarConnector(
            { ...setting, spaceId: row.space_id, secretRef: row.secret_ref, mode: 'caldav' },
            secrets,
          ),
        );
      } else if (row.provider === 'mcp' && setting?.kind === 'mcp') {
        registry.register(
          row.id,
          await openConfiguredMcpConnector(
            setting.server,
            { connectionId: row.id, spaceId: row.space_id },
            options.sql,
            secrets,
          ),
        );
      } else if (row.provider === 'caldav' && setting?.kind === 'ics') {
        registry.register(
          row.id,
          new CalendarConnector(
            {
              id: row.id,
              spaceId: row.space_id,
              mode: 'ics',
              ics: await readFile(setting.icsPath, 'utf8'),
            },
            secrets,
          ),
        );
      }
    }
  } catch (error) {
    await registry.close();
    throw error;
  }
  for (const register of pending) register();
  return registry;
}

/** Both listeners build catalogs from the validated startup environment. */
export async function connectorsFromEnv(
  sql: Sql,
  env: Env,
  extra: { connections?: ConfiguredConnection[]; browserSessions?: BrowserSessionService } = {},
) {
  return configuredConnectors({
    sql,
    workRoot: env.MELETE_WORK_DIR,
    spacesRoot: env.MELETE_SPACES_DIR,
    masterKey: env.MELETE_MASTER_KEY,
    connections: extra.connections ?? (await readConnectionConfig(env.MELETE_CONNECTIONS_FILE)),
    enableTestConnector: env.MELETE_ENABLE_TEST_CONNECTOR,
    browserSessions: extra.browserSessions,
    env: {
      OPENAI_API_KEY: env.OPENAI_API_KEY,
      OPENAI_COMPAT_BASE_URL: env.OPENAI_COMPAT_BASE_URL,
      OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY,
      MELETE_SPEECH_MODEL: env.MELETE_SPEECH_MODEL,
      MELETE_ENABLE_FAKE_PROVIDER: String(env.MELETE_ENABLE_FAKE_PROVIDER),
    },
  });
}
