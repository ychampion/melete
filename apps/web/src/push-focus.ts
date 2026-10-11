/**
 * Tells the service when this window is in front of the person, so an answer
 * that arrives while they are looking is not pushed to their phone as well.
 * Once when the window gains focus or becomes visible, and once a minute while
 * it stays visible. A hidden window says nothing, and the beat stops.
 */
import { useEffect } from 'react';
import { adapter } from './experience/adapter.ts';

/** Under the service's two-minute grace, so a window left open is always counted. */
export const FOCUS_BEAT_MS = 60_000;

export function useFocusBeat(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn) return;
    let last = 0;
    const beat = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      // Focus and visibility often fire together; one report covers both.
      if (now - last < 5_000) return;
      last = now;
      void adapter.pushFocus();
    };
    beat();
    const timer = window.setInterval(beat, FOCUS_BEAT_MS);
    window.addEventListener('focus', beat);
    document.addEventListener('visibilitychange', beat);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', beat);
      document.removeEventListener('visibilitychange', beat);
    };
  }, [signedIn]);
}
