import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Sql } from 'postgres';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { startQueue } from '../../src/jobs/queue.ts';

export type TestDatabase = DatabaseHandle & { url: string; mode: 'embedded' | 'external' };
type TestServer = { url: string; mode: TestDatabase['mode']; stop: () => Promise<void> };
let server: Promise<TestServer | null> | undefined;
const templates = new Map<string, Promise<string>>();
let globalCleanup = false;
let fixtures = 0;
const tempPrefix = 'melete-w1-pg-';

function trace(event: string) {
  if (process.env.MELETE_FIXTURE_TIMINGS === '1') {
    process.stdout.write(`Postgres fixture ${event} at ${performance.now().toFixed(0)}ms\n`);
  }
}

/** The preload owns one throwaway server; every suite still gets its own database. */
export function shareTestServer(): () => Promise<void> {
  globalCleanup = true;
  return stopTestServer;
}

/** Borrow only when the preload owns shutdown; scripts retain their own server lifetime. */
export async function sharedTestServerUrl(): Promise<string | null | undefined> {
  if (!globalCleanup) return undefined;
  server ??= startTestServer();
  return (await server)?.url ?? null;
}

/** Reuse the server, never a fixture's database, across the broker and memory suites. */
export async function acquireTestServer() {
  server ??= startTestServer();
  const shared = await server;
  if (!shared) return null;
  fixtures++;
  let released = false;
  return {
    url: shared.url,
    async release() {
      if (released) return;
      released = true;
      await releaseFixture();
    },
  };
}

async function stopTestServer() {
  trace('server.stop');
  const active = await server;
  server = undefined;
  const templateNames = await Promise.all(
    [...templates.values()].map((template) => template.catch(() => undefined)),
  );
  templates.clear();
  try {
    if (active && templateNames.length) {
      const admin = openDatabase(active.url, 1);
      try {
        for (const name of templateNames) {
          if (name) await admin.sql`drop database ${admin.sql(name)} with (force)`;
        }
      } finally {
        await admin.close();
      }
    }
  } finally {
    await active?.stop();
  }
}

async function prepareTemplate(
  shared: TestServer,
  initialize: (handle: DatabaseHandle) => Promise<void>,
) {
  trace('template.prepare');
  const { url } = shared;
  const name = `melete_template_${randomBytes(10).toString('hex')}`;
  const admin = openDatabase(url, 2);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const handle = openDatabase(target.toString(), 2);
  let created = false;
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined;
  try {
    await admin.sql`create database ${admin.sql(name)}`;
    created = true;
    await initialize(handle);
    // Clone an initialized real pg-boss schema, not a replacement queue implementation.
    queue = await startQueue(target.toString());
    await queue.stop();
    queue = undefined;
    trace('template.ready');
    return name;
  } catch (error) {
    await queue?.stop();
    queue = undefined;
    await handle.close();
    if (created) await admin.sql`drop database ${admin.sql(name)} with (force)`;
    throw error;
  } finally {
    await queue?.stop();
    await handle.close();
    await admin.close();
  }
}

