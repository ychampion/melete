/**
 * How many reports one person may send in a short time. It keeps one stuck
 * page from filling the list, not a determined attacker, who is already
 * signed in and accountable. Counted in a `LimitStore`: Postgres in the
 * service, so every instance on the database counts the same reports.
 */
import { FailureWindow, type LimitStore, MemoryLimitStore } from '../ops/limiter.ts';

export const FEEDBACK_BURST = 5;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;
const MAX_PEOPLE = 4096;

export class FeedbackLimiter {
  private readonly window: FailureWindow;

  constructor(
    private readonly clock: () => number = Date.now,
    burst = FEEDBACK_BURST,
    windowMs = FEEDBACK_WINDOW_MS,
    store: LimitStore = new MemoryLimitStore(MAX_PEOPLE),
  ) {
    this.window = new FailureWindow(store, 'feedback', burst, windowMs);
  }

  /** Zero when the report may go, otherwise the seconds until it may. Counts an admitted report. */
  admit(person: string): Promise<number> {
    return this.window.reserve(person, this.clock());
  }

  /** Give back an admitted report that was not stored. */
  refund(person: string): Promise<void> {
    return this.window.release(person, this.clock());
  }
}
