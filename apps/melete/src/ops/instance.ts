/**
 * Which service instances are running on this database. Each instance has a
 * row it refreshes every 30 seconds and deletes when it stops. An instance
 * whose row is gone, or whose heartbeat is older than two minutes, has
 * stopped, and the containers it labelled are anyone's to remove.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Sql } from 'postgres';

export const HEARTBEAT_MS = 30_000;
export const STALE_AFTER_MS = 120_000;

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The configured name, else the container's host name (Docker's short
 * container id, stable across a restart), else a random one.
 */
export function instanceId(configured?: string, host = process.env.HOSTNAME ?? hostname()) {
  if (configured && NAME.test(configured)) return configured;
  const fromHost = host
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63);
  return NAME.test(fromHost) ? fromHost : `i-${randomBytes(6).toString('hex')}`;
}

export class InstanceRegistry {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly sql: Sql,
    readonly id: string,
    private readonly options: { host?: string; heartbeatMs?: number; staleAfterMs?: number } = {},
  ) {
    if (!NAME.test(id)) throw new Error('Invalid instance id');
  }

  /** Records this instance as running, before it starts anything another instance could remove. */
  async start(): Promise<void> {
    // Rows of instances that ended without stopping are kept a day, then dropped.
    await this.sql`delete from ops_instance where heartbeat_at < now() - interval '1 day'`;
    await this.beat(true);
    this.timer ??= setInterval(() => {
      void this.beat(false).catch(() => process.stderr.write('instance heartbeat failed\n'));
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private async beat(starting: boolean) {
    const host = this.options.host ?? hostname();
    await this.sql`insert into ops_instance (id, host) values (${this.id}, ${host})
      on conflict (id) do update set host = excluded.host, heartbeat_at = now()
        ${starting ? this.sql`, started_at = now()` : this.sql``}`;
  }

  /** The instances other than this one whose heartbeat is recent, on the database's clock. */
  async others(): Promise<Set<string>> {
    const staleSeconds = (this.options.staleAfterMs ?? STALE_AFTER_MS) / 1000;
    const rows = await this.sql<{ id: string }[]>`select id from ops_instance
      where id <> ${this.id}
        and heartbeat_at > now() - make_interval(secs => ${staleSeconds})`;
    return new Set(rows.map((row) => row.id));
  }

  /** Stops the heartbeat and removes the row, so the next start anywhere may clean up after it. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.sql`delete from ops_instance where id = ${this.id}`;
  }
}
