/**
 * Which service instances are running on this database. Each instance has a
 * row it refreshes every 30 seconds and deletes when it stops. An instance
 * whose row is gone, or whose heartbeat stopped, has stopped, and the
 * containers it labelled may be removed (see `stoppedInstances`).
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Sql } from 'postgres';

export const HEARTBEAT_MS = 30_000;
export const STALE_AFTER_MS = 120_000;
/** A heartbeat this old means stopped, whatever runs on the engine under that name. */
export const LONG_STALE_MS = 600_000;

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

/** This instance's name and the others whose heartbeat is within a given age. */
export type InstanceView = {
  id: string;
  running: (staleAfterMs?: number) => Promise<ReadonlySet<string>>;
};

/**
 * Whether another instance's leftovers may be removed: its heartbeat stopped
 * ten minutes ago, or two minutes ago and no container by its name is running
 * on this engine. An instance whose database link stalls keeps its cells while
 * its service container still runs.
 */
export async function stoppedInstances(
  instance: InstanceView,
  containerRunning: (name: string) => Promise<boolean>,
): Promise<(owner: string) => Promise<boolean>> {
  const recent = await instance.running();
  const lately = await instance.running(LONG_STALE_MS);
  const answers = new Map<string, Promise<boolean>>();
  return (owner) => {
    if (owner === instance.id || recent.has(owner)) return Promise.resolve(false);
    if (!lately.has(owner)) return Promise.resolve(true);
    let answer = answers.get(owner);
    if (!answer) {
      answer = containerRunning(owner).then((running) => !running);
      answers.set(owner, answer);
    }
    return answer;
  };
}

export class InstanceRegistry {
  private timer?: ReturnType<typeof setInterval>;
  /** This process's mark on the row, so two processes under one name are noticed. */
  private readonly nonce = randomBytes(12).toString('hex');

  constructor(
    private readonly sql: Sql,
    readonly id: string,
    private readonly options: {
      host?: string;
      heartbeatMs?: number;
      staleAfterMs?: number;
      log?: (line: string) => void;
    } = {},
  ) {
    if (!NAME.test(id)) throw new Error('Invalid instance id');
  }

  private say(line: string) {
    (this.options.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(line);
  }

  /**
   * Records this instance as running, before it starts anything another
   * instance could remove. Refuses to start when another running process
   * already uses this name: each would take the other's cells for its own.
   */
  async start(): Promise<void> {
    // Rows of instances that ended without stopping are kept a day, then dropped.
    await this.sql`delete from ops_instance where heartbeat_at < now() - interval '1 day'`;
    const refuse = () =>
      new Error(
        `Another running Melete service instance is named "${this.id}". Give each instance its own MELETE_INSTANCE_ID, or leave it unset so each uses its container's host name.`,
      );
    // The name is claimed in one statement: of two processes starting at once
    // under one name, exactly one gets it.
    if (!(await this.claim())) {
      const fresh = await this.fresh();
      if (fresh) {
        // Left by this name's last run, or used by another running process: a
        // running one beats again within one heartbeat period.
        await Bun.sleep((this.options.heartbeatMs ?? HEARTBEAT_MS) * 1.5);
        const again = await this.fresh();
        if (again && (again.nonce !== fresh.nonce || again.beat > fresh.beat)) throw refuse();
      }
      // Taken over only from the run it waited out; of two waiting, one wins.
      if (!(await this.claim(fresh?.nonce))) throw refuse();
    }
    this.timer ??= setInterval(() => {
      void this.beat().catch(() => this.say('instance heartbeat failed'));
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private async fresh() {
    const staleSeconds = (this.options.staleAfterMs ?? STALE_AFTER_MS) / 1000;
    const [row] = await this.sql<{ nonce: string; beat: string }[]>`
      select nonce, heartbeat_at::text as beat from ops_instance
      where id = ${this.id} and heartbeat_at > now() - make_interval(secs => ${staleSeconds})`;
    return row;
  }

  /**
   * Writes this process's row when the name is free: no row, a row of this
   * process, a stopped heartbeat, or the row of the run `replacing` names.
   */
  private async claim(replacing?: string): Promise<boolean> {
    const host = this.options.host ?? hostname();
    const staleSeconds = (this.options.staleAfterMs ?? STALE_AFTER_MS) / 1000;
    const rows = await this.sql`
      insert into ops_instance (id, host, nonce) values (${this.id}, ${host}, ${this.nonce})
      on conflict (id) do update set host = excluded.host, nonce = excluded.nonce,
        heartbeat_at = now(), started_at = now()
      where ops_instance.nonce = excluded.nonce
        or ops_instance.heartbeat_at <= now() - make_interval(secs => ${staleSeconds})
        or ops_instance.nonce = ${replacing ?? null}
      returning id`;
    return rows.length > 0;
  }

  /** Refreshes this process's row; a row another process has taken stays theirs, said loudly. */
  private async beat() {
    const host = this.options.host ?? hostname();
    const rows = await this.sql`
      insert into ops_instance (id, host, nonce) values (${this.id}, ${host}, ${this.nonce})
      on conflict (id) do update set host = excluded.host, heartbeat_at = now()
      where ops_instance.nonce = excluded.nonce
      returning id`;
    if (!rows.length)
      this.say(
        `WARNING: another running service instance is also named "${this.id}"; give each its own MELETE_INSTANCE_ID`,
      );
  }

  /** The instances other than this one whose heartbeat is within `staleAfterMs`, on the database's clock. */
  async others(staleAfterMs = this.options.staleAfterMs ?? STALE_AFTER_MS): Promise<Set<string>> {
    const rows = await this.sql<{ id: string }[]>`select id from ops_instance
      where id <> ${this.id}
        and heartbeat_at > now() - make_interval(secs => ${staleAfterMs / 1000})`;
    return new Set(rows.map((row) => row.id));
  }

  /** Stops the heartbeat and removes the row, so the next start anywhere may clean up after it. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.sql`delete from ops_instance where id = ${this.id} and nonce = ${this.nonce}`;
  }
}
