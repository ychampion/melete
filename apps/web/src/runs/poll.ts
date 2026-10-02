/**
 * Read again on an interval while it matters: only while `active`, and only
 * while the page is in view. Coming back to the page reads at once.
 */
import { useEffect, useRef } from 'react';

export function usePoll(tick: () => void, everyMs: number, active: boolean) {
  const latest = useRef(tick);
  latest.current = tick;
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => latest.current(), everyMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        latest.current();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active, everyMs]);
}
