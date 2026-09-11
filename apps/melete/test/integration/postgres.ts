import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { PgBoss } from 'pg-boss';
import postgres, { type Sql } from 'postgres';
import { type MemoryScope, newId, provisionMemorySpace } from '../../src/memory/db.ts';
import { testDatabase } from '../helpers/database.ts';

export type TestDatabase = NonNullable<Awaited<ReturnType<typeof createTestDatabase>>>;

async function withQueue(sql: Sql, url: string, closeDatabase: () => Promise<void>) {
  const boss = new PgBoss({ connectionString: url, schema: 'pgboss', max: 2 });
  boss.on('error', () => {});
  try {
    await boss.start();
  } catch (error) {
    await closeDatabase();
    throw error;
  }
  let closed = false;
  return {
    sql,
    boss,
    url,
    async close() {
      if (closed) return;
      closed = true;
      await boss.stop({ graceful: true });
      await closeDatabase();
    },
  };
}

/** Isolated databases share the preload's server; caller databases are never migrated in place. */
export async function createTestDatabase(
  databaseUrl = process.env.DATABASE_URL,
  _options: { port?: number } = {},
) {
  if (!databaseUrl) {
    // The shared server selects an unused port, so focused suites cannot collide on fixed ports.
    const handle = await testDatabase();
    if (!handle) return null;
    return withQueue(handle.sql, handle.url, handle.close);
  }
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const name = `w7_${newId('test').toLowerCase()}`;
  await admin.unsafe(
    `create database "${name}" template template0 encoding 'UTF8' lc_collate 'C' lc_ctype 'C'`,
  );
  const target = new URL(databaseUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  const sql = postgres(url, { max: 2, onnotice: () => {} });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.end({ timeout: 2 });
    await admin.unsafe(`drop database "${name}" with (force)`);
    await admin.end();
  };
  try {
    await migrate(drizzle(sql), { migrationsFolder: resolve(import.meta.dir, '../../drizzle') });
    return await withQueue(sql, url, close);
  } catch (error) {
    await close();
    throw error;
  }
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
