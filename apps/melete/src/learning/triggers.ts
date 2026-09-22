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
