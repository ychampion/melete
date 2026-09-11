import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DatabaseHandle } from './client.ts';

export async function migrateDatabase(handle: DatabaseHandle): Promise<void> {
  // Serialize startup so two service processes cannot both apply a fresh migration.
  const connection = await handle.sql.reserve();
  try {
    await connection`select pg_advisory_lock(31003102)`;
    await migrate(handle.db, {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)),
    });
  } finally {
    await connection`select pg_advisory_unlock(31003102)`;
    connection.release();
  }
}
