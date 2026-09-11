/**
 * The three hooks every screen needs: load something, follow the event stream,
 * and remember a preference.
 */
import { type MeleteEvent, subscribeEvents } from '@melete/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { client } from './api.ts';

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

/** Load once, and again whenever `deps` or `version` change. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // The dependency list belongs to the caller, and `version` is the reload
  // counter; neither is something the rule can infer from the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns the list
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadRef
      .current()
      .then((value) => {
        if (!live) return;
        setData(value);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [...deps, version]);

  const reload = useCallback(() => {
    setVersion((n) => n + 1);
  }, []);
  return { data, error, loading, reload };
}

export type StreamGap = { after: number; next: number | null; reason: string };

/**
 * Add a gap to the list, unless the caller is being told about a break it has
 * already drawn. While the service is down the client keeps retrying and every
 * attempt reports the same break; one break in the transcript is one ellipsis,
 * however many tries it took to get back.
 */
export function mergeGap(gaps: StreamGap[], gap: StreamGap): StreamGap[] {
  const known = gaps.some(
    (existing) => existing.reason === gap.reason && existing.after === gap.after,
  );
  return known ? gaps : [...gaps, gap];
}

export type StreamState = {
  events: MeleteEvent[];
  /** Marked by the seq they follow, so a screen can draw them in place. */
  gaps: StreamGap[];
  live: boolean;
  reconnects: number;
};

/**
 * Follow the event stream. A gap is surfaced rather than smoothed over: durable
 * events come back on reconnect, streamed text does not.
 */
export function useEventStream(options: { jobId?: string; enabled?: boolean } = {}): StreamState {
  const { jobId, enabled = true } = options;
  const [state, setState] = useState<StreamState>({
    events: [],
    gaps: [],
    live: false,
    reconnects: 0,
  });

  useEffect(() => {
    if (!enabled) return;
    setState({ events: [], gaps: [], live: false, reconnects: 0 });
    const controller = new AbortController();

    void (async () => {
      try {
        for await (const item of subscribeEvents(client, {
          ...(jobId ? { jobId } : {}),
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          setState((previous) => {
            if (item.type === 'open') {
              return {
                ...previous,
                live: true,
                reconnects: item.attempt > 1 ? previous.reconnects + 1 : previous.reconnects,
              };
            }
            if (item.type === 'gap') {
              return {
                ...previous,
                live: false,
                gaps: mergeGap(previous.gaps, {
                  after: item.after,
                  next: item.next,
                  reason: item.reason,
                }),
              };
            }
            return { ...previous, events: [...previous.events, item.event] };
          });
        }
      } catch {
        setState((previous) => ({ ...previous, live: false }));
      }
    })();

    return () => {
      controller.abort();
    };
  }, [jobId, enabled]);

  return state;
}

export function useStored(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: string) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // A browser with storage blocked still gets a working session.
      }
    },
    [key],
  );
  return [value, set];
}

/** The current hash route, for example `#/jobs/job_01…`. */
export function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
