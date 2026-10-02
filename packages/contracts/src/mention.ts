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

/** Two agent names are the same when "@name" could not tell them apart. */
export const sameAgentName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/**
 * A name no agent in the space has yet: the wanted one when it is free,
 * otherwise the first of "Nova 2", "Nova 3", … that is.
 */
export function freeAgentName(wanted: string, taken: readonly string[]): string {
  const base = wanted.trim();
  const free = (name: string) => !taken.some((other) => sameAgentName(other, name));
  if (free(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`;
    const name = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (free(name)) return name;
  }
}
