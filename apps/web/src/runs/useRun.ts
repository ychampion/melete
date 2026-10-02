/**
 * One piece of work, kept current. Reads and actions are numbered as they
 * start, and an answer is shown only when nothing newer has started since, so
 * a read that began before Pause, Stop or a reply can never put the old state
 * back. Reads are skipped while an action is out; an action that never answers
 * stops holding them back after a while, so the page keeps updating.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { adapter, type Result } from '../experience/adapter.ts';
import type { Run } from '../experience/types.ts';

/** How long an unanswered action may hold back reads. */
export const ACTION_HOLD_MS = 20_000;

/** Which answer may show: only the one for the newest request started. */
export function createGate(now: () => number = Date.now) {
  let newest = 0;
  const holds = new Map<number, number>();
  return {
    /** A read; null when an action is out and reads wait for it. */
    read(): number | null {
      const at = now();
      for (const [ticket, until] of holds) if (until <= at) holds.delete(ticket);
      return holds.size > 0 ? null : ++newest;
    },
    /** An action: everything started before it is now out of date. */
    act(): number {
      newest += 1;
      holds.set(newest, now() + ACTION_HOLD_MS);
      return newest;
    },
    /** Whether this answer may show, and the end of any hold it had. */
    settle(ticket: number): boolean {
      holds.delete(ticket);
      return ticket === newest;
    },
  };
}

export function useRun(id: string) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const gate = useRef(createGate());

  const reload = useCallback(() => {
    const ticket = gate.current.read();
    if (ticket === null) return;
    void adapter.run(id).then((result) => {
      if (!gate.current.settle(ticket)) return;
      if (result.data) {
        setRun(result.data.run);
        setError(null);
        setUnavailable(null);
      } else if (result.unavailable !== null) setUnavailable(result.unavailable);
      else setError(result.error);
    });
  }, [id]);

  useEffect(reload, [reload]);

  /** Run an action; its answer replaces the view unless a newer one started. */
  const act = useCallback(
    async (call: () => Promise<Result<{ run: Run }>>): Promise<Result<{ run: Run }>> => {
      const ticket = gate.current.act();
      const result = await call();
      if (gate.current.settle(ticket) && result.data) setRun(result.data.run);
      // Reads skipped while it was out: catch up once nothing holds them back.
      else reload();
      return result;
    },
    [reload],
  );

  return { run, error, unavailable, reload, act };
}
