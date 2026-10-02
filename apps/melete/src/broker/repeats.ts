/**
 * Long work runs unattended, and a model that has lost its way tends to make
 * the same call again and again. Within one attempt of a run or a helper, the
 * same tool with the same arguments is answered three times; the fourth is
 * refused with a message the model can act on. Counts live in memory: they
 * belong to one attempt, which does not outlive this process anyway.
 */
import { createHash } from 'node:crypto';
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
  private readonly attempts = new Map<string, Map<string, number>>();

  /**
   * Counts a call and refuses it once the same call was already made
   * `REPEAT_LIMIT` times in this attempt. A client reference does not make a
   * call new: the engine derives it from the call's own arguments and never
   * resends, so the same reference again is the same call made again.
   */
  note(claims: CapabilityClaims, name: string, args: unknown) {
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
    // Kept as a digest: arguments can be large, and many attempts are remembered.
    const key = createHash('sha256')
      .update(`${name}\n${stable(args)}`)
      .digest('base64');
    const seen = calls.get(key) ?? 0;
    if (seen >= REPEAT_LIMIT)
      throw new BrokerFault(
        'payload_invalid',
        `This exact ${name} call was already made ${REPEAT_LIMIT} times in this shift, and you have its result. Making it again will not change the answer: change your approach, or record what you know with run.log and end the shift with run.checkpoint.`,
      );
    calls.set(key, seen + 1);
  }
}
