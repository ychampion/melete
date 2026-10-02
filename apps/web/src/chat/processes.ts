/**
 * Words for the background processes in the agent's computer: what state one
 * is in, and how long it has run, the way a person says it.
 */
import type { ComputerProcess } from '../experience/types.ts';

const STATE_WORDS: Record<ComputerProcess['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  exited: 'Finished',
  stopped: 'Stopped',
  expired: 'Reached its time limit',
  lost: 'Lost',
};

export const processStateWords = (state: ComputerProcess['state']): string =>
  STATE_WORDS[state] ?? state;

export const processLive = (state: ComputerProcess['state']): boolean =>
  state === 'starting' || state === 'running';

/** How long a process has been running: "under a minute", "12 min", "2 h 5 min". */
export function runningFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return 'under a minute';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** A preview this close to its end is replaced by a new one. */
export const RENEW_BEFORE_MS = 5 * 60_000;

/** Whether the preview the frame loaded should be replaced now. */
export const previewDue = (expiresAt: string, now: number): boolean =>
  Date.parse(expiresAt) - now < RENEW_BEFORE_MS;
