/** Something that says when a change may have been committed (events/stream.ts). */
export type Commits = { subscribe(listener: () => void): () => void };

export type QuietLoopOptions = {
  /** The wait after a pass that found work, and the least time between two passes. */
  busyMs: number;
  /** The longest wait while passes find nothing; each empty pass doubles the wait up to it. */
  idleMs: number;
  /** Runs a pass as soon as allowed when a change may have been committed. */
  wakeOn?: Commits | undefined;
  onError?: (error: unknown) => void;
};

/**
 * Runs `pass` again soon while it finds work and seldom while it finds none, so
 * an installation nobody is using is not asked the same question every second.
 * A pass resolves to whether it found work. A wake runs a pass as soon as
 * `busyMs` has passed since the last one began, so a burst of changes is never
 * looked at more often than a busy loop would. Passes never overlap, and the
 * first runs at once. Without `wakeOn` nothing says when work arrives, so the
 * loop keeps looking every `busyMs`.
 */
export function quietLoop(pass: () => Promise<boolean>, options: QuietLoopOptions) {
  const { busyMs } = options;
  const idleMs = options.wakeOn ? Math.max(options.idleMs, busyMs) : busyMs;
  let wait = busyMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = Number.POSITIVE_INFINITY;
  let lastStart = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | undefined;
  let again = false;
  let stopped = false;

  const arm = (ms: number) => {
    const at = Date.now() + ms;
    if (stopped || (timer !== undefined && dueAt <= at)) return;
    clearTimeout(timer);
    dueAt = at;
    timer = setTimeout(start, ms);
    timer.unref?.();
  };

  function start() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped) return;
    again = false;
    lastStart = Date.now();
    running = Promise.resolve()
      .then(pass)
      .then(
        (worked) => {
          wait = worked ? busyMs : Math.min(wait * 2, idleMs);
        },
        (error: unknown) => {
          wait = Math.min(wait * 2, idleMs);
          options.onError?.(error);
        },
      )
      .finally(() => {
        running = undefined;
        if (again) wake();
        else arm(wait);
      });
  }

  function wake() {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    arm(Math.max(0, lastStart + busyMs - Date.now()));
  }

  const unsubscribe = options.wakeOn?.subscribe(wake);
  start();
  return {
    /** Run a pass soon: new work may be waiting. */
    wake,
    async stop() {
      stopped = true;
      unsubscribe?.();
      clearTimeout(timer);
      await running;
    },
  };
}
