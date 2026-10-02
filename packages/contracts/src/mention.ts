/**
 * The agent a message opens by naming: "@Scout find flights" goes to Scout.
 * Only a mention at the very start counts, and the longest matching name
 * wins, so "@Sage Green" finds an agent called "Sage Green" before "Sage".
 */
export function mentionedAgent<T extends { name: string }>(
  text: string,
  agents: readonly T[],
): T | null {
  if (!text.startsWith('@')) return null;
  const said = text.slice(1).toLocaleLowerCase();
  const byLength = [...agents].sort((a, b) => b.name.length - a.name.length);
  for (const candidate of byLength) {
    const name = candidate.name.toLocaleLowerCase();
    if (said.startsWith(name) && !/[\p{L}\p{N}_]/u.test(said.charAt(name.length))) return candidate;
  }
  return null;
}
