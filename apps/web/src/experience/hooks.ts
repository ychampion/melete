/**
 * The hooks every screen shares: load something from the adapter, follow a
 * conversation, and hold what the whole app knows (profile, agents,
 * conversations, and which capabilities this instance has).
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { FaceState } from '../design/face.tsx';
import { adapter, type Result, subscribeConversation } from './adapter.ts';
import {
  FIRST_PAGE,
  keepConversation,
  keptConversation,
  openConversation,
  prependOlder,
  readOlder,
} from './history.ts';
import {
  acceptLocalSteer,
  acceptLocalTurn,
  addLocalSteer,
  addLocalTurn,
  adoptSaved,
  applyEvent,
  applyGap,
  applyMessageEvent,
  dropLocalSteer,
  emptyTranscript,
  fillAnswers,
  fillTurns,
  replayedStatus,
  setDelivery,
  type Transcript,
} from './reduce.ts';
import type {
  Agent,
  Capabilities,
  Conversation,
  Permission,
  Profile,
  Question,
  RoomHandoff,
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
  /**
   * Signed in as a guest: an account invited into rooms, whose sign-in reaches
   * only those rooms and its own account. Every personal surface stays away.
   */
  guest?: boolean;
  /**
   * Signed in to a shared space someone else owns. A member chats, plans and
   * keeps routines of their own there; the space's setup, apps, agents and
   * rules are its owner's, so their screens stay out of a member's way.
   */
  member?: boolean;
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
  /** Tasks rooms handed the person, and results of them waiting to be shared or kept. */
  handoffs: RoomHandoff[];
  loaded: boolean;
  error: string | null;
};

export const NO_DECISIONS: Decisions = {
  permissions: [],
  questions: [],
  handoffs: [],
  loaded: false,
  error: null,
};

/** The open decisions, read once per refresh for the whole app. */
export function useDecisions(): Decisions & { count: number } {
  const { decisions } = useApp();
  return {
    ...decisions,
    // A task already running with the person's setup waits on nothing from them.
    count:
      decisions.permissions.length +
      decisions.questions.length +
      decisions.handoffs.filter(
        (handoff) => handoff.state === 'pending' || handoff.state === 'settled',
      ).length,
  };
}

