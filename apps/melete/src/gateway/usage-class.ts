/**
 * Which model calls a person is waiting on, and which ones run on their own.
 *
 * `interactive`: the person is waiting. An agent turn their message started
 * (or their answer, or their decision on an approval, or the rest of the turn
 * they started), a voice aside while they talk, a scan they asked for, and the
 * side calls such a turn makes along the way (its searches and its reviews).
 *
 * `background`: nobody is waiting. An agent turn a trigger, a schedule or a
 * timer woke (a standing run, a routine, a watch), memory reading what was
 * said, and learning from corrections.
 *
 * Every call is recorded in `model_usage` with its class and its tier, so the
 * two can be counted, reported and limited apart.
 */

export type UsageClass = 'interactive' | 'background';

/**
 * Which step made a call: `interactive` and `t2` are agent turns (a person
 * waiting, or not), `service` is one of the service's own side calls, `t1` is
 * a batched look at what came in.
 */
export type UsageTier = 'interactive' | 't1' | 't2' | 'service';

/** Side calls a person starts and waits on. */
const INTERACTIVE_PURPOSES: ReadonlySet<string> = new Set(['voice', 'companies']);

/**
 * Side calls made inside an agent turn, which take that turn's class: a
 * search the turn ran, a review of an action the turn proposed, the summary
 * of earlier messages the turn needed.
 */
export const TURN_PURPOSES: ReadonlySet<string> = new Set([
  'web_search',
  'action_review',
  'history',
]);

/** Side calls that read in batches what came in. */
const TRIAGE_PURPOSES: ReadonlySet<string> = new Set(['triage']);

/**
 * The class of a side call whose purpose alone decides it. Turn purposes are
 * decided by their turn instead (see `TURN_PURPOSES`); anything else, memory
 * and learning included, runs with nobody waiting.
 */
export function serviceClass(purpose: string): UsageClass {
  return INTERACTIVE_PURPOSES.has(purpose) ? 'interactive' : 'background';
}

export function tierOf(
  kind: 'job' | 'service',
  purpose: string,
  usageClass: UsageClass,
): UsageTier {
  if (kind === 'job') return usageClass === 'interactive' ? 'interactive' : 't2';
  return TRIAGE_PURPOSES.has(purpose) ? 't1' : 'service';
}
