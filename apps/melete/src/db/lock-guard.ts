import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a transaction on a pool knows about itself: whether it holds the event
 * order lock, since when, and the code that took it.
 */
type Scope = { holds: boolean; since: number; site: string; done: boolean };

const scopes = new AsyncLocalStorage<Scope>();

/**
 * A holder of the event order lock that keeps it this long is reported with
 * where it took the lock. Every event writer queues behind it, so a holder that
 * takes seconds is what a person sees as the whole service pausing.
 */
export const SLOW_HOLD_MS = 2_000;

const reported = new Set<string>();

/**
 * The first few frames of the code running now, outside the database layer and
 * the libraries. Taken synchronously where a transaction takes the lock, so it
 * names the caller even where an awaited stack would have lost it.
 */
export function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  return frames
    .filter(
      (frame) =>
        !/[\\/]db[\\/](lock-guard|transaction|client)\.ts/.test(frame) &&
        !frame.includes('node_modules') &&
        !frame.includes('native'),
    )
    .slice(0, 3)
    .map((frame) => frame.trim())
    .join(' < ');
}

/**
 * How a violation is reported. Under `MELETE_EVENT_LOCK_GUARD=throw` (tests)
 * the statement is refused, so a path that waits on the pool while holding the
 * lock fails its suite; otherwise it is logged once per holder.
 */
function violation(message: string, holder: string): void {
  const text = `${message} (lock taken at ${holder || 'an unknown place'})`;
  if (process.env.MELETE_EVENT_LOCK_GUARD === 'throw') throw new Error(text);
  if (reported.has(holder)) return;
  reported.add(holder);
  console.error(text);
}

/** Run a transaction's body in a scope of its own. */
export function inTransaction<T>(body: () => T): T {
  const scope: Scope = { holds: false, since: 0, site: '', done: false };
  return scopes.run(scope, body);
}

/** Close a transaction's scope, reporting a hold long enough to pause everyone. */
export function transactionEnded(scope: Scope | undefined): void {
  if (!scope || scope.done) return;
  scope.done = true;
  if (!scope.holds) return;
  scope.holds = false;
  const held = performance.now() - scope.since;
  if (held >= SLOW_HOLD_MS)
    console.error(
      `event order lock: held for ${(held / 1000).toFixed(1)} s, which pauses every event writer (lock taken at ${scope.site || 'an unknown place'})`,
    );
}

/** Whether the code running now is inside a transaction that holds the event order lock. */
export function holdingEventOrder(): boolean {
  const scope = scopes.getStore();
  return Boolean(scope?.holds && !scope.done);
}

/** The scope of the transaction running now, if any. */
export function currentScope(): Scope | undefined {
  return scopes.getStore();
}

/** Mark the running transaction as holding the event order lock, taken at `site`. */
export function heldEventOrder(site: string): void {
  const scope = scopes.getStore();
  if (!scope || scope.holds || scope.done) return;
  scope.holds = true;
  scope.since = performance.now();
  scope.site = site;
}

/**
 * Called before a statement goes to the pool rather than to the transaction's
 * own connection. While this transaction holds the event order lock, every
 * other connection may be queued on that lock, so a wait for one does not end
 * until those waiters give up: the whole service stalls for the lock's wait
 * limit.
 */
export function guardPoolWait(what = 'a query went to the pool'): void {
  const scope = scopes.getStore();
  if (!scope?.holds || scope.done) return;
  // It runs on the reserve connections instead, so it is said once and the service goes on.
  violation(
    `event order lock: ${what} while a transaction holds the lock; read it through the transaction, before it, or after it commits`,
    scope.site,
  );
}
