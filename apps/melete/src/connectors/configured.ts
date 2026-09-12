import { readFile } from 'node:fs/promises';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { createArtifactsConnector } from './artifacts.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector } from './email.ts';
import { createExecConnector } from './exec.ts';
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
]);
export type ConfiguredConnection = z.infer<typeof configuredConnection>;

/** This owner-controlled file contains endpoints, never passwords or runtime-provided settings. */
export async function readConnectionConfig(path?: string): Promise<ConfiguredConnection[]> {
  return path ? z.array(configuredConnection).parse(JSON.parse(await readFile(path, 'utf8'))) : [];
}

export async function configuredConnectors(options: {
  sql: Sql;
  workRoot: string;
  spacesRoot: string;
  masterKey?: string;
  connections?: ConfiguredConnection[];
  enableTestConnector?: boolean;
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
    await options.sql`select id, space_id, provider, secret_ref from connection where status = 'active' order by id`;
  if (options.enableTestConnector) await initializeTestLedger(options.sql);
  for (const row of connections) {
    const setting = config.get(row.id);
    if (row.provider === 'files') registry.register(row.id, createFilesConnector(options));
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
  for (const register of pending) register();
  return registry;
}
