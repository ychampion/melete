/**
 * How a room's message names an agent: `@` and the agent's name standing on
 * its own, not inside an address and not the start of a longer word, ignoring
 * case. `@Melete` always names the room's own agent.
 */

const WORD = /[\p{L}\p{N}_]/u;

/** Where `name` is first mentioned on its own in `lower`, or -1. */
function firstAt(lower: string, name: string): number {
  for (let at = lower.indexOf(`@${name}`); at >= 0; at = lower.indexOf(`@${name}`, at + 1)) {
    const before = lower[at - 1];
    const after = lower[at + name.length + 1];
    if (
      (before === undefined || !(WORD.test(before) || before === '@' || before === '.')) &&
      (after === undefined || !WORD.test(after))
    )
      return at;
  }
  return -1;
}

/**
 * The handles a message mentions, and whether it asks the room's agents: it
 * names `@Melete` or any of `agentNames`.
 */
export function mentionsOf(
  text: string,
  agentNames: string | readonly string[],
): { mentions: string[]; asks: boolean } {
  const mentions = [...text.matchAll(/(?:^|[^\w@])@([\p{L}\p{N}_.-]+)/gu)].map(
    (match) => match[1]?.replace(/[.-]+$/, '') ?? '',
  );
  const lower = text.toLowerCase();
  const names = [
    ...new Set(
      ['melete', ...(typeof agentNames === 'string' ? [agentNames] : agentNames)].map((name) =>
        name.trim().toLowerCase(),
      ),
    ),
  ].filter(Boolean);
  return {
    mentions: mentions.filter(Boolean),
    asks: names.some((name) => firstAt(lower, name) >= 0),
  };
}

/**
 * The agent a room's message hands its turn to: the one it names first, the
 * longer name winning where two start at the same place. `@Melete` is the
 * room's own agent, `fallback`. Null when it names none of them.
 */
export function mentionedRoomAgent<T extends { name: string }>(
  text: string,
  agents: readonly T[],
  fallback: T | null,
): T | null {
  const lower = text.toLowerCase();
  let best: { at: number; length: number; agent: T } | null = null;
  const consider = (name: string, candidate: T) => {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) return;
    const at = firstAt(lower, trimmed);
    if (at < 0) return;
    if (!best || at < best.at || (at === best.at && trimmed.length > best.length))
      best = { at, length: trimmed.length, agent: candidate };
  };
  for (const candidate of agents) consider(candidate.name, candidate);
  if (fallback) consider('melete', fallback);
  return (best as { agent: T } | null)?.agent ?? null;
}
