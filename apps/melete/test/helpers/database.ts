import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { type DatabaseHandle, openDatabase } from '../../src/db/client.ts';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { startQueue } from '../../src/jobs/queue.ts';

export type TestDatabase = DatabaseHandle & { url: string };
type TestServer = { url: string; stop: () => Promise<void> };
let server: Promise<TestServer | null> | undefined;
let template: Promise<string> | undefined;
let globalCleanup = false;
let fixtures = 0;

/** The preload owns one throwaway server; every suite still gets its own database. */
export function shareTestServer(): () => Promise<void> {
  globalCleanup = true;
  return stopTestServer;
}

async function stopTestServer() {
  const active = await server;
  server = undefined;
  const templateName = await template?.catch(() => undefined);
  template = undefined;
  try {
    if (active && templateName) {
      const admin = openDatabase(active.url, 1);
      try {
        await admin.sql`drop database ${admin.sql(templateName)} with (force)`;
      } finally {
        await admin.close();
      }
    }
  } finally {
    await active?.stop();
  }
}

async function prepareTemplate(url: string) {
  const name = `melete_template_${randomBytes(10).toString('hex')}`;
  const admin = openDatabase(url, 2);
  await admin.sql`create database ${admin.sql(name)}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  const handle = openDatabase(target.toString(), 2);
  let queue: Awaited<ReturnType<typeof startQueue>> | undefined;
  try {
    await migrateDatabase(handle);
    queue = await startQueue(target.toString());
    return name;
  } catch (error) {
    await handle.close();
    await admin.sql`drop database ${admin.sql(name)} with (force)`;
    throw error;
  } finally {
    await queue?.stop();
    await handle.close();
    await admin.close();
  }
}

async function unusedPort(): Promise<number> {
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

async function startTestServer(): Promise<TestServer | null> {
  if (process.env.DATABASE_URL) return { url: process.env.DATABASE_URL, stop: async () => {} };
  let EmbeddedPostgres: typeof import('embedded-postgres').default;
  try {
    EmbeddedPostgres = (await import('embedded-postgres')).default;
  } catch (error) {
    process.stdout.write(`embedded Postgres unavailable: ${String(error)}\n`);
    process.stdout.write(
      'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
    );
    return null;
  }
  const databaseDir = await mkdtemp(join(tmpdir(), 'melete-w1-pg-'));
  const port = await unusedPort();
  const password = randomBytes(24).toString('hex');
  const embedded = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password,
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=80'],
    onLog: () => {},
    onError: () => {},
  });
  try {
    await embedded.initialise();
    await embedded.start();
  } catch (error) {
    await embedded.stop();
    // Only absent binary downloads can skip tests; startup and migration errors fail.
    if (!/ENOENT|Cannot find package|download/i.test(String(error))) throw error;
    process.stdout.write(`embedded Postgres unavailable: ${String(error)}\n`);
    process.stdout.write(
      'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
    );
    return null;
  }
  return {
    stop: () => embedded.stop(),
    url: `postgres://postgres:${password}@127.0.0.1:${port}/postgres`,
  };
}

/** Each fixture owns a disposable database; an operator's existing tables are never reused. */
export async function testDatabase(): Promise<TestDatabase | null> {
  server ??= startTestServer();
  const shared = await server;
  if (!shared) return null;
  fixtures++;
  const { url } = shared;
  template ??= prepareTemplate(url);
  const templateName = await template;
  const admin = openDatabase(url, 2);
  const name = `melete_test_${randomBytes(10).toString('hex')}`;
  await admin.sql`create database ${admin.sql(name)} template ${admin.sql(templateName)}`;
  const target = new URL(url);
  target.pathname = `/${name}`;
  const handle = openDatabase(target.toString(), 4);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
    await admin.sql`drop database ${admin.sql(name)} with (force)`;
    await admin.close();
    fixtures--;
    if (!globalCleanup && fixtures === 0) await stopTestServer();
  };
  try {
    await migrateDatabase(handle);
    return { ...handle, url: target.toString(), close };
  } catch (error) {
    await close();
    throw error;
  }
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
    ...(options.owner === false ? [] : ['owner']),
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
