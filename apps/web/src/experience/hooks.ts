/**
 * The hooks every screen shares: load something from the adapter, follow a
 * conversation, and hold what the whole app knows (profile, agents,
 * conversations, and which capabilities this instance has).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { adapter, type Result, subscribeConversation } from './adapter.ts';
import {
  acceptLocalTurn,
  addLocalTurn,
  applyEvent,
  applyEvents,
  applyGap,
  emptyTranscript,
  fromTurns,
  setDelivery,
  setDrafts,
  type Transcript,
} from './reduce.ts';
import type { Agent, Capabilities, Conversation, Profile, Turn } from './types.ts';

export type Loaded<T> = {
  data: T | null;
  error: string | null;
  /** The plain reason a capability is not connected. The surface is not drawn. */
  unavailable: string | null;
  loading: boolean;
  reload: () => void;
  /** Replace what is shown without a round trip, after a mutation answered. */
  set: (next: T) => void;
};

/** Load once, and again whenever `deps` change or `reload` is called. */
export function useLoad<T>(load: () => Promise<Result<T>>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
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
      if (result.error !== null) setError(result.error);
      else if (result.unavailable !== null) {
        setUnavailable(result.unavailable);
        setError(null);
      } else {
        setData(result.data);
        setError(null);
        setUnavailable(null);
      }
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((n) => n + 1), []);
  const set = useCallback((next: T) => setData(next), []);
  return { data, error, unavailable, loading, reload, set };
}

/* ---------- app-wide context ---------- */

export type AppContextValue = {
  capabilities: Capabilities;
  profile: Profile | null;
  /** Set up on this browser. Stored locally: the contract has no onboarding record. */
  onboarded: boolean;
  setOnboarded: (next: boolean) => void;
  agents: Agent[];
  conversations: Conversation[];
  refreshProfile: () => void;
  refreshConversations: () => void;
  refreshAgents: () => void;
  /** Ends the session on the service and returns to sign-in. */
  signOut: () => Promise<void>;
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
  conversation: Conversation | null;
  transcript: Transcript;
  setTranscript: (update: (previous: Transcript) => Transcript) => void;
  live: boolean;
  error: string | null;
  loading: boolean;
  /** Draw the message before the service confirms it; settle it when it answers. */
  local: (text: string, agentId: string, delivery: Turn['delivery']) => string;
  accepted: (localId: string, turnId: string) => void;
  settle: (localId: string, delivery: Turn['delivery']) => void;
};

/**
 * Load a conversation, its saved turns and its drafts, then follow its events
 * from the last seq the history held. Reconnects resume from the last event
 * drawn; a break becomes a gap on the transcript.
 */
export function useConversation(id: string | null): ConversationState {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [transcript, setTranscriptState] = useState<Transcript>(emptyTranscript);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(id));

  useEffect(() => {
    if (!id) {
      setConversation(null);
      setTranscriptState(emptyTranscript());
      setLive(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTranscriptState(emptyTranscript());

    void (async () => {
      const [head, turns, drafts, page] = await Promise.all([
        adapter.conversation(id),
        adapter.turns(id),
        adapter.drafts(id),
        adapter.eventsSince(id, 0),
      ]);
      if (controller.signal.aborted) return;
      if (head.error !== null) {
        setError(head.error);
        setLoading(false);
        return;
      }
      if (head.unavailable !== null) {
        setError(head.unavailable);
        setLoading(false);
        return;
      }
      setConversation(head.data.conversation);
      let initial = fromTurns(
        turns.data?.turns ?? [],
        head.data.conversation.composer,
        head.data.conversation.status,
      );
      initial = setDrafts(initial, drafts.data?.drafts ?? []);
      initial = applyEvents(initial, page.data?.events ?? []);
      // Saved answers already contain what the replayed deltas said.
      initial = {
        ...initial,
        turns: initial.turns.map((turn) => ({ ...turn, streamed: '', streaming: false })),
      };
      setTranscriptState(initial);
      setLoading(false);

      for await (const item of subscribeConversation(id, {
        after: initial.lastSeq,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        if (item.type === 'open') setLive(true);
        else if (item.type === 'gap') {
          setLive(false);
          setTranscriptState((previous) => applyGap(previous, item.gap));
        } else {
          setTranscriptState((previous) => applyEvent(previous, item.event));
          if (item.event.item.type === 'status') {
            const { status, composer } = item.event.item;
            setConversation((previous) =>
              previous ? { ...previous, status, composer } : previous,
            );
          }
        }
      }
    })();

    return () => {
      controller.abort();
      setLive(false);
    };
  }, [id]);

  const setTranscript = useCallback(
    (update: (previous: Transcript) => Transcript) => setTranscriptState(update),
    [],
  );
  const local = useCallback(
    (text: string, agentId: string, delivery: Turn['delivery']) => {
      const localId = `local_${Date.now()}`;
      setTranscriptState((previous) =>
        addLocalTurn(previous, text, agentId, id ?? '', delivery, localId),
      );
      return localId;
    },
    [id],
  );
  const accepted = useCallback(
    (localId: string, turnId: string) =>
      setTranscriptState((previous) => acceptLocalTurn(previous, localId, turnId)),
    [],
  );
  const settle = useCallback(
    (localId: string, delivery: Turn['delivery']) =>
      setTranscriptState((previous) => setDelivery(previous, localId, delivery)),
    [],
  );

  return { conversation, transcript, setTranscript, live, error, loading, local, accepted, settle };
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

/** A stable idempotency key per message attempt, so a retry never doubles a send. */
export function messageKey(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/* ---------- the look of an agent, from the contract's fields ---------- */

export type FaceShape = 'square' | 'blob' | 'diamond' | 'octagon' | 'gear';

export function lookOf(agent: Pick<Agent, 'colour' | 'surface' | 'eye_colour' | 'face_image'>): {
  color: string;
  eyes: 'white' | 'black';
  eyeColor: string;
  shape: FaceShape;
  image: string | null;
} {
  const eye = agent.eye_colour.toLowerCase();
  const luminance =
    Number.parseInt(eye.slice(1, 3), 16) * 0.299 +
    Number.parseInt(eye.slice(3, 5), 16) * 0.587 +
    Number.parseInt(eye.slice(5, 7), 16) * 0.114;
  return {
    color: agent.colour,
    eyes: luminance > 140 ? 'white' : 'black',
    eyeColor: agent.eye_colour,
    shape: agent.surface === 'rounded' ? 'square' : agent.surface,
    image: agent.face_image ?? null,
  };
}
