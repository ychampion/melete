/**
 * Work that one instance at a time should do, when several service instances
 * share a database: the sandbox sweep and reconciliation, removing what
 * stopped instances left, removing stdio server data for connections that are
 * gone, and the learning proposal drain.
 *
 * Each kind of work has a named lease, held as a session advisory lock on a
 * connection this instance opens for leases alone. Postgres releases the
 * locks when that session ends, so an instance that dies, or loses its
 * database, lets another take over the next time that one checks. Every check
 * reads the session's backend id: a connection that ended and came back is a
 * new session holding nothing, and no work runs on a lease it lost.
 *
 * Leases need a direct or session-pooled connection: a transaction pooler
 * hands each statement to any server connection, and a session lock taken
 * there is held by nobody in particular.
 *
 * The approach follows qm's `LeaderLease` (MIT), re-implemented here for
 * postgres.js; no code is copied.
 */
import type { Sql } from 'postgres';

/** The first key of every lease's advisory lock, apart from the keys other code locks with. */
export const LEASE_SPACE = 0x6d6c6561;

/** Settles with `work`, or rejects once `ms` pass without an answer. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('No answer from the database')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class Leases {
  private readonly held = new Set<string>();
  /** The connection the held leases live on; replaced after any failure. */
  private sql?: Sql;
  /** The backend the held leases belong to. */
  private session?: number;
  private closed = false;

  constructor(
    /** Opens a pool of one connection, used for leases alone. */
    private readonly connect: () => Sql,
    private readonly log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
    /** How long a check may wait for the database before the leases count as lost. */
    private readonly checkMs = 10_000,
  ) {}

  /** Whether this instance holds `name` now, taking it when nobody does. */
  async leads(name: string): Promise<boolean> {
    if (this.closed) return false;
    this.sql ??= this.connect();
    const sql = this.sql;
    try {
      const take = this.held.has(name)
        ? sql`false`
        : sql`pg_try_advisory_lock(${LEASE_SPACE}, hashtext(${`melete-leader:${name}`}))`;
      const [row] = await within(
        sql<{ session: number; taken: boolean }[]>`
          select pg_backend_pid() as session, ${take} as taken`,
        this.checkMs,
      );
      // An answer from a connection already given up on counts for nothing.
      if (!row || sql !== this.sql || this.closed) return false;
      if (row.session !== this.session) {
        // A new session holds only what it took in this very statement.
        this.lose();
        this.session = row.session;
      }
      if (row.taken) {
        this.held.add(name);
        this.log(`leases: this instance now runs ${name}`);
      }
      return this.held.has(name);
    } catch {
      // The connection failed or stopped answering: nothing is assumed held,
      // and the next check starts on a fresh connection.
      if (sql === this.sql) {
        this.lose();
        this.session = undefined;
        this.sql = undefined;
        void sql.end({ timeout: 0 }).catch(() => {});
      }
      return false;
    }
  }

  private lose() {
    if (this.held.size) this.log(`leases: lost ${[...this.held].join(', ')}`);
    this.held.clear();
  }

  /** Lets every lease go, so another instance can take them now, and ends the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.held.clear();
    const sql = this.sql;
    this.sql = undefined;
    if (!sql) return;
    await within(sql`select pg_advisory_unlock_all()`, 2000).catch(() => {});
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
