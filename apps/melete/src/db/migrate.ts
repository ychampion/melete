import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DatabaseHandle } from './client.ts';

const JOURNAL = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Runs at every boot, before the API listens, so an upgrade is this call and a
 * health check cannot pass ahead of it. The journal records what was applied:
 * a second boot, or the losing process of two, finds nothing left to do. Only
 * tests pass a folder; the service always applies its own journal.
 */
export async function migrateDatabase(
  handle: DatabaseHandle,
  migrationsFolder = JOURNAL,
): Promise<void> {
  // Serialize startup so two service processes cannot both apply a fresh migration.
  const connection = await handle.sql.reserve();
  try {
    await connection`select pg_advisory_lock(31003102)`;
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await connection`select pg_advisory_unlock(31003102)`;
    connection.release();
  }
}
