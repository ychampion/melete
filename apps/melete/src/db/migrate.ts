import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { DatabaseHandle } from './client.ts';

const JOURNAL = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * The first connection is the one start-up makes, so its failure says which
 * server and which setting. The driver's own message can name neither
 * (`getaddrinfo ENOTFOUND`), and the address is given without its password.
 */
function unreachable(handle: DatabaseHandle, error: unknown): string {
  const { host, port } = handle.sql.options;
  const servers = host.map((name, index) => `${name}:${port[index] ?? port[0]}`).join(', ');
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : '';
  const reason = error instanceof Error ? error.message : String(error);
  return `Cannot open the database at ${servers} (DATABASE_URL): ${
    reason.includes(code) ? reason : `${code} ${reason}`
  }`;
}

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
  const connection = await handle.sql.reserve().catch((error: unknown) => {
    throw new Error(unreachable(handle, error));
  });
  try {
    await connection`select pg_advisory_lock(31003102)`;
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await connection`select pg_advisory_unlock(31003102)`;
    connection.release();
  }
}
