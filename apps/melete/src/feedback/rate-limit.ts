/**
 * How many reports one person may send in a short time. Per process and in
 * memory, like the sign-in limiters: it keeps one stuck page from filling the
 * list, not a determined attacker, who is already signed in and accountable.
 */
export const FEEDBACK_BURST = 5;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;
const MAX_PEOPLE = 4096;

export class FeedbackLimiter {
  private readonly sent = new Map<string, number[]>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly burst = FEEDBACK_BURST,
    private readonly windowMs = FEEDBACK_WINDOW_MS,
  ) {}

  /** Zero when the report may go, otherwise the seconds until it may. Counts an admitted report. */
  admit(person: string): number {
    const now = this.clock();
    const recent = (this.sent.get(person) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.burst) {
      this.sent.set(person, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    recent.push(now);
    if (!this.sent.has(person) && this.sent.size >= MAX_PEOPLE) this.sweep(now);
    this.sent.set(person, recent);
    return 0;
  }

  /** Give back an admitted report that was not stored. */
  refund(person: string): void {
    this.sent.get(person)?.pop();
  }

  private sweep(now: number): void {
    for (const [person, times] of this.sent)
      if (times.every((at) => now - at >= this.windowMs)) this.sent.delete(person);
  }
}
