/**
 * The hooks every screen shares: load something from the adapter, follow a
 * conversation, and hold what the whole app knows (profile, agents,
 * conversations, and which capabilities this instance has).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { FaceState } from '../design/face.tsx';
import { adapter, type Result, subscribeConversation } from './adapter.ts';
import {
  acceptLocalTurn,
  addLocalTurn,
  adoptSaved,
  applyEvent,
  applyGap,
  applyHistory,
  applyMessageEvent,
  emptyTranscript,
  fillAnswers,
  fillTurns,
  fromTurns,
  replayedStatus,
  setDelivery,
  setDrafts,
  type Transcript,
} from './reduce.ts';
import type {
  Agent,
  Capabilities,
  Conversation,
  ExperienceEvent,
  Permission,
  Profile,
  Question,
  Turn,
  TurnStatus,
} from './types.ts';

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
  /** Setup is finished or skipped, as the service records it. */
  onboarded: boolean;
  /** Marks setup done here at once, and on the service when it is not yet recorded. */
  setOnboarded: (next: boolean) => void;
  agents: Agent[];
  /** Agents deleted from the space, only to name the turns they answered. */
  removedAgents?: Agent[];
  conversations: Conversation[];
  /** Why the chat list could not be read, while it could not; the list keeps what was last read. */
  conversationsError: string | null;
  /** What waits on the person, read in the same refresh as the conversations. */
  decisions: Decisions;
  refreshProfile: () => void;
  /** Reads the conversations, the open permissions and the open questions together. */
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

/** The agent that answered a turn, a deleted one named as removed. */
export function turnAgent(
  agents: Agent[],
  removed: Agent[] | undefined,
  id: string | null | undefined,
): Agent | null {
  const live = agentById(agents, id);
  if (live) return live;
  const gone = agentById(removed ?? [], id);
  return gone ? { ...gone, name: `${gone.name} (removed)` } : null;
}

/** Melete, the agent every space has: a new chat, Home and routines go to it unless told otherwise. */
export const defaultAgentOf = (agents: Agent[]): Agent | null =>
  agents.find((agent) => agent.is_default) ?? agents[0] ?? null;

/**
 * What waits on the person: open permissions and open questions. `error` is
 * the service's sentence when either list could not be read; the lists keep
 * what was last read.
 */
export type Decisions = {
  permissions: Permission[];
  questions: Question[];
  loaded: boolean;
  error: string | null;
};

export const NO_DECISIONS: Decisions = {
  permissions: [],
  questions: [],
  loaded: false,
  error: null,
};

/** The open decisions, read once per refresh for the whole app. */
export function useDecisions(): Decisions & { count: number } {
  const { decisions } = useApp();
  return { ...decisions, count: decisions.permissions.length + decisions.questions.length };
}

/** The face an agent wears for a conversation's status. */
export function faceOf(status: TurnStatus | undefined): FaceState {
  switch (status) {
    case 'queued':
    case 'working':
    case 'streaming':
      return 'working';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'paused':
    case 'stopped':
      return 'inactive';
    default:
      return 'idle';
  }
}

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
  accepted: (localId: string, turnId: string, receivedAt: string) => void;
  settle: (localId: string, delivery: Turn['delivery']) => void;
  /** Show the conversation as the service now has it, after a rename. */
  renamed: (conversation: Conversation) => void;
};

