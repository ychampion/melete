import { expect, test } from 'bun:test';
import type { Sql } from 'postgres';
import { Leases, leaseConnection } from './leader.ts';

/** A connection whose statements never answer, as one cut off without a word. */
function silent() {
  const opened = { pools: 0, ended: 0 };
  const connect = () => {
    opened.pools += 1;
    const sql = Object.assign(() => new Promise(() => {}), {
      end: async () => {
        opened.ended += 1;
      },
    });
    return sql as unknown as Sql;
  };
  return { opened, connect };
}

/**
 * One Postgres server, as far as leases see it: advisory locks owned by a
 * backend id. A restart drops every lock, and backend ids may start over.
 */
class Server {
  readonly locks = new Map<string, number>();
  restart() {
    this.locks.clear();
  }
  connection(pid: () => number) {
    const statement = (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const key = String(values[1]);
      const owner = this.locks.get(key);
      if (owner === pid()) return Promise.resolve([{ held: true }]);
      if (owner !== undefined) return Promise.resolve([{ held: false }]);
      this.locks.set(key, pid());
      return Promise.resolve([{ held: true }]);
    };
    return Object.assign(statement, { end: async () => {} }) as unknown as Sql;
  }
}

test('a lease check the database never answers counts as lost, and the next uses a fresh connection', async () => {
  const { opened, connect } = silent();
  const leases = new Leases(connect, () => {}, 50);
  expect(await leases.leads('sandbox')).toBe(false);
  expect(opened).toEqual({ pools: 1, ended: 1 });
  expect(await leases.leads('sandbox')).toBe(false);
  expect(opened.pools).toBe(2);
  // Closing never waits on a connection that does not answer.
  const started = Date.now();
  await leases.close();
  expect(Date.now() - started).toBeLessThan(1000);
});

test('after a database restart that gives a session its old backend id, only the instance holding the lock leads', async () => {
  const server = new Server();
  const first = new Leases(
    () => server.connection(() => 41),
    () => {},
  );
  const second = new Leases(
    () => server.connection(() => 42),
    () => {},
  );
  try {
    expect(await first.leads('sandbox')).toBe(true);
    expect(await second.leads('sandbox')).toBe(false);
    server.restart();
    expect(await second.leads('sandbox')).toBe(true);
    // The first comes back on backend 41 again, holding nothing.
    expect(await first.leads('sandbox')).toBe(false);
    expect(server.locks.get('melete-leader:sandbox')).toBe(42);
  } finally {
    await first.close();
    await second.close();
  }
});

test('work under a lease is stopped as soon as a check finds the lease lost', async () => {
  const server = new Server();
  const first = new Leases(
    () => server.connection(() => 41),
    () => {},
    1000,
    20,
  );
  const second = new Leases(
    () => server.connection(() => 42),
    () => {},
    1000,
    20,
  );
  try {
    expect(second.signal('sandbox').aborted).toBe(true);
    expect(await first.leads('sandbox')).toBe(true);
    const work = first.signal('sandbox');
    expect(work.aborted).toBe(false);
    server.restart();
    expect(await second.leads('sandbox')).toBe(true);
    // No call from the work itself: the lease's own watch notices.
    await Bun.sleep(100);
    expect(work.aborted).toBe(true);
    expect(second.signal('sandbox').aborted).toBe(false);
  } finally {
    await first.close();
    await second.close();
  }
});

test('the lease connection is never recycled by age or idleness and ends with a broken network', async () => {
  const sql = leaseConnection('postgres://melete@127.0.0.1:1/melete', 'first');
  try {
    const options = sql.options as unknown as {
      max: number;
      max_lifetime: number | null;
      idle_timeout: number;
      connection: Record<string, unknown>;
    };
    expect(options.max).toBe(1);
    expect(options.max_lifetime).toBeNull();
    expect(options.idle_timeout).toBe(0);
    expect(options.connection).toMatchObject({
      application_name: 'melete-leases:first',
      tcp_keepalives_idle: 10,
      tcp_keepalives_interval: 5,
      tcp_keepalives_count: 3,
    });
  } finally {
    await sql.end({ timeout: 0 });
  }
});
