/**
 * Work that one instance at a time should do, when several service instances
 * share a database: the sandbox sweep and reconciliation, removing what
 * stopped instances left, removing stdio server data for connections that are
 * gone, and the learning proposal drain.
 *
 * Each kind of work has a named lease, held as a session advisory lock on a
 * connection this instance opens for leases alone. Postgres releases the
 * locks when that session ends, so an instance that dies, or loses its
 * database, lets another take over the next time that one checks.
 *
 * Nothing is assumed held: every check asks Postgres whether this very
 * session holds the lock, and takes it when nobody does. A connection that
 * ended and came back is a new session holding nothing, whatever its backend
 * id. While a lease is held it is checked every few seconds, and the signal
 * given to its work ends the moment a check finds it lost.
 *
 * Leases need a direct connection, or a pooler that keeps one server
 * connection per client: under a transaction pooler a session lock is held by
 * nobody in particular.
 *
 * The approach follows qm's `LeaderLease` (MIT), re-implemented here for
 * postgres.js; no code is copied.
 */
import postgres, { type Sql } from 'postgres';

/** The first key of every lease's advisory lock, apart from the keys other code locks with. */
export const LEASE_SPACE = 0x6d6c6561;

/** How often held leases are checked while their work may be running. */
const WATCH_MS = 5000;

/** Settles with `work`, or rejects once `ms` pass without an answer. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('No answer from the database')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The connection leases live on: never recycled by age or idleness, which
 * would release every lease, and with short TCP keepalives on the server, so
 * a session whose instance vanished behind a broken network ends, and its
 * locks with it, within about half a minute.
 */
export function leaseConnection(url: string, instance: string): Sql {
  return postgres(url, {
    max: 1,
    max_lifetime: null,
    idle_timeout: 0,
    onnotice: () => {},
    connection: {
      application_name: `melete-leases:${instance}`.slice(0, 63),
      tcp_keepalives_idle: 10,
      tcp_keepalives_interval: 5,
      tcp_keepalives_count: 3,
    },
  });
}

export class Leases {
  /** Held leases, each with the controller its work's signal comes from. */
  private readonly held = new Map<string, AbortController>();
  /** The connection the held leases live on; replaced after any failure. */
  private sql?: Sql;
  private watcher?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    /** Opens a pool of one connection, used for leases alone (`leaseConnection`). */
    private readonly connect: () => Sql,
    private readonly log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
    /** How long a check may wait for the database before the leases count as lost. */
    private readonly checkMs = 10_000,
    private readonly watchMs = WATCH_MS,
  ) {}

  /** Whether this instance holds `name` now, taking it when nobody does. */
  async leads(name: string): Promise<boolean> {
    if (this.closed) return false;
    this.sql ??= this.connect();
    const sql = this.sql;
    const key = `melete-leader:${name}`;
    try {
      // CASE evaluates in order: the lock is only asked for when this session
      // does not already hold it, so its count never grows.
      const [row] = await within(
        sql<{ held: boolean }[]>`select case
          when exists (select 1 from pg_locks where locktype = 'advisory' and granted
            and pid = pg_backend_pid() and classid = ${LEASE_SPACE}::oid
            and objid = hashtext(${key})::oid and objsubid = 2) then true
          else pg_try_advisory_lock(${LEASE_SPACE}, hashtext(${key})) end as held`,
        this.checkMs,
      );
      // An answer from a connection already given up on counts for nothing.
      if (!row || sql !== this.sql || this.closed) return false;
      if (row.held) this.keep(name);
      else this.lose(name);
      return row.held;
    } catch {
      // The connection failed or stopped answering: nothing is held any more,
      // and the next check starts on a fresh connection.
      if (sql === this.sql) {
        for (const lost of [...this.held.keys()]) this.lose(lost);
        this.sql = undefined;
        void sql.end({ timeout: 0 }).catch(() => {});
      }
      return false;
    }
  }

  /**
   * Ends when this instance stops holding `name`: work started under the
   * lease stops as soon as a check finds it lost. Aborted already when it is
   * not held.
   */
  signal(name: string): AbortSignal {
    return this.held.get(name)?.signal ?? AbortSignal.abort(new Error('Lease not held'));
  }

  private keep(name: string) {
    if (this.held.has(name)) return;
    this.held.set(name, new AbortController());
    this.log(`leases: this instance now runs ${name}`);
    this.watcher ??= setInterval(() => {
      for (const held of [...this.held.keys()]) void this.leads(held);
    }, this.watchMs);
    this.watcher.unref?.();
  }

  private lose(name: string) {
    const controller = this.held.get(name);
    if (!controller) return;
    this.held.delete(name);
    this.log(`leases: lost ${name}`);
    controller.abort(new Error('Lease lost'));
    if (!this.held.size) {
      clearInterval(this.watcher);
      this.watcher = undefined;
    }
  }

  /** Lets every lease go, so another instance can take them now, and ends the connection. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watcher);
    for (const controller of this.held.values()) controller.abort(new Error('Leases closed'));
    this.held.clear();
    const sql = this.sql;
    this.sql = undefined;
    if (!sql) return;
    await within(sql`select pg_advisory_unlock_all()`, 2000).catch(() => {});
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}
