/**
 * Where the day's counting lives.
 *
 * One Durable Object holds it, reached by a fixed name, so every request in
 * every data centre lands on the same counter and the caps are the caps.
 * Key-value storage would have been less to set up and would have let a burst
 * walk straight past a spend limit, which is the one thing a spend limit is
 * for. The object is tiny and single-threaded, and at this size that is the
 * whole cost.
 *
 * `giveBack` returns a case file that never arrived, so an upstream failure
 * does not cost someone one of their five.
 */
import type { DurableObjectNamespace, DurableObjectState } from './cf.ts';
import type { Counters, Limits } from './limits.ts';
import { emptyCounters, limitsFrom, refund, spend } from './limits.ts';

export type Decision =
  | { allowed: true; remaining: number }
  | { allowed: false; reason: 'ip' | 'global' };

/** `block` is the IPv6 /48 a visitor is in, when there is one; see `spend`. */
export interface Limiter {
  take(ip: string, block?: string): Promise<Decision>;
  giveBack(ip: string, block?: string): Promise<void>;
}

const KEY = 'counters';
/** Every request counts against the same object, whichever edge it arrived at. */
const OBJECT_NAME = 'day';

/* ---------- the object ---------- */

/**
 * A plain Durable Object class: no base class to extend, so the file carries
 * no runtime-only import and stays inside the repository's typecheck.
 */
export class TryItLimiter {
  readonly #state: DurableObjectState;
  readonly #limits: Limits;

  constructor(state: DurableObjectState, env: Record<string, unknown>) {
    this.#state = state;
    // The caps come from the object's own variables, so raising one is a
    // redeploy rather than a code change.
    this.#limits = limitsFrom(env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ip = url.searchParams.get('ip') ?? 'unknown';
    const block = url.searchParams.get('block') ?? undefined;
    const now = Date.now();
    const result = await this.#state.blockConcurrencyWhile(async () => {
      const stored = (await this.#state.storage.get<Counters>(KEY)) ?? emptyCounters(now);
      if (url.pathname === '/give-back') {
        await this.#state.storage.put(KEY, refund(stored, ip, now, block));
        return null;
      }
      const decision = spend(stored, ip, now, this.#limits, block);
      await this.#state.storage.put(KEY, decision.counters);
      return decision.allowed
        ? ({ allowed: true, remaining: decision.remaining } satisfies Decision)
        : ({ allowed: false, reason: decision.reason } satisfies Decision);
    });
    return Response.json(result);
  }
}

/* ---------- the two ways to reach it ---------- */

export function durableLimiter(namespace: DurableObjectNamespace): Limiter {
  const stub = () => namespace.get(namespace.idFromName(OBJECT_NAME));
  const query = (ip: string, block?: string) =>
    new URLSearchParams(block === undefined ? { ip } : { ip, block }).toString();
  return {
    async take(ip, block) {
      const response = await stub().fetch(`https://limiter/take?${query(ip, block)}`);
      return (await response.json()) as Decision;
    },
    async giveBack(ip, block) {
      await stub().fetch(`https://limiter/give-back?${query(ip, block)}`);
    },
  };
}

/**
 * The same counting held in one isolate. Used by the tests, and by `wrangler
 * dev` when the object is not bound; never correct across data centres, so the
 * Worker refuses the live model path without the real one.
 */
export function memoryLimiter(limits: Limits, now: () => number = Date.now): Limiter {
  let counters = emptyCounters(now());
  return {
    async take(ip, block) {
      const decision = spend(counters, ip, now(), limits, block);
      counters = decision.counters;
      return decision.allowed
        ? { allowed: true, remaining: decision.remaining }
        : { allowed: false, reason: decision.reason };
    },
    async giveBack(ip, block) {
      counters = refund(counters, ip, now(), block);
    },
  };
}
