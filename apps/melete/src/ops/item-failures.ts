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
 *
 * A database out of reach is not the item's failure: every item would fail the
 * same way, and each would then wait out a pause of its own once the database
 * is back. It counts against none of them, and is said once when it starts,
 * then after a growing pause while it lasts, and once more when it answers.
 * Only a failure that came from the database is read this way: a model
 * provider or mail server that refuses a connection gives the same codes, and
 * that is the item's failure like any other.
 */

import { DrizzleQueryError } from 'drizzle-orm';
import { redactSecrets } from '../connectors/faults.ts';
import { databaseUnreachable } from '../db/sweep-failure.ts';
import { requestFailureText } from '../request-failure.ts';

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
  /**
   * False keeps the tracker out of `stuckItems()`: one a pass makes for a
   * single run, because its caller keeps none, so it never takes the place of
   * the tracker the pass's loop keeps. True by default.
   */
  reported?: boolean;
};

const passes = new Map<string, ItemFailures>();

export class ItemFailures {
  private readonly failing = new Map<string, Failure>();
  /** While the database is out of reach: when to say so again, and the pause before that. */
  private outage: { next: number; pause: number } | undefined;
  private readonly now: () => number;
  private readonly say: (line: string) => void;

  constructor(
    readonly pass: string,
    private readonly options: ItemFailuresOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.say = options.say ?? ((line) => process.stderr.write(`${line}\n`));
    // The newest reported tracker of a pass is the one its running loop keeps.
    if (options.reported !== false) passes.set(pass, this);
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
   * say which space it is in. A database out of reach is not counted: the item
   * stays due, and is not taken again before the first pause is over, so a
   * pass that takes items by that time does not spin on it.
   */
  failed(id: string, error: unknown, label = id): number {
    const now = this.now();
    const database = fromDatabase(error);
    if (database && databaseUnreachable(error)) {
      this.unreachable(now, error);
      return now + this.options.firstMs;
    }
    // A refusal the database gave shows it answers; a file or a provider failing does not.
    if (database) this.answered();
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
    this.answered();
    const before = this.failing.get(id);
    if (!before) return;
    this.failing.delete(id);
    this.say(`${this.pass}: ${before.label} works again after ${before.failures} failed tries`);
  }

  /**
   * Forgets every item not in `ids`: the pass has seen that they no longer
   * exist (another instance finished them, say), so there is nothing left to
   * retry or report. Nothing is said in the log, since they did not work again.
   */
  keepOnly(ids: ReadonlySet<string>): void {
    for (const id of this.failing.keys()) if (!ids.has(id)) this.failing.delete(id);
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

  /** The database could not be reached: said when it starts, then after a growing pause. */
  private unreachable(now: number, error: unknown) {
    const outage = this.outage;
    if (outage && now < outage.next) return;
    const pause = outage ? Math.min(this.options.maxMs, outage.pause * 2) : this.options.firstMs;
    this.outage = { next: now + pause, pause };
    this.say(
      `${this.pass}: the database cannot be reached (${describe(error)}); no item is counted as failing, and each is tried again on the next pass`,
    );
  }

  /** The database answered, so an outage said in the log is over. */
  private answered() {
    if (!this.outage) return;
    this.outage = undefined;
    this.say(`${this.pass}: the database answers again`);
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

/**
 * Whether the failure came from the database: a failed Drizzle query, an error
 * Postgres answered with, or one postgres.js rejected a query with, which it
 * marks with the statement even when the socket under it failed.
 */
function fromDatabase(error: unknown): boolean {
  return (
    error instanceof DrizzleQueryError ||
    (error instanceof Error && (error.name === 'PostgresError' || 'query' in error))
  );
}

const LONGEST = 200;

function describe(error: unknown): string {
  // A failed query's message names the values it was sent with, and the
  // database's own message can quote one back ('invalid input syntax for type
  // uuid: "<value>"'): a person's words or address. The statement, which holds
  // placeholders, and the database's error code say what failed.
  if (error instanceof DrizzleQueryError) return clip(requestFailureText(error));
  if (error instanceof Error && error.name === 'PostgresError') {
    // postgres.js, for a query sent without Drizzle, keeps its statement aside.
    const { code, query } = error as { code?: unknown; query?: unknown };
    return clip(
      `${typeof query === 'string' ? `Failed query: ${query}` : 'Query failed'} (database error ${String(code)})`,
    );
  }
  let text = error instanceof Error ? error.message || error.name : String(error);
  // A failed file call names the file ("EPERM: operation not permitted, unlink
  // '<path>'"), and a file's name can be a person's own words. The log, the
  // health detail and the alerts sent from it keep what failed and in which
  // call, never the name: the item's id already says where.
  const { syscall, path, dest } = (error ?? {}) as {
    syscall?: unknown;
    path?: unknown;
    dest?: unknown;
  };
  if (typeof syscall === 'string' && syscall) {
    const at = text.indexOf(`, ${syscall}`);
    if (at >= 0) text = text.slice(0, at + syscall.length + 2);
  }
  for (const named of [path, dest])
    if (typeof named === 'string' && named) text = text.replaceAll(named, '...');
  return clip(redactSecrets(text));
}

/** One line, at most `LONGEST` long; a long statement gives way to the error code after it. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ');
  if (line.length <= LONGEST) return line;
  const code = / \(database error [^)]*\)$/.exec(line)?.[0] ?? '';
  return `${line.slice(0, LONGEST - code.length).trimEnd()}${code}`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)} h`;
}
