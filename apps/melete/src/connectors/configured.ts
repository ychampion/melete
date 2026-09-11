import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Env } from '../env.ts';
import { browserArtifactSink } from '../workers/browser/artifacts.ts';
import { type BrowserWorkerEndpoint, BrowserWorkerPool } from '../workers/browser/client.ts';
import { PostgresBrowserRecipeStore } from '../workers/browser/recipes.ts';
import { BrowserSessionService } from '../workers/browser/routes.ts';
import { createBrowserConnector } from './browser.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector } from './email.ts';
import { createFilesConnector } from './files.ts';
import { ConnectorRegistry } from './registry.ts';
import { PostgresSecretRepository, SealedSecretStore } from './secrets.ts';
import { createTestConnector, initializeTestLedger } from './test.ts';
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
  browserSessions?: BrowserSessionService;
}) {
  const registry = new ConnectorRegistry();
  const secrets = new SealedSecretStore(
    new PostgresSecretRepository(options.sql),
    () => options.masterKey,
  );
  const config = new Map((options.connections ?? []).map((entry) => [entry.id, entry]));
  if (config.size !== (options.connections ?? []).length)
    throw new Error('Duplicate configured connection id');
  const connections =
    await options.sql`select id, space_id, provider, secret_ref from connection where status = 'active' order by id`;
  if (options.enableTestConnector) await initializeTestLedger(options.sql);
  for (const row of connections) {
    const setting = config.get(row.id);
    if (row.provider === 'files') registry.register(row.id, createFilesConnector(options));
    else if (row.provider === 'web' && setting?.kind === 'browser') {
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
      registry.register(
        row.id,
        new EmailConnector(
          { ...setting, spaceId: row.space_id, secretRef: row.secret_ref },
          secrets,
        ),
      );
    } else if (row.provider === 'caldav' && setting?.kind === 'caldav' && row.secret_ref) {
      registry.register(
        row.id,
        new CalendarConnector(
          { ...setting, spaceId: row.space_id, secretRef: row.secret_ref, mode: 'caldav' },
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
  return registry;
}
