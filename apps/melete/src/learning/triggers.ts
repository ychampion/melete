/**
 * Where a learned procedure applies, decided the way bundled skills are decided:
 * a deterministic phrase match over the objective and the person's latest message,
 * with the same normalisation and the same counter. No model judges applicability.
 */
import { countMatches, normalizeForMatch } from '@melete/contracts';

export function triggersMatch(
  triggers: readonly { phrase: string }[],
  objective: string,
  latestMessage = '',
): boolean {
  const haystacks = [normalizeForMatch(objective), normalizeForMatch(latestMessage)];
  return triggers.some((trigger) => {
    const needle = normalizeForMatch(trigger.phrase);
    // An empty needle is contained in everything; it matches nothing instead.
    return !!needle && haystacks.some((haystack) => countMatches(haystack, needle) > 0);
  });
}

/** What a delivered procedure covers: its own trigger phrases and the requests it was learned on. */
export type ProcedureReach = { phrases: readonly string[]; learnedFrom: readonly string[] };

/**
 * Whether a built-in skill covers the same work as a delivered procedure, and
 * so would dilute the way the person taught it. It does when one of its
 * triggers and one of the procedure's phrases are the same words or one holds
 * the other, or when it would have been chosen for a request the procedure was
 * learned on: it was in play when the person corrected the work.
 */
export function overlapsProcedure(
  skillTriggers: readonly string[],
  reach: ProcedureReach,
): boolean {
  const triggers = skillTriggers.map(normalizeForMatch).filter(Boolean);
  const phrases = reach.phrases.map(normalizeForMatch).filter(Boolean);
  const learned = reach.learnedFrom.map(normalizeForMatch);
  return triggers.some(
    (trigger) =>
      phrases.some(
        (phrase) => countMatches(phrase, trigger) > 0 || countMatches(trigger, phrase) > 0,
      ) || learned.some((request) => countMatches(request, trigger) > 0),
  );
}

/**
 * How specifically a procedure's triggers match: the length of the longest
 * matching phrase, after normalisation. A procedure with no triggers applies to
 * its whole scope and is the least specific; one that does not match scores -1.
 */
export function triggerSpecificity(
  triggers: readonly { phrase: string }[],
  objective: string,
  latestMessage = '',
): number {
  if (!triggers.length) return 0;
  const haystacks = [normalizeForMatch(objective), normalizeForMatch(latestMessage)];
  let best = -1;
  for (const trigger of triggers) {
    const needle = normalizeForMatch(trigger.phrase);
    if (needle && haystacks.some((haystack) => countMatches(haystack, needle) > 0))
      best = Math.max(best, needle.length);
  }
  return best;
}

/**
 * Whether two procedures can apply to the same request: a shared phrase, or one
 * phrase inside the other. A procedure with no triggers applies to its whole
 * scope, so it overlaps everything in that scope.
 */
export function triggersOverlap(
  left: readonly { phrase: string }[],
  right: readonly { phrase: string }[],
): boolean {
  if (!left.length || !right.length) return true;
  const ours = left.map((trigger) => normalizeForMatch(trigger.phrase)).filter(Boolean);
  const theirs = right.map((trigger) => normalizeForMatch(trigger.phrase)).filter(Boolean);
  return ours.some((one) => theirs.some((two) => one.includes(two) || two.includes(one)));
}
