/**
 * Long work runs unattended, and a model that has lost its way tends to make
 * the same call again and again. Within one attempt of a run or a helper, the
 * same tool with the same arguments is answered three times; the fourth is
 * refused with a message the model can act on. Counts live in memory: they
 * belong to one attempt, which does not outlive this process anyway.
 */
import type { CapabilityClaims } from '@melete/contracts';
import { BrokerFault } from './errors.ts';

/** Identical calls one attempt may make before the next is refused. */
export const REPEAT_LIMIT = 3;
/** Attempts whose calls are remembered; the oldest is forgotten first. */
const ATTEMPTS_KEPT = 1000;

/** The same value written the same way, whatever order its keys came in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export class RepeatGuard {
  private readonly attempts = new Map<string, Map<string, { count: number; refs: Set<string> }>>();

  /**
   * Counts a call and refuses it once the same call was already made
   * `REPEAT_LIMIT` times in this attempt. A retry that carries the same
   * client reference is the same call delivered twice, not a repeat.
   */
  note(claims: CapabilityClaims, name: string, args: unknown, ref?: string) {
    // Only long work: a run's attempts and its helpers' are offered run.log.
    if (!claims.scopes.includes('run.log')) return;
    let calls = this.attempts.get(claims.attempt_id);
    if (!calls) {
      if (this.attempts.size >= ATTEMPTS_KEPT) {
        const oldest = this.attempts.keys().next().value;
        if (oldest !== undefined) this.attempts.delete(oldest);
      }
      calls = new Map();
      this.attempts.set(claims.attempt_id, calls);
    }
    const key = `${name}\n${stable(args)}`;
    const seen = calls.get(key) ?? { count: 0, refs: new Set<string>() };
    calls.set(key, seen);
    if (ref !== undefined && seen.refs.has(ref)) return;
    if (seen.count >= REPEAT_LIMIT)
      throw new BrokerFault(
        'payload_invalid',
        `This exact ${name} call was already made ${REPEAT_LIMIT} times in this shift, and you have its result. Making it again will not change the answer: change your approach, or record what you know with run.log and end the shift with run.checkpoint.`,
      );
    seen.count++;
    if (ref !== undefined) seen.refs.add(ref);
  }
}
