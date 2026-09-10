/**
 * The database handle. Postgres is the authoritative state: a runtime attempt
 * is disposable, a job is not. Nothing else in the service holds durable state.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema.ts';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseHandle = {
  db: Database;
  sql: ReturnType<typeof postgres>;
  close: () => Promise<void>;
};

/**
 * Open a connection pool. `max` is deliberately small: the service is one
 * process on one machine, and a large pool only hides a slow query.
 */
export function openDatabase(url: string, max = 10): DatabaseHandle {
  const sql = postgres(url, { max, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/** Used by /health. Returns false rather than throwing, so health stays a report. */
export async function pingDatabase(handle: DatabaseHandle): Promise<boolean> {
  try {
    await handle.sql`select 1`;
    return true;
  } catch {
    return false;
  }
}
