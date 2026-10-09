/**
 * The service's half of `bun run melete browser enable`: the connection the
 * browser worker serves, made in the space it works for. It runs inside the
 * service's container, as the service, with the service's own database
 * address:
 *
 *   bun run apps/melete/src/workers/browser/enable.ts [--space sp_...]
 *
 * Without `--space` the space is the personal space of the installation's first
 * person: the setup owner's when there is one. The space's directory is made
 * the way the service makes it, so the worker's mount has something to mount.
 * It prints one JSON line, `{ space_id, connection_id, created }`, and changes
 * nothing on a second run: an existing browser connection in the space is
 * reused.
 *
 * The row is an ordinary `web` connection granting the browser tools, beside
 * the space's own `web` connection, which keeps its search and page reading.
 * Only the owner-controlled connections file turns it into the browser.
 */
import type { Sql } from 'postgres';
import { browserManifest } from '../../connectors/browser.ts';
import type { Database } from '../../db/client.ts';
import { newId } from '../../ids.ts';
import { databaseSpaces } from '../../knowledge/spaces.ts';

export const BROWSER_LABEL = 'Browser';
export const BROWSER_SCOPES = [
  ...new Set(browserManifest.tools.flatMap((tool) => [tool.name, ...tool.required_scopes])),
];

/** A reason to stop that the operator acts on. */
export class BrowserEnableRefusal extends Error {}

export type BrowserEnabled = { space_id: string; connection_id: string; created: boolean };

/** The space the worker serves: the one named, or the first person's own. */
export async function browserSpace(sql: Sql, requested?: string): Promise<string> {
  if (requested !== undefined) {
    const [row] = await sql<{ id: string; removed: boolean }[]>`
      select id, removed_at is not null as removed from space where id = ${requested}`;
    if (!row) throw new BrowserEnableRefusal(`There is no space ${requested}.`);
    if (row.removed) throw new BrowserEnableRefusal(`The space ${requested} is being removed.`);
    return row.id;
  }
  const [row] = await sql<{ id: string }[]>`select s.id from space s
    join principal p on p.id = s.owner_principal_id
    where p.kind = 'person' and s.kind = 'personal' and s.removed_at is null
    order by (p.id = (select o.id from owner o limit 1)) is true desc, p.created_at, p.id, s.created_at, s.id
    limit 1`;
  if (!row)
    throw new BrowserEnableRefusal(
      'There is no account yet. Create your account in Melete, then run this again.',
    );
  return row.id;
}

/**
 * The space's browser connection, made when it has none. A connection that
 * already grants the browser tools there, in any state but revoked, is the one
 * returned, so the operator's file keeps naming the same id.
 */
export async function ensureBrowserConnection(
  sql: Sql,
  spaceId: string,
): Promise<{ id: string; created: boolean }> {
  return sql.begin(async (tx) => {
    await tx`select id from space where id = ${spaceId} for update`;
    const [existing] = await tx<{ id: string }[]>`select c.id from connection c
      where c.space_id = ${spaceId} and c.provider = 'web' and c.status <> 'revoked'
        and c.scopes ? 'browser.observe'
      order by c.id limit 1`;
    if (existing) return { id: existing.id, created: false };
    const id = newId('conn');
    await tx`insert into connection
      (id, space_id, provider, label, scopes, configuration, setup_state, status, health, shared_use)
      values (${id}, ${spaceId}, 'web', ${BROWSER_LABEL}, ${JSON.stringify(BROWSER_SCOPES)}::jsonb,
        '{}'::jsonb, 'connected', 'active', 'unknown', 'owner')`;
    return { id, created: true };
  });
}

export async function enableBrowser(options: {
  sql: Sql;
  db: Database;
  spacesRoot: string;
  space?: string;
}): Promise<BrowserEnabled> {
  const spaceId = await browserSpace(options.sql, options.space);
  // The worker mounts this directory alone, so it must exist before the worker starts.
  const opened = await databaseSpaces(options.db, options.spacesRoot).byId(spaceId);
  if (!opened)
    throw new BrowserEnableRefusal(
      `The directory of space ${spaceId} could not be opened under ${options.spacesRoot}.`,
    );
  const connection = await ensureBrowserConnection(options.sql, spaceId);
  return { space_id: spaceId, connection_id: connection.id, created: connection.created };
}

export function enableArguments(args: readonly string[]): { space?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === '--space' && /^sp_[A-Za-z0-9_-]+$/.test(args[1] ?? ''))
    return { space: args[1] };
  throw new BrowserEnableRefusal('Usage: enable.ts [--space sp_...]');
}

if (import.meta.main) {
  try {
    const options = enableArguments(process.argv.slice(2));
    const { openDatabase } = await import('../../db/client.ts');
    const { withFileSettings } = await import('../../env.ts');
    // In the service's container the address is a file the database's setup step wrote.
    const settings = withFileSettings(process.env);
    if (!settings.DATABASE_URL)
      throw new BrowserEnableRefusal('Set DATABASE_URL to the database this Melete uses.');
    const handle = openDatabase(settings.DATABASE_URL, 1);
    try {
      const enabled = await enableBrowser({
        sql: handle.sql,
        db: handle.db,
        spacesRoot: settings.MELETE_SPACES_DIR ?? '/data/spaces',
        ...options,
      });
      process.stdout.write(`${JSON.stringify(enabled)}\n`);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof BrowserEnableRefusal)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
