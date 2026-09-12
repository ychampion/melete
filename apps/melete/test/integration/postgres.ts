import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { PgBoss } from 'pg-boss';
import postgres from 'postgres';
import { type MemoryScope, newId, provisionMemorySpace } from '../../src/memory/db.ts';
import { acquireTestServer } from '../helpers/database.ts';

export type TestDatabase = NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>;
/** One disposable database per integration file; never migrate the caller's existing database. */
export async function createTestDatabase(
  databaseUrl = process.env.DATABASE_URL,
  _options: { port?: number } = {},
) {
  // The shared throwaway server allocates a loopback port, avoiding other lanes' fixtures.
  const shared = databaseUrl ? null : await acquireTestServer();
  const baseUrl = databaseUrl ?? shared?.url;
  if (!baseUrl) return null;
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
      await shared?.release();
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
  await db.sql`insert into principal (id, email) select id, email from owner where id = ${ownerId} on conflict do nothing`;
  await db.sql`insert into space (id, name, git_path) values (${spaceId}, 'Test space', ${`test/${spaceId}`})`;
  await provisionMemorySpace(db.sql, ownerId, spaceId);
  await db.sql`update memory_spaces set restore_ready = true where space_id = ${spaceId}`;
  return { ownerId, spaceId, publisher: 'authenticated-owner', audience: 'private', role: 'owner' };
}
