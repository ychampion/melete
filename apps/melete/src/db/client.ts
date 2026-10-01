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
 * How long a connection may sit inside an open transaction without sending a
 * statement before Postgres ends that session. The service keeps slow work
 * (model calls, runtimes, connectors) outside its transactions, so a
 * transaction idle this long is stuck: typically waiting in this process for
 * a second pool connection that will not come free. Ending it releases its
 * locks and its connection, so the pool recovers instead of hanging. Postgres
 * logs each one ("terminating connection due to idle-in-transaction timeout").
 */
export const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * Open a connection pool. `max` is deliberately small: the service is one
 * process on one machine, and a large pool only hides a slow query.
 */
export function openDatabase(url: string, max = 10): DatabaseHandle {
  const sql = postgres(url, {
    max,
    onnotice: () => {},
    connection: { idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS },
  });
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
