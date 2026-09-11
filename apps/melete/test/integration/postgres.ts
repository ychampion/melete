import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { type MemoryScope, newId, provisionMemorySpace } from '../../src/memory/db.ts';

export type TestDatabase = NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>;
/** One disposable database per integration file; never migrate the caller's existing database. */
export async function createTestDatabase(databaseUrl = process.env.DATABASE_URL) {
  let embedded: { stop(): Promise<void> } | undefined;
  let directory: string | undefined;
  let baseUrl = databaseUrl;
  if (!baseUrl) {
    try {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      directory = await mkdtemp(join(tmpdir(), 'melete-w7-pg-'));
      const instance = new EmbeddedPostgres({
        databaseDir: join(directory, 'data'),
        user: 'postgres',
        password: 'test-local-only',
        port: 3122,
        persistent: true,
        postgresFlags: ['-h', '127.0.0.1', '-c', 'max_connections=30'],
        onLog: () => {},
        onError: () => {},
      });
      embedded = instance;
      await instance.initialise();
      await instance.start();
      baseUrl = 'postgres://postgres:test-local-only@127.0.0.1:3122/postgres';
    } catch (error) {
      await embedded?.stop().catch(() => {});
      if (
        !(error instanceof Error) ||
        !/module|binary|download|ENOENT|Cannot find/i.test(error.message)
      )
        throw error;
      process.stdout.write(
        'db tests skipped: set DATABASE_URL to run them against a real Postgres\n',
      );
      return null;
    }
  }
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  const name = `w7_${newId('test').toLowerCase()}`;
  // Windows initdb can inherit WIN1252. Exact source spans require a Unicode database.
  await admin.unsafe(
    `create database "${name}" template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`,
  );
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const connectionString = url.toString();
  const sql = postgres(connectionString, { max: 2, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
  const boss = new PgBoss({ connectionString, schema: 'pgboss', max: 2 });
  boss.on('error', () => {});
  await boss.start();
  return {
    sql,
    boss,
    url: connectionString,
    async close() {
      await boss.stop({ graceful: true });
      await sql.end({ timeout: 2 });
      await admin.unsafe(`drop database "${name}" with (force)`);
      await admin.end();
      await embedded?.stop();
      // The path is created above, outside user repositories. Preserve it if shutdown is incomplete.
      if (
        directory &&
        resolve(directory).startsWith(
          `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}melete-w7-pg-`,
        )
      ) {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        }).catch(() => {});
      }
    },
  };
}
export async function createScope(db: TestDatabase): Promise<MemoryScope> {
  const spaceId = newId('sp');
  // W1's owner_singleton_idx allows exactly one owner row per database, so
  // scopes share it. A scope is isolated by its space, not by its owner.
  const candidate = newId('own');
  await db.sql`insert into owner (id, email) values (${candidate}, ${`${candidate}@example.test`}) on conflict do nothing`;
  const [existing] = await db.sql`select id from owner limit 1`;
  const ownerId = (existing?.id ?? candidate) as string;
  await db.sql`insert into space (id, name, git_path) values (${spaceId}, 'Test space', ${`test/${spaceId}`})`;
  await provisionMemorySpace(db.sql, ownerId, spaceId);
  await db.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  return { ownerId, spaceId, publisher: 'authenticated-owner', audience: 'private', role: 'owner' };
}
