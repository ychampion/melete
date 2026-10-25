/**
 * Reading a typed reply as one of the answers a question offered. Shared by
 * the service and the web app, so both read the same words the same way.
 */

/** A label as a person would type it back: no case, no punctuation, single spaces. */
const typedWords = (value: string): string =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * The offered option a typed reply names, or null. Case, punctuation and the
 * spaces around and between words do not count; any other word does, so a
 * reply that says more or less than one option's label names none of them.
 */
export function namedOption<T extends { label: string }>(
  reply: string,
  options: readonly T[],
): T | null {
  const said = typedWords(reply);
  if (!said) return null;
  const named = options.filter((option) => typedWords(option.label) === said);
  return named.length === 1 ? (named[0] ?? null) : null;
}
