/**
 * The model calls this process's gateways are making, so that stopping an
 * attempt ends its calls at once. Without this a call kept streaming from the
 * provider to its output limit after the person pressed Stop: the engine that
 * made it does not always hang up, and the provider bills what it generates.
 */
type ModelCall = { jobId: string; attemptId: string; stop: () => void };

const calls = new Set<ModelCall>();

/** Register a call in progress; the returned function removes it when the call ends. */
export function trackModelCall(call: ModelCall): () => void {
  calls.add(call);
  return () => {
    calls.delete(call);
  };
}

/** Stop the calls of a job, or of one of its attempts. Returns how many were stopped. */
export function stopModelCalls(jobId: string, attemptId?: string): number {
  let stopped = 0;
  for (const call of [...calls])
    if (call.jobId === jobId && (!attemptId || call.attemptId === attemptId)) {
      calls.delete(call);
      call.stop();
      stopped++;
    }
  return stopped;
}