export async function unusedTestPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test Postgres port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function removeOwnedTempRoot(root: string): Promise<void> {
  const parent = await realpath(tmpdir());
  const absolute = resolve(root);
  if (
    dirname(absolute) !== parent ||
    !basename(absolute).startsWith(tempPrefix) ||
    (await lstat(absolute)).isSymbolicLink() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error(`Refusing to remove unverified fixture directory: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function binaryUnavailable(error: unknown): boolean {
  return /cannot find (package|module)|module_not_found|enoent|download|unsupported platform|no binaries/i.test(
    String(error),
  );
}

function reportUnavailable(error: unknown): null {
  process.stdout.write(`embedded Postgres unavailable: ${String(error)}\n`);
  process.stdout.write('db tests skipped: set DATABASE_URL to run them against a real Postgres\n');
  return null;
}

async function startTestServer(): Promise<TestServer | null> {
  trace('server.start');
  if (process.env.DATABASE_URL) {
    return { url: process.env.DATABASE_URL, mode: 'external', stop: async () => {} };
  }
  let EmbeddedPostgres: typeof import('embedded-postgres').default;
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default;
  } catch (error) {
    if (!binaryUnavailable(error)) throw error;
    return reportUnavailable(error);
  }
  const port = await unusedTestPort();
  const tempRoot = await mkdtemp(join(await realpath(tmpdir()), tempPrefix));
  const password = randomBytes(24).toString('hex');
  const embedded = new EmbeddedPostgres({
    databaseDir: join(tempRoot, 'data'),
    port,
    user: 'postgres',
    password,
    authMethod: 'scram-sha-256',
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=80'],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await embedded.initialise();
    await embedded.start();
    trace('server.ready');
  } catch (error) {
    await embedded.stop();
    await removeOwnedTempRoot(tempRoot);
    // Only absent binary downloads can skip tests; startup and migration errors fail.
    if (!binaryUnavailable(error)) throw error;
    return reportUnavailable(error);
  }
  return {
    mode: 'embedded',
    stop: async () => {
      await embedded.stop();
      await removeOwnedTempRoot(tempRoot);
    },
    url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
  };
}

async function releaseFixture(): Promise<void> {
  fixtures--;
  if (!globalCleanup && fixtures === 0) await stopTestServer();
}

/**
 * Each fixture owns a cloned disposable database. Template identity includes
 * the migration input, so frozen broker tests retain exactly their own schema.
 */
export async function createTemplateDatabase(
  key: string,
  initialize: (handle: DatabaseHandle) => Promise<void>,
  max = 4,
): Promise<TestDatabase | null> {
  fixtures++;
  let admin: DatabaseHandle | undefined;
  let handle: DatabaseHandle | undefined;
  let created = false;
  let closing: Promise<void> | undefined;
  const name = `melete_test_${randomBytes(10).toString('hex')}`;
  const close = () => {
    closing ??= (async () => {
      try {
        trace(`database.close.handle ${name}`);
        await handle?.close();
        trace(`database.close.drop ${name}`);
        if (created && admin) await admin.sql`drop database ${admin.sql(name)} with (force)`;
        trace(`database.close.done ${name}`);
      } finally {
        try {
          await admin?.close();
        } finally {
          await releaseFixture();
        }
      }
    })();
    return closing;
  };
  try {
    server ??= startTestServer();
    const shared = await server;
    if (!shared) {
      await close();
      return null;
    }
    let template = templates.get(key);
    if (!template) {
      template = prepareTemplate(shared, initialize);
      templates.set(key, template);
    }
    const templateName = await template;
    admin = openDatabase(shared.url, 2);
    trace('database.create');
    await admin.sql`create database ${admin.sql(name)} template ${admin.sql(templateName)}`;
    trace('database.ready');
    created = true;
    const target = new URL(shared.url);
    target.pathname = `/${name}`;
    handle = openDatabase(target.toString(), max);
    return { ...handle, url: target.toString(), mode: shared.mode, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The full service template includes every migration and retains their migration ledger. */
export async function testDatabase(): Promise<TestDatabase | null> {
  return createTemplateDatabase('service-migrations', migrateDatabase);
}

type ResetTable = { schema: string; name: string };
const resetTables = new WeakMap<Sql, Map<string, ResetTable[]>>();

/** Preserve TRUNCATE CASCADE's table set, including detached rows, without rewriting table files. */
export async function resetTestRows(
  sql: Sql,
  options: { owner?: boolean; retention?: boolean } = {},
) {
  const roots = [
    'space',
    ...(options.owner === false ? [] : ['owner', 'principal']),
    ...(options.retention ? ['event_retention'] : []),
  ];
  const key = roots.join(',');
  let tables = resetTables.get(sql)?.get(key);
  if (!tables) {
    const [database] = await sql`select current_database() as name`;
    if (!/^(melete_test_|w7_)/.test(String(database?.name)))
      throw new Error('Test resets require a disposable database.');
    tables = await sql<ResetTable[]>`with recursive related as (
      select c.oid, array[c.oid] as path, 0 as depth from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any(${roots})
      union all
      select c.conrelid, r.path || c.conrelid, r.depth + 1 from pg_constraint c join related r on c.confrelid = r.oid
      where c.contype = 'f' and not c.conrelid = any(r.path)
    ) select n.nspname as schema, c.relname as name from related r join pg_class c on c.oid = r.oid
      join pg_namespace n on n.oid = c.relnamespace group by n.nspname, c.relname order by max(r.depth) desc, c.relname`;
    const cached = resetTables.get(sql) ?? new Map<string, ResetTable[]>();
    cached.set(key, tables);
    resetTables.set(sql, cached);
  }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const names = tables.map((table) => `${quote(table.schema)}.${quote(table.name)}`);
  await sql.begin(async (tx) => {
    // The lock matches the old reset boundary while the small row sets use ordinary deletes.
    await tx.unsafe(`lock table ${names.join(',')} in access exclusive mode;
${names.map((name) => `delete from ${name};`).join('\n')}`);
  });
}
