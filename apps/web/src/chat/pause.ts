type Outcome = { data: unknown; error: string | null; unavailable: string | null };

/**
 * Pause a turn, or stop it when this assistant cannot pause mid-step. Only a
 * pause the service says it cannot do falls back to stopping; a pause that
 * failed (the connection dropped, the turn changed) is reported and nothing
 * is stopped.
 */
export async function pauseOrStop(calls: {
  pause: () => Promise<Outcome>;
  stop: () => Promise<Outcome>;
}): Promise<{ outcome: 'paused' | 'stopped' } | { outcome: 'failed'; reason: string }> {
  const paused = await calls.pause();
  if (paused.data !== null) return { outcome: 'paused' };
  if (paused.unavailable === null) return { outcome: 'failed', reason: paused.error ?? '' };
  const stopped = await calls.stop();
  if (stopped.data !== null) return { outcome: 'stopped' };
  return { outcome: 'failed', reason: stopped.error ?? paused.unavailable };
}
