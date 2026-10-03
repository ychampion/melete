import { type LimitStore, MemoryLimitStore } from '../ops/limiter.ts';

type Bucket = { attempts: number; blockedUntil: number; lastSeen: number; priorBlock: number };
const BURST = 5;
const IDLE_RESET_MS = 15 * 60_000;

/**
 * Per key: a burst of attempts, then 1/2/4/.../60 second backoff.
 *
 * Login keeps three of these. One is keyed by client address. One is keyed by
 * account and shared by every browser that has not signed in to that account
 * before; it takes a larger burst because many people can stand behind it. One
 * is keyed by known device, so a browser that carries proof of an earlier
 * sign-in spends its own budget and nobody else's.
 *
 * The buckets live in a `LimitStore`: this process's memory by default, or
 * Postgres, where every service instance on the database shares them.
 */
export class LoginThrottle {
  constructor(
    /** Shared with the sibling limiters so one clock moves all of them. */
    readonly clock: () => number = Date.now,
    private readonly burst = BURST,
    private readonly store: LimitStore = new MemoryLimitStore(),
    /** Which limiter this is, where a store holds several. */
    private readonly scope = 'login',
  ) {}

  /**
   * Reserve before awaiting a database read or password hash, including
   * concurrent calls: in memory the reservation is made before this returns.
   */
  admit(source: string): Promise<number> {
    const now = this.clock();
    return this.store.update<Bucket, number>(this.scope, source, now, (stored) => {
      // A key idle for the reset period comes back as nothing: a fresh burst.
      const bucket = stored ?? { attempts: 0, blockedUntil: 0, lastSeen: now, priorBlock: 0 };
      // A refused request changes nothing: it cannot lengthen the wait it met or
      // postpone the idle reset, so a caller who keeps knocking only waits it out.
      if (now < bucket.blockedUntil)
        return {
          state: bucket,
          expiresAt: bucket.lastSeen + IDLE_RESET_MS,
          result: Math.ceil((bucket.blockedUntil - now) / 1000),
        };
      const attempts = Math.min(bucket.attempts + 1, this.burst + 6);
      const next: Bucket = {
        attempts,
        lastSeen: now,
        priorBlock: bucket.blockedUntil,
        blockedUntil:
          attempts >= this.burst
            ? now + Math.min(1000 * 2 ** (attempts - this.burst), 60_000)
            : bucket.blockedUntil,
      };
      return { state: next, expiresAt: now + IDLE_RESET_MS, result: 0 };
    });
  }

  succeeded(source: string): Promise<void> {
    return this.store.clear(this.scope, source);
  }

  /**
   * Hand back the attempt a successful caller reserved, leaving the failures
   * of everyone else in place. At its burst a bucket opens a wait with every
   * admitted attempt, so a success there undoes the wait it opened itself. A
   * success that races the failure which first reaches the burst can undo that
   * wait too; the failure stays counted and the next one opens it again.
   */
  refund(source: string): Promise<void> {
    const now = this.clock();
    return this.store.update<Bucket, void>(this.scope, source, now, (bucket) => {
      if (!bucket) return { state: null, expiresAt: 0, result: undefined };
      if (bucket.attempts === 0)
        return { state: bucket, expiresAt: bucket.lastSeen + IDLE_RESET_MS, result: undefined };
      return {
        state: { ...bucket, attempts: bucket.attempts - 1, blockedUntil: bucket.priorBlock },
        expiresAt: bucket.lastSeen + IDLE_RESET_MS,
        result: undefined,
      };
    });
  }
}
