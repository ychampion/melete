type Bucket = { attempts: number; blockedUntil: number; lastSeen: number };
const BURST = 5;
const IDLE_RESET_MS = 15 * 60_000;
const MAX_SOURCES = 1024;

/** Per socket source and process: five attempts, then 1/2/4/.../60 second backoff. */
export class LoginThrottle {
  private readonly sources = new Map<string, Bucket>();
  private overflow: Bucket | undefined;
  private nextSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Reserve before awaiting a body, database read or password hash, including concurrent calls. */
  admit(source: string): number {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [key, bucket] of this.sources)
        if (now - bucket.lastSeen >= IDLE_RESET_MS) this.sources.delete(key);
      this.nextSweep = now + 60_000;
    }
    let bucket = this.sources.get(source);
    if (!bucket) {
      if (this.sources.size < MAX_SOURCES) {
        bucket = { attempts: 0, blockedUntil: 0, lastSeen: now };
        this.sources.set(source, bucket);
      } else {
        // New sources share a bounded overflow bucket; they cannot evict a live penalty.
        this.overflow ??= { attempts: 0, blockedUntil: 0, lastSeen: now };
        bucket = this.overflow;
      }
    }
    if (now - bucket.lastSeen >= IDLE_RESET_MS) {
      bucket.attempts = 0;
      bucket.blockedUntil = 0;
    }
    bucket.lastSeen = now;
    if (now < bucket.blockedUntil) return Math.ceil((bucket.blockedUntil - now) / 1000);
    bucket.attempts = Math.min(bucket.attempts + 1, BURST + 6);
    if (bucket.attempts >= BURST)
      bucket.blockedUntil = now + Math.min(1000 * 2 ** (bucket.attempts - BURST), 60_000);
    return 0;
  }

  succeeded(source: string): void {
    this.sources.delete(source);
  }
}
