/**
 * The database handle. Postgres is the authoritative state: a runtime attempt
 * is disposable, a job is not. Nothing else in the service holds durable state.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  currentScope,
  guardPoolWait,
  holdingEventOrder,
  inTransaction,
  transactionEnded,
} from './lock-guard.ts';
import { schema } from './schema.ts';
import { verifyingTls } from './tls.ts';

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

/** Connections kept for statements a holder of the event order lock sends outside it. */
export const RESERVE_CONNECTIONS = 2;

/**
 * Say so when a transaction ended because its connection did. Postgres ends
 * a session left idle in a transaction (see above) while nothing is waiting
 * on it, so postgres.js never sees its reason: the transaction's next
 * statement fails with `CONNECTION_CLOSED`. A dropped connection reads the
 * same, and both mean the transaction was rolled back.
 */
export function reportClosedTransaction(error: unknown): void {
  if ((error as { code?: unknown } | null)?.code === 'CONNECTION_CLOSED')
    console.error(
      `database: a transaction lost its connection and was rolled back; Postgres ends one left idle for ${IDLE_IN_TRANSACTION_TIMEOUT_MS / 1000} s, which means it was stuck`,
    );
}

/**
 * Open a connection pool. `max` is deliberately small: the service is one
 * process on one machine, and a large pool only hides a slow query.
 * `idleInTransactionMs` is for tests that need the limit to arrive sooner.
 */
export function openDatabase(
  url: string,
  max = 10,
  idleInTransactionMs = IDLE_IN_TRANSACTION_TIMEOUT_MS,
): DatabaseHandle {
  // For verify-ca and verify-full, the server is checked against the URL's own host (db/tls.ts).
  const tls = verifyingTls(url);
  const settings = {
    onnotice: () => {},
    connection: { idle_in_transaction_session_timeout: idleInTransactionMs },
    ...(tls ? { ssl: tls } : {}),
  };
  const sql = postgres(url, { max, ...settings });
  /**
   * Two connections kept apart for a statement sent outside the transaction
   * that holds the event order lock. Every pool connection can be queued on
   * that lock, so such a statement would otherwise wait until those waiters
   * gave up, 30 s later, with the whole service paused behind it. Opened on
   * first use; the statement is still reported (`guardPoolWait`).
   */
  let reserve: ReturnType<typeof postgres> | undefined;
  const spare = () => {
    reserve ??= postgres(url, { max: RESERVE_CONNECTIONS, ...settings });
    return reserve;
  };
  // Every transaction, the Drizzle service's included, begins here.
  const begin = sql.begin.bind(sql) as (...args: unknown[]) => Promise<unknown>;
  const unsafe = sql.unsafe.bind(sql) as (...args: unknown[]) => unknown;
  Object.assign(sql, {
    begin: (...args: unknown[]) => {
      // One opened while this code holds the event order lock takes a reserve connection.
      const nested = holdingEventOrder();
      if (nested) guardPoolWait('a transaction was opened on another connection');
      const body = args.pop() as (tx: unknown) => unknown;
      let scope: ReturnType<typeof currentScope>;
      const scoped = (tx: unknown) =>
        inTransaction(() => {
          scope = currentScope();
          return body(tx);
        });
      const start = nested
        ? (spare().begin.bind(spare()) as (...args: unknown[]) => Promise<unknown>)
        : begin;
      return start(...args, scoped)
        .finally(() => transactionEnded(scope))
        .catch((error: unknown) => {
          reportClosedTransaction(error);
          throw error;
        });
    },
    // Drizzle sends a statement outside a transaction through `unsafe`.
    unsafe: (...args: unknown[]) => {
      if (!holdingEventOrder()) return unsafe(...args);
      guardPoolWait();
      return (spare().unsafe as (...args: unknown[]) => unknown)(...args);
    },
  });
  // A tagged statement on the pool (not a helper such as `sql(values)`) is checked too.
  const pool = new Proxy(sql, {
    apply(target, self, args: unknown[]) {
      if (!(Array.isArray(args[0]) && 'raw' in (args[0] as object) && holdingEventOrder()))
        return Reflect.apply(target, self, args);
      guardPoolWait();
      return Reflect.apply(spare(), self, args);
    },
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    sql: pool,
    close: async () => {
      await Promise.all([sql.end({ timeout: 5 }), reserve?.end({ timeout: 5 })]);
    },
  };
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