/** The face an agent wears for a conversation's status. */
export function faceOf(status: TurnStatus | undefined): FaceState {
  switch (status) {
    case 'queued':
    case 'working':
    case 'streaming':
    case 'stalled':
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
  /** When the stream last carried anything from the work (keepalives aside), in ms. */
  lastEventAt: number | null;
  error: string | null;
  loading: boolean;
  /** Read the conversation again, after it could not be read. */
  reload: () => void;
  /** Draw the message before the service confirms it; settle it when it answers. */
  local: (
    text: string,
    agentId: string,
    delivery: Turn['delivery'],
    attachments?: NonNullable<Turn['attachments']>,
  ) => string;
  accepted: (localId: string, turnId: string, receivedAt: string) => void;
  settle: (localId: string, delivery: Turn['delivery']) => void;
  /** Draw words for the running turn inside it; settle them once the service answers. */
  steer: (text: string) => string;
  /** `steerId` when the running turn took them; null when they did not go to it. */
  steered: (localId: string, steerId: string | null) => void;
  /** Show the conversation as the service now has it, after a rename. */
  renamed: (conversation: Conversation) => void;
  /** Whether turns older than those read are there, and reading them. */
  older: OlderState & { load: () => Promise<void> };
};

export type OlderState = {
  /** Turns older than the ones read are on the service. */
  more: boolean;
  loading: boolean;
  /** Why the last read of them failed; reading again may work. */
  error: string | null;
  /** How many turns the chat has in all, when the service says. */
  total: number | null;
};
const NO_OLDER: OlderState = { more: false, loading: false, error: null, total: null };

/** Turns drawn here before the service has them, carried onto a fresh read. */
function withLocalTurns(fresh: Transcript, shown: Transcript): Transcript {
  const known = new Set(fresh.turns.map((turn) => turn.id));
  const local = shown.turns.filter((turn) => turn.id.startsWith('local_') && !known.has(turn.id));
  return local.length ? { ...fresh, turns: [...fresh.turns, ...local] } : fresh;
}

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
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(id));
  /** Counts each "try again", so the whole conversation is read again. */
  const [attempt, setAttempt] = useState(0);
  const [older, setOlder] = useState<OlderState>(NO_OLDER);
  /** Where older turns continue, read synchronously by `loadOlder`. */
  const olderRef = useRef<{ cursor: string | null; total: number | null }>({
    cursor: null,
    total: null,
  });
  const olderLoading = useRef(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const currentId = useRef(id);
  currentId.current = id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is the reason to read again
  useEffect(() => {
    setLastEventAt(null);
    olderRef.current = { cursor: null, total: null };
    olderLoading.current = false;
    setOlder(NO_OLDER);
    if (!id) {
      setConversation(null);
      setTranscriptState(emptyTranscript());
      setLive(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setError(null);
    // A chat read before is drawn at once from what was read, and read again behind it.
    const copy = keptConversation(id);
    if (copy) {
      setConversation(copy.conversation);
      setTranscriptState(copy.transcript);
      olderRef.current = { cursor: copy.older, total: copy.total };
      setOlder({ more: copy.older !== null, loading: false, error: null, total: copy.total });
      setLoading(false);
    } else {
      setConversation(null);
      setLoading(true);
      setTranscriptState(emptyTranscript());
    }
    // The newest turns the service has, without their events: to read answers and turns by.
    const newest = () => adapter.turnsPage(id, { limit: FIRST_PAGE });

    void (async () => {
      const opened = await openConversation(id, controller.signal);
      if (controller.signal.aborted || opened === null) return;
      if (opened.data === null) {
        // Messages that could not be read are not an empty chat: say so, and offer to read
        // again. A copy kept from before stays on screen under the error.
        setError(opened.error);
        setLoading(false);
        return;
      }
      const { conversation, transcript: initial, turns: savedTurns, ended, cursor } = opened.data;
      setConversation(conversation);
      // A message sent while this was read, from the copy kept before, stays drawn.
      setTranscriptState((previous) => withLocalTurns(initial, previous));
      olderRef.current = { cursor: opened.data.older, total: opened.data.total };
      setOlder({
        more: opened.data.older !== null,
        loading: false,
        error: null,
        total: opened.data.total,
      });
      setLoading(false);

      // Where the history last left each turn, read beside the saved turns, may
      // be newer than them; where the two differ, they are read again, and the
      // stream carries on from the last event read.
      if (savedTurns.some((turn) => (ended.get(turn.id) ?? turn.status) !== turn.status)) {
        const [fresh, saved] = await Promise.all([adapter.conversation(id), newest()]);
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
        for await (const item of adapter.messageEvents(
          id,
          controller.signal,
          opened.data.messagesAfter,
        )) {
          if (controller.signal.aborted) return;
          if (item.type === 'event')
            setTranscriptState((previous) => applyMessageEvent(previous, item.event));
        }
      })();

      // A finished turn's saved answer is its final message alone: read it once it ends.
      const readAnswers = () =>
        void newest().then((saved) => {
          if (controller.signal.aborted || !saved.data) return;
          const turns = saved.data.turns;
          setTranscriptState((previous) => fillAnswers(previous, turns));
        });
      // A turn started elsewhere arrives as events first; its saved text is read once.
      const reading = new Set<string>();
      const readTurn = (turnId: string | null) => {
        if (!turnId || reading.has(turnId) || turnId.startsWith('local_')) return;
        reading.add(turnId);
        void newest().then((saved) => {
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
        if (item.type === 'open') {
          setLive(true);
          // Counted from when the page started following, until the first event.
          setLastEventAt((previous) => previous ?? Date.now());
        } else if (item.type === 'gap') {
          setLive(false);
          setTranscriptState((previous) => applyGap(previous, item.gap));
        } else {
          const event = item.event;
          const said = event.item;
          setLastEventAt(Date.now());
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
  }, [id, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // What is shown is kept, so going back to this chat draws it at once.
  useEffect(() => {
    if (!id || !conversation || conversation.id !== id || loading) return;
    keepConversation(id, {
      conversation,
      transcript,
      older: olderRef.current.cursor,
      total: olderRef.current.total,
      at: Date.now(),
    });
  }, [id, conversation, transcript, loading]);

  /** Read the turns before the oldest one shown, once at a time. */
  const loadOlder = useCallback(async () => {
    const before = olderRef.current.cursor;
    if (!id || !before || olderLoading.current) return;
    olderLoading.current = true;
    setOlder((current) => ({ ...current, loading: true, error: null }));
    const read = await readOlder(id, before, transcriptRef.current);
    olderLoading.current = false;
    // Moved to another chat, or read again from the top, while this was read.
    if (olderRef.current.cursor !== before || currentId.current !== id) return;
    if (read.data === null) {
      const failure = read.error;
      setOlder((current) => ({ ...current, loading: false, error: failure }));
      return;
    }
    const page = read.data;
    olderRef.current = { cursor: page.older, total: page.total ?? olderRef.current.total };
    setTranscriptState((previous) => prependOlder(previous, page));
    setOlder({
      more: page.older !== null,
      loading: false,
      error: null,
      total: olderRef.current.total,
    });
  }, [id]);

  const setTranscript = useCallback(
    (update: (previous: Transcript) => Transcript) => setTranscriptState(update),
    [],
  );
  const local = useCallback(
    (
      text: string,
      agentId: string,
      delivery: Turn['delivery'],
      attachments: NonNullable<Turn['attachments']> = [],
    ) => {
      const localId = `local_${Date.now()}`;
      setTranscriptState((previous) => {
        const next = addLocalTurn(previous, text, agentId, id ?? '', delivery, localId);
        if (!attachments.length) return next;
        // The files show on the message from the moment it is drawn.
        return {
          ...next,
          turns: next.turns.map((entry) =>
            entry.id === localId ? { ...entry, turn: { ...entry.turn, attachments } } : entry,
          ),
        };
      });
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
  const steer = useCallback((text: string) => {
    const localId = `local_steer_${Date.now()}`;
    setTranscriptState((previous) => addLocalSteer(previous, localId, text));
    return localId;
  }, []);
  const steered = useCallback(
    (localId: string, steerId: string | null) =>
      setTranscriptState((previous) =>
        steerId ? acceptLocalSteer(previous, localId, steerId) : dropLocalSteer(previous, localId),
      ),
    [],
  );

  return {
    conversation,
    transcript,
    setTranscript,
    live,
    lastEventAt,
    error,
    loading,
    reload,
    local,
    accepted,
    settle,
    steer,
    steered,
    renamed: setConversation,
    older: { ...older, load: loadOlder },
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
