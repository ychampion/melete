/**
 * The hooks every screen shares: load something from the adapter, follow a
 * conversation, and remember the capabilities and the session.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { adapter, type Result, subscribeConversation } from './adapter.ts';
import { applyEvent, applyGap, emptyTranscript, reduceAll, type Transcript } from './reduce.ts';
import type {
  Agent,
  Capabilities,
  Conversation,
  ConversationEvent,
  ConversationSummary,
  Session,
} from './types.ts';

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Replace what is shown without a round trip, after a mutation answered. */
  set: (next: T) => void;
};

/** Load once, and again whenever `deps` change or `reload` is called. */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller owns the list; version is the reload counter
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadRef.current().then((result) => {
      if (!live) return;
      if (result.error === null) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const set = useCallback((next: T) => setData(next), []);
  return { data, error, loading, reload, set };
}

/* ---------- app-wide context ---------- */

export type AppContextValue = {
  capabilities: Capabilities;
  session: Session;
  agents: Agent[];
  conversations: ConversationSummary[];
  refreshSession: () => void;
  refreshConversations: () => void;
  refreshAgents: () => void;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp needs the AppContext');
  return value;
}

export const agentById = (agents: Agent[], id: string | null | undefined): Agent | null =>
  (id ? agents.find((agent) => agent.id === id) : null) ?? null;

/* ---------- conversations ---------- */

export type ConversationState = {
  summary: ConversationSummary | null;
  transcript: Transcript;
  live: boolean;
  error: string | null;
  loading: boolean;
  /** Draw a message the person just sent before the service confirms it. */
  optimistic: (text: string, delivery: 'sending' | 'queued' | 'failed') => void;
  settle: (text: string, delivery: 'queued' | 'failed') => void;
};

/**
 * Load a conversation's history, then follow it live from the last seq the
 * history held. Reconnects resume from the last event drawn; a break becomes a
 * gap item in the transcript.
 */
export function useConversation(id: string | null): ConversationState {
  const [summary, setSummary] = useState<ConversationSummary | null>(null);
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(id));

  useEffect(() => {
    if (!id) {
      setSummary(null);
      setTranscript(emptyTranscript());
      setLive(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTranscript(emptyTranscript());

    void (async () => {
      const result = await adapter.conversation(id);
      if (controller.signal.aborted) return;
      if (result.error !== null) {
        setError(result.error);
        setLoading(false);
        return;
      }
      const loaded = result.data as Conversation & { events: ConversationEvent[] };
      setSummary(loaded);
      const initial = reduceAll(loaded.events ?? []);
      setTranscript(initial);
      setLoading(false);

      for await (const item of subscribeConversation(id, {
        after: initial.lastSeq,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        if (item.type === 'open') setLive(true);
        else if (item.type === 'gap') {
          setLive(false);
          setTranscript((previous) => applyGap(previous, item.gap));
        } else {
          setTranscript((previous) => applyEvent(previous, item.event));
        }
      }
    })();

    return () => {
      controller.abort();
      setLive(false);
    };
  }, [id]);

  const optimistic = useCallback((text: string, delivery: 'sending' | 'queued' | 'failed') => {
    setTranscript((previous) => ({
      ...previous,
      items: [
        ...previous.items.filter(
          (item) => !(item.role === 'user' && item.text === text && item.delivery !== 'sent'),
        ),
        {
          id: `local_${Date.now()}`,
          role: 'user',
          text,
          at: new Date().toISOString(),
          delivery,
          attachments: [],
        },
      ],
    }));
  }, []);

  const settle = useCallback((text: string, delivery: 'queued' | 'failed') => {
    setTranscript((previous) => ({
      ...previous,
      items: previous.items.map((item) =>
        item.role === 'user' && item.text === text && item.delivery === 'sending'
          ? { ...item, delivery }
          : item,
      ),
    }));
  }, []);

  return { summary, transcript, live, error, loading, optimistic, settle };
}

/** A small clock for elapsed-time labels that tick while a turn is running. */
export function useNow(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}

/** Whether the viewport is phone-sized, for the collapsed layout. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}