/** The statuses a turn ends at, after which its saved answer is read. */
const FINISHED_STATUSES: TurnStatus[] = ['done', 'failed', 'stopped'];

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
      // The saved turns and the conversation say where things stand; the
      // history only fills in what happened. A status it passes through is
      // not shown, so an old turn never reads as working while it replays.
      initial = applyHistory(initial, page.data?.events ?? []);
      // Where the history last left each turn. Read beside the saved turns, it
      // may be newer than them; where the two differ, they are read again.
      const ended = new Map<string, TurnStatus>();
      const note = (events: readonly ExperienceEvent[]) => {
        for (const event of events)
          if (event.item.type === 'status' && event.turn_id)
            ended.set(event.turn_id, event.item.status);
      };
      note(page.data?.events ?? []);
      // Saved answers already contain what the replayed deltas said.
      const quiet = (transcript: Transcript): Transcript => ({
        ...transcript,
        turns: transcript.turns.map((turn) => ({ ...turn, streamed: '', streaming: false })),
      });
      initial = quiet(initial);
      setTranscriptState(initial);
      setLoading(false);

      // The rest of a long history is read the same way before the stream
      // opens, and the saved state read again after it: anything that changed
      // while the history was read is in that copy, and the stream carries on
      // from the last event read.
      let cursor = Math.max(initial.lastSeq, page.data?.next_cursor ?? 0);
      let more = page.data?.has_more === true;
      while (more) {
        const next = await adapter.eventsSince(id, cursor);
        if (controller.signal.aborted) return;
        if (!next.data || next.data.next_cursor <= cursor) break;
        const events = next.data.events;
        note(events);
        setTranscriptState((previous) => quiet(applyHistory(previous, events)));
        cursor = next.data.next_cursor;
        more = next.data.has_more;
      }
      const savedTurns = turns.data?.turns ?? [];
      if (savedTurns.some((turn) => (ended.get(turn.id) ?? turn.status) !== turn.status)) {
        const [fresh, saved] = await Promise.all([adapter.conversation(id), adapter.turns(id)]);
        if (controller.signal.aborted) return;
        if (fresh.data && saved.data) {
          const { composer, status } = fresh.data.conversation;
          const turns = saved.data.turns;
          setConversation(fresh.data.conversation);
          setTranscriptState((previous) => adoptSaved(previous, turns, composer, status));
        }
      }

      // Start after the saved turns are installed so their state cannot overwrite message identities.
      void (async () => {
        for await (const item of adapter.messageEvents(id, controller.signal)) {
          if (controller.signal.aborted) return;
          if (item.type === 'event')
            setTranscriptState((previous) => applyMessageEvent(previous, item.event));
        }
      })();

      // A finished turn's saved answer is its final message alone: read it once it ends.
      const readAnswers = () =>
        void adapter.turns(id).then((saved) => {
          if (controller.signal.aborted || !saved.data) return;
          const turns = saved.data.turns;
          setTranscriptState((previous) => fillAnswers(previous, turns));
        });
      // A turn started elsewhere arrives as events first; its saved text is read once.
      const reading = new Set<string>();
      const readTurn = (turnId: string | null) => {
        if (!turnId || reading.has(turnId) || turnId.startsWith('local_')) return;
        reading.add(turnId);
        void adapter.turns(id).then((saved) => {
          if (controller.signal.aborted || !saved.data) return;
          const turns = saved.data.turns;
          // Not saved yet: the next event for this turn reads it again.
          if (!turns.some((turn) => turn.id === turnId)) reading.delete(turnId);
          setTranscriptState((previous) => fillTurns(previous, turns));
        });
      };
      for await (const item of subscribeConversation(id, {
        after: cursor,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        if (item.type === 'open') setLive(true);
        else if (item.type === 'gap') {
          setLive(false);
          setTranscriptState((previous) => applyGap(previous, item.gap));
        } else {
          const event = item.event;
          const said = event.item;
          setTranscriptState((previous) => {
            const next = applyEvent(previous, event);
            if (next.turns.some((turn) => turn.unread && turn.id === event.turn_id))
              queueMicrotask(() => readTurn(event.turn_id));
            if (said.type === 'status' && !replayedStatus(previous, event)) {
              const { status, composer } = said;
              queueMicrotask(() => {
                setConversation((current) =>
                  current ? { ...current, status, composer } : current,
                );
                if (FINISHED_STATUSES.includes(status) || status === 'needs_you') readAnswers();
              });
            }
            return next;
          });
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
    (localId: string, turnId: string, receivedAt: string) =>
      setTranscriptState((previous) => acceptLocalTurn(previous, localId, turnId, receivedAt)),
    [],
  );
  const settle = useCallback(
    (localId: string, delivery: Turn['delivery']) =>
      setTranscriptState((previous) => setDelivery(previous, localId, delivery)),
    [],
  );

  return {
    conversation,
    transcript,
    setTranscript,
    live,
    error,
    loading,
    local,
    accepted,
    settle,
    renamed: setConversation,
  };
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
