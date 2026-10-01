/**
 * How long something took, in the words a person would use: "45s", "2 min",
 * "1 h 5 min", "3 days". Never a long run of raw seconds.
 */
export function spanOf(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * When a turn that ended without a closing step last did anything: the latest
 * start or end among its tool entries, or null when it has none.
 */
export function lastActivity(
  tools: { started_at: string; ended_at: string | null }[],
): number | null {
  let latest: number | null = null;
  for (const tool of tools)
    for (const at of [tool.started_at, tool.ended_at]) {
      const time = at ? Date.parse(at) : Number.NaN;
      if (!Number.isNaN(time) && (latest === null || time > latest)) latest = time;
    }
  return latest;
}
