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

export class Leases {
  private readonly held = new Set<string>();
  /** The backend the held leases belong to. */
  private session?: number;
  private closed = false;

  constructor(
    /** A pool of one connection, owned by the leases and ended with them. */
    private readonly sql: Sql,
    private readonly log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
  ) {}

  /** Whether this instance holds `name` now, taking it when nobody does. */
  async leads(name: string): Promise<boolean> {
    if (this.closed) return false;
    try {
      const take = this.held.has(name)
        ? this.sql`false`
        : this.sql`pg_try_advisory_lock(${LEASE_SPACE}, hashtext(${`melete-leader:${name}`}))`;
      const [row] = await this.sql<{ session: number; taken: boolean }[]>`
        select pg_backend_pid() as session, ${take} as taken`;
      if (!row) return false;
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
      // The session may have ended with the statement; nothing is assumed held.
      this.lose();
      this.session = undefined;
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
    await this.sql`select pg_advisory_unlock_all()`.catch(() => {});
    await this.sql.end({ timeout: 5 });
  }
}
