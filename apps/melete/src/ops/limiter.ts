/**
 * Where request limits keep their counts. In memory they belong to one
 * process; in Postgres every service instance on the database reads and
 * writes the same row, so a caller who spreads requests across instances
 * meets one limit, not one per instance.
 *
 * A limiter describes its rule as a step: given the key's state (nothing when
 * the key is new or its state expired), it returns the next state, when that
 * state expires, and its answer. The store runs the step atomically for the
 * key, so concurrent requests on any instance are counted one at a time.
 */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';

export type LimitStep<S, R> = (state: S | undefined) => {
  /** The next state; null forgets the key. */
  state: S | null;
  /** When the state stops meaning anything, on the limiter's own clock. */
  expiresAt: number;
  result: R;
};

export interface LimitStore {
  /** Runs `step` on the key's live state at `now` and keeps what it returns, atomically. */
  update<S, R>(scope: string, key: string, now: number, step: LimitStep<S, R>): Promise<R>;
  /** Forgets the key. */
  clear(scope: string, key: string): Promise<void>;
}

const SWEEP_MS = 60_000;

/**
 * One process's limits. The number of keys is bounded: once full, keys it has
 * not seen share one overflow state per scope, so new callers cannot evict a
 * live penalty or grow the map without bound. The step runs before the
 * returned promise exists, so callers that do not wait still reserve in order.
 */
export class MemoryLimitStore implements LimitStore {
  private readonly entries = new Map<string, { state: unknown; expiresAt: number }>();
  private readonly overflow = new Map<string, { state: unknown; expiresAt: number }>();
  private nextSweep = 0;

  constructor(private readonly maxKeys = 1024) {}

  update<S, R>(scope: string, key: string, now: number, step: LimitStep<S, R>): Promise<R> {
    if (now >= this.nextSweep) {
      for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
      this.nextSweep = now + SWEEP_MS;
    }
    const id = `${scope}\0${key}`;
    const shared = !this.entries.has(id) && this.entries.size >= this.maxKeys;
    const entry = shared ? this.overflow.get(scope) : this.entries.get(id);
    const live = entry && entry.expiresAt > now ? (entry.state as S) : undefined;
    const next = step(live);
    if (next.state === null) {
      if (shared) this.overflow.delete(scope);
      else this.entries.delete(id);
    } else {
      const value = { state: next.state, expiresAt: next.expiresAt };
      if (shared) this.overflow.set(scope, value);
      else this.entries.set(id, value);
    }
    return Promise.resolve(next.result);
  }

  clear(scope: string, key: string): Promise<void> {
    this.entries.delete(`${scope}\0${key}`);
    return Promise.resolve();
  }
}

/** The row a scope and key are kept under: a digest, so the table names no address or account. */
export function limitKey(scope: string, key: string): string {
  return createHash('sha256').update(`${scope}\0${key}`).digest('hex');
}

/**
 * Limits every instance on the database shares, one row per key in
 * `rate_limit_window`. Each check locks its row for one short transaction.
 * Expired rows are deleted about once a minute by whichever instance checks.
 */
export class PostgresLimitStore implements LimitStore {
  private nextSweep = 0;

  constructor(private readonly sql: Sql) {}

  async update<S, R>(scope: string, key: string, now: number, step: LimitStep<S, R>): Promise<R> {
    const id = limitKey(scope, key);
    const result = await this.sql.begin(async (tx) => {
      const read = () =>
        tx<{ state: S | null; expires_at: Date }[]>`
          select state, expires_at from rate_limit_window where key = ${id} for update`;
      let [row] = await read();
      if (!row) {
        // The first check for a key makes its row; a concurrent first check waits on it.
        await tx`insert into rate_limit_window (key, scope, state, expires_at)
          values (${id}, ${scope}, null, ${new Date(0).toISOString()})
          on conflict (key) do nothing`;
        [row] = await read();
      }
      const live =
        row && row.state !== null && new Date(row.expires_at).getTime() > now
          ? row.state
          : undefined;
      const next = step(live);
      if (next.state === null) await tx`delete from rate_limit_window where key = ${id}`;
      else
        await tx`update rate_limit_window
          set state = ${JSON.stringify(next.state)}::jsonb, expires_at = ${new Date(next.expiresAt).toISOString()},
            updated_at = now()
          where key = ${id}`;
      return [next.result] as const;
    });
    if (now >= this.nextSweep) {
      this.nextSweep = now + SWEEP_MS;
      void this
        .sql`delete from rate_limit_window where expires_at <= ${new Date(now).toISOString()}`.catch(
        () => {},
      );
    }
    return result[0] as R;
  }

  async clear(scope: string, key: string): Promise<void> {
    await this.sql`delete from rate_limit_window where key = ${limitKey(scope, key)}`;
  }
}

/** A fixed window of `limit` requests per key, as the public endpoints use. */
export class WindowLimiter {
  constructor(
    private readonly store: LimitStore,
    private readonly scope: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Counts one request; false once the key has used its window. */
  allow(key: string): Promise<boolean> {
    const now = this.clock();
    return this.store.update<{ count: number; until: number }, boolean>(
      this.scope,
      key,
      now,
      (entry) => {
        if (!entry || entry.until <= now)
          return {
            state: { count: 1, until: now + this.windowMs },
            expiresAt: now + this.windowMs,
            result: true,
          };
        const count = entry.count + 1;
        return {
          state: { count, until: entry.until },
          expiresAt: entry.until,
          result: count <= this.limit,
        };
      },
    );
  }
}

/** Failures in a sliding window per key; at `limit` the key waits for the oldest to age out. */
export class FailureWindow {
  constructor(
    private readonly store: LimitStore,
    private readonly scope: string,
    private readonly limit = 10,
    private readonly windowMs = 10 * 60_000,
  ) {}

  private recent(failures: number[] | undefined, now: number) {
    return (failures ?? []).filter((at) => now - at < this.windowMs);
  }

  /** Seconds to wait before another try, or 0. */
  retryAfter(key: string, now = Date.now()): Promise<number> {
    return this.store.update<number[], number>(this.scope, key, now, (failures) => {
      const recent = this.recent(failures, now);
      const wait =
        recent.length < this.limit
          ? 0
          : Math.ceil(((recent[0] ?? now) + this.windowMs - now) / 1000);
      return this.keep(recent, wait);
    });
  }

  fail(key: string, now = Date.now()): Promise<void> {
    return this.store.update<number[], void>(this.scope, key, now, (failures) =>
      this.keep([...this.recent(failures, now), now], undefined),
    );
  }

  private keep<R>(recent: number[], result: R) {
    const newest = recent.at(-1);
    return newest === undefined
      ? { state: null, expiresAt: 0, result }
      : { state: recent, expiresAt: newest + this.windowMs, result };
  }
}
