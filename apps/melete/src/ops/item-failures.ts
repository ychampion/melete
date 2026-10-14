/**
 * A background pass that walks many spaces, accounts or rows keeps going past
 * one that fails. `ItemFailures` remembers which items failed, and how often in
 * a row: an item that keeps failing waits longer between tries (doubling up to
 * `maxMs`), and is said in the log on its first failure, then at the 2nd, 4th,
 * 8th and so on, and once more when it works again, never on every pass.
 *
 * Every pass's items that failed `STUCK_AFTER` times in a row are listed by
 * `stuckItems()`, which `GET /health/detail` reads, so the operator sees which
 * space is stuck and why without reading the log. An item the pass stops
 * coming back to (its space was removed, say) is forgotten once it is a full
 * `maxMs` past its retry time.
 */

/** This many failures in a row and an item counts as stuck. */
export const STUCK_AFTER = 3;

export type StuckItem = {
  /** The background pass, in words, such as "trash sweep". */
  pass: string;
  /** The space, account or row it failed on. */
  id: string;
  failures: number;
  since: string;
  retry_at: string;
  error: string;
};

type Failure = { failures: number; since: number; until: number; error: string; label: string };

export type ItemFailuresOptions = {
  /** The wait after a first failure. */
  firstMs: number;
  /** The longest wait between two tries. */
  maxMs: number;
  now?: () => number;
  say?: (line: string) => void;
};

const passes = new Map<string, ItemFailures>();

export class ItemFailures {
  private readonly failing = new Map<string, Failure>();
  private readonly now: () => number;
  private readonly say: (line: string) => void;

  constructor(
    readonly pass: string,
    private readonly options: ItemFailuresOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.say = options.say ?? ((line) => process.stderr.write(`${line}\n`));
    passes.set(pass, this);
  }

  /** Whether the item may be tried now: it has not failed, or its wait is over. */
  due(id: string): boolean {
    const failure = this.failing.get(id);
    return !failure || this.now() >= failure.until;
  }

  /** The items still waiting out their pause, for a query to leave out. */
  waiting(): string[] {
    const now = this.now();
    return [...this.failing].filter(([, failure]) => now < failure.until).map(([id]) => id);
  }

  /**
   * Counts a failure and answers when the item may be tried again. `label` is
   * how the log and the health detail name it, when its id alone would not
   * say which space it is in.
   */
  failed(id: string, error: unknown, label = id): number {
    const now = this.now();
    this.prune(now);
    const before = this.failing.get(id);
    const failures = (before?.failures ?? 0) + 1;
    const wait = Math.min(this.options.maxMs, this.options.firstMs * 2 ** (failures - 1));
    const message = describe(error);
    this.failing.set(id, {
      failures,
      since: before?.since ?? now,
      until: now + wait,
      error: message,
      label,
    });
    // 1, 2, 4, 8, ...: a stuck item is said a handful of times a day, not every pass.
    if ((failures & (failures - 1)) === 0)
      this.say(
        `${this.pass}: ${label} failed${failures > 1 ? ` ${failures} times in a row` : ''} (${message}); the others carry on, and it is tried again in ${duration(wait)}`,
      );
    return now + wait;
  }

  /** The item worked: it is no longer failing. */
  succeeded(id: string): void {
    const before = this.failing.get(id);
    if (!before) return;
    this.failing.delete(id);
    this.say(`${this.pass}: ${before.label} works again after ${before.failures} failed tries`);
  }

  /** The items that have failed `STUCK_AFTER` times or more in a row. */
  stuck(): StuckItem[] {
    this.prune(this.now());
    return [...this.failing]
      .filter(([, failure]) => failure.failures >= STUCK_AFTER)
      .map(([, failure]) => ({
        pass: this.pass,
        id: failure.label,
        failures: failure.failures,
        since: new Date(failure.since).toISOString(),
        retry_at: new Date(failure.until).toISOString(),
        error: failure.error,
      }));
  }

  /** Forgets items the pass has not come back to long after it could have. */
  private prune(now: number) {
    for (const [id, failure] of this.failing)
      if (now >= failure.until + this.options.maxMs) this.failing.delete(id);
  }
}

/** Every pass's stuck items, the longest stuck first. */
export function stuckItems(): StuckItem[] {
  return [...passes.values()]
    .flatMap((pass) => pass.stuck())
    .sort((a, b) => a.since.localeCompare(b.since));
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message || error.name : String(error);
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}
