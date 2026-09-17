type Bucket = { attempts: number; blockedUntil: number; lastSeen: number; priorBlock: number };
const BURST = 5;
const IDLE_RESET_MS = 15 * 60_000;
const MAX_SOURCES = 1024;

/**
 * Per key and process: a burst of attempts, then 1/2/4/.../60 second backoff.
 *
 * Login keeps three of these. One is keyed by client address. One is keyed by
 * account and shared by every browser that has not signed in to that account
 * before; it takes a larger burst because many people can stand behind it. One
 * is keyed by known device, so a browser that carries proof of an earlier
 * sign-in spends its own budget and nobody else's.
 */
export class LoginThrottle {
  private readonly sources = new Map<string, Bucket>();
  private overflow: Bucket | undefined;
  private nextSweep = 0;

  constructor(
    /** Shared with the sibling limiters so one clock moves all of them. */
    readonly clock: () => number = Date.now,
    private readonly burst = BURST,
  ) {}

  /** Reserve before awaiting a database read or password hash, including concurrent calls. */
  admit(source: string): number {
    const now = this.clock();
    if (now >= this.nextSweep) {
      for (const [key, bucket] of this.sources)
        if (now - bucket.lastSeen >= IDLE_RESET_MS) this.sources.delete(key);
      this.nextSweep = now + 60_000;
    }
    let bucket = this.sources.get(source);
    if (!bucket) {
      if (this.sources.size < MAX_SOURCES) {
        bucket = { attempts: 0, blockedUntil: 0, lastSeen: now, priorBlock: 0 };
        this.sources.set(source, bucket);
      } else {
        // New sources share a bounded overflow bucket; they cannot evict a live penalty.
        this.overflow ??= { attempts: 0, blockedUntil: 0, lastSeen: now, priorBlock: 0 };
        bucket = this.overflow;
      }
    }
    if (now - bucket.lastSeen >= IDLE_RESET_MS) {
      bucket.attempts = 0;
      bucket.blockedUntil = 0;
    }
    // A refused request changes nothing: it cannot lengthen the wait it met or
    // postpone the idle reset, so a caller who keeps knocking only waits it out.
    if (now < bucket.blockedUntil) return Math.ceil((bucket.blockedUntil - now) / 1000);
    bucket.lastSeen = now;
    bucket.priorBlock = bucket.blockedUntil;
    bucket.attempts = Math.min(bucket.attempts + 1, this.burst + 6);
    if (bucket.attempts >= this.burst)
      bucket.blockedUntil = now + Math.min(1000 * 2 ** (bucket.attempts - this.burst), 60_000);
    return 0;
  }

  succeeded(source: string): void {
    this.sources.delete(source);
  }

  /**
   * Hand back the attempt a successful caller reserved, leaving the failures
   * of everyone else in place. At its burst a bucket opens a wait with every
   * admitted attempt, so a success there undoes the wait it opened itself. A
   * success that races the failure which first reaches the burst can undo that
   * wait too; the failure stays counted and the next one opens it again.
   */
  refund(source: string): void {
    const bucket =
      this.sources.get(source) ?? (this.sources.size >= MAX_SOURCES ? this.overflow : undefined);
    if (!bucket || bucket.attempts === 0) return;
    bucket.attempts -= 1;
    bucket.blockedUntil = bucket.priorBlock;
  }
}
