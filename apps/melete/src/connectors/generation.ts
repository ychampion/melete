export type FencedExecution = { outcome: 'fenced'; reason: 'connection_generation' };

/** A queued execution may only use the connection generation its admission reviewed. */
export function checkConnectionGeneration(
  admitted: number,
  current: number,
  active: boolean,
): FencedExecution | null {
  return !active || admitted !== current
    ? { outcome: 'fenced', reason: 'connection_generation' }
    : null;
}
