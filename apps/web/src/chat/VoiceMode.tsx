/**
 * Voice mode: a call with the agent inside the chat.
 *
 * It sits where the composer was, so the transcript, the tool trail and any
 * decision stay on screen above it; minimised, it shrinks to a bar and the
 * composer comes back while the call goes on. The microphone streams to a
 * realtime transcription session the service opens for this conversation.
 *
 * With nothing running, a finished utterance is sent through the ordinary send
 * path, exactly as if it had been typed. While a turn runs, the call keeps
 * talking: what is said goes to the companion, a light model call that sees the
 * conversation and the turn's activity but cannot act. It answers, gives short
 * progress words at natural moments, and recognises an instruction for the
 * work. Stop, pause and carry on go to the existing controls; any other
 * instruction is kept as the next message, sent when the turn ends, and the
 * call says so. The reply is read aloud a sentence at a time as it streams.
 * Speaking over it stops the playback.
 *
 * A decision is never taken by voice. When the reply waits on one, voice mode
 * says so, stops reading, and points at the card.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import { answerOf, type Transcript } from '../experience/reduce.ts';
import {
  activityOf,
  progressDue,
  QUEUED,
  queuedMessage,
  quickCommand,
  routeAside,
  STOPPING,
  stepsDone,
} from './call.ts';
import {
  base64,
  elapsed,
  microphoneProblem,
  nextPiece,
  openMicrophone,
  speakable,
  useNowTick,
} from './voice.ts';

export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped';

const PHASE_WORDS: Record<VoicePhase, string> = {
  connecting: 'Starting…',
  listening: 'Listening',
  thinking: 'Working · talk any time',
  speaking: 'Speaking',
  stopped: 'Stopped',
};

const DECISION = 'This needs your decision. It is on the screen.';
/** A question the agent asked: it is answered on the screen, never by voice. */
const ASKED = 'I’ve asked you something. It’s on your screen.';
const UNSENT = 'I couldn’t send what you added. It’s in the message box.';
const KEPT_AFTER_STOP = 'What you added is in the message box, for when you want it.';

const WORKING = new Set(['queued', 'working', 'streaming', 'paused']);

type Message = { message_type?: string; text?: string; error?: string };

/** Whether the turn asked the person a question that is still open. */
const askedOnScreen = (transcript: Transcript, index: number): boolean =>
  Boolean(
    transcript.turns[index]?.blocks.some(
      (block) => block.type === 'question' && block.answered === null,
    ),
  );

/** Whether the turn is waiting on the person: an open permission or question, or needs_you. */
function waitingOnPerson(transcript: Transcript, index: number): boolean {
  const turn = transcript.turns[index];
  if (!turn) return false;
  return (
    turn.status === 'needs_you' ||
    turn.blocks.some(
      (block) =>
        (block.type === 'permission' && block.decided === null) ||
        (block.type === 'question' && block.answered === null),
    )
  );
}

export function VoicePanel({
  conversationId,
  transcript,
  agentName,
  avatar,
  minimised,
  onMinimise,
  onSend,
  onDraft,
  onEnd,
  onShowDecision,
}: {
  conversationId: string;
  transcript: Transcript;
  /** The conversation's agent, by name; "Melete" when it has none. */
  agentName: string;
  /** The agent's face, small. */
  avatar: ReactNode;
  /** Shrunk to a bar so the chat can be used while the call goes on. */
  minimised: boolean;
  onMinimise: (minimised: boolean) => void;
  /** The ordinary send path. Resolves true once the service has the message. */
  onSend: (text: string) => Promise<boolean>;
  /** Put words in the message box, for something heard that could not be sent. */
  onDraft: (text: string) => void;
  onEnd: () => void;
  /** Bring the waiting decision into view. */
  onShowDecision: () => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('connecting');
  const [muted, setMuted] = useState(false);
  /** What the person said last, and what the agent said last: two captions. */
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [kept, setKept] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const clock = useNowTick(true);
  const panel = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  const lastIndex = transcript.turns.length - 1;
  const latest = transcript.turns[lastIndex];
  const waiting = waitingOnPerson(transcript, lastIndex);
  const working = Boolean(latest && WORKING.has(latest.status)) && !waiting;
  const workingRef = useRef(working);
  workingRef.current = working;

  /* ---------- playback: pieces fetched ahead, played in order ---------- */
  const queue = useRef<Promise<Blob | null>[]>([]);
  const player = useRef<HTMLAudioElement | null>(null);
  const playing = useRef(false);
  const speech = useRef<AbortController>(new AbortController());

  const hush = useCallback(() => {
    speech.current.abort();
    speech.current = new AbortController();
    queue.current = [];
    playing.current = false;
    if (player.current) {
      player.current.pause();
      player.current.removeAttribute('src');
    }
  }, []);

  const playNext = useCallback(async () => {
    if (playing.current) return;
    const next = queue.current.shift();
    if (!next) return;
    playing.current = true;
    const blob = await next;
    if (!blob || !playing.current) {
      playing.current = false;
      if (blob) void playNext();
      return;
    }
    const url = URL.createObjectURL(blob);
    if (!player.current) player.current = new Audio();
    const audio = player.current;
    audio.src = url;
    setPhase('speaking');
    const done = () => {
      URL.revokeObjectURL(url);
      playing.current = false;
      if (queue.current.length) void playNext();
      // Back to the work, or to listening, once the last piece has been read.
      else
        setPhase((current) =>
          current === 'speaking' ? (workingRef.current ? 'thinking' : 'listening') : current,
        );
    };
    audio.onended = done;
    audio.onerror = done;
    await audio.play().catch(done);
  }, []);

  const say = useCallback(
    (text: string) => {
      setSaid(text);
      const signal = speech.current.signal;
      queue.current.push(
        adapter
          .speak(conversationId, text, signal)
          .then((result) => {
            if (result.data === null) {
              setProblem(result.error ?? 'The reply could not be read aloud.');
              return null;
            }
            return result.data;
          })
          .catch(() => null),
      );
      void playNext();
    },
    [conversationId, playNext],
  );

  /* ---------- the reply to the latest message ---------- */
  const replying = useRef<{ index: number; spoken: number; told: boolean } | null>(null);

  useEffect(() => {
    const current = replying.current;
    if (!current) return;
    const turn = transcript.turns[current.index];
    if (!turn) return;
    if (waitingOnPerson(transcript, current.index)) {
      if (!current.told) {
        current.told = true;
        say(askedOnScreen(transcript, current.index) ? ASKED : DECISION);
      }
      return;
    }
    const finished = !WORKING.has(turn.status) && !turn.streaming;
    const text = speakable(answerOf(turn));
    for (
      let piece = nextPiece(text, current.spoken, finished);
      piece;
      piece = nextPiece(text, current.spoken, finished)
    ) {
      current.spoken = piece.end;
      say(piece.piece);
    }
    if (finished) {
      replying.current = null;
      if (!playing.current && queue.current.length === 0) setPhase('listening');
    }
  }, [transcript, say]);

  const send = useCallback((text: string) => {
    replying.current = { index: transcriptRef.current.turns.length, spoken: 0, told: false };
    setPhase('thinking');
    return onSendRef.current(text).then((sent) => {
      if (!sent) {
        replying.current = null;
        setPhase('listening');
      }
      return sent;
    });
  }, []);

  /* ---------- what was said for the work, kept for the next message ---------- */
  const keptRef = useRef<string[]>([]);
  /** The person stopped the work by voice: what they added waits instead of restarting it. */
  const stopped = useRef(false);
  const flushing = useRef(false);

  const keep = useCallback((text: string) => {
    keptRef.current = [...keptRef.current, text];
    setKept(keptRef.current);
  }, []);

  // Once the turn has ended, and nothing waits on the person, what was kept goes as the next message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reply ref clears as the transcript changes, so it is read again then
  useEffect(() => {
    if (working || waiting || flushing.current || replying.current || !keptRef.current.length)
      return;
    const text = queuedMessage(keptRef.current);
    keptRef.current = [];
    setKept([]);
    if (stopped.current) {
      stopped.current = false;
      onDraftRef.current(text);
      say(KEPT_AFTER_STOP);
      return;
    }
    flushing.current = true;
    void send(text).then((sent) => {
      flushing.current = false;
      if (!sent) {
        onDraftRef.current(text);
        say(UNSENT);
      }
    });
  }, [working, waiting, transcript, send, say]);

  /* ---------- talking while the work runs ---------- */
  const asking = useRef(false);
  const progress = useRef({ startedAt: 0, lastAt: null as number | null, lastSteps: 0 });
  const lastHeardAt = useRef(0);

  // A new run of work starts the progress clock again.
  useEffect(() => {
    if (working) progress.current = { startedAt: Date.now(), lastAt: null, lastSteps: 0 };
  }, [working]);

  const aside = useCallback(
    async (text: string) => {
      const command = quickCommand(text);
      if (command === 'stop') {
        stopped.current = true;
        say(STOPPING);
        void adapter.stop(conversationId);
        return;
      }
      if (command === 'pause') {
        say('Paused. Say carry on when you’re ready.');
        void adapter.pause(conversationId);
        return;
      }
      if (command === 'resume') {
        say('Carrying on.');
        void adapter.resume(conversationId);
        return;
      }
      asking.current = true;
      const activity = activityOf(transcriptRef.current.turns.at(-1));
      const result = await adapter
        .voiceAside(conversationId, { kind: 'heard', text, activity })
        .catch(() => ({ data: null }));
      asking.current = false;
      progress.current.lastAt = Date.now();
      progress.current.lastSteps = stepsDone(activity);
      const action = routeAside(text, result.data);
      if (action.kind === 'queue') keep(action.text);
      if (action.kind === 'stop') {
        stopped.current = true;
        void adapter.stop(conversationId);
      }
      say(action.say);
    },
    [conversationId, keep, say],
  );
  const asideRef = useRef(aside);
  asideRef.current = aside;
  const sendRef = useRef(send);
  sendRef.current = send;

  // A progress word at natural moments: a step finished, never over the person, never a flood.
  useEffect(() => {
    if (!working || latest?.status === 'paused' || phase === 'stopped') return;
    const activity = activityOf(latest);
    const state = progress.current;
    const due = progressDue({
      now: clock,
      startedAt: state.startedAt,
      lastAt: state.lastAt,
      steps: stepsDone(activity),
      lastSteps: state.lastSteps,
      busy:
        asking.current ||
        playing.current ||
        queue.current.length > 0 ||
        clock - lastHeardAt.current < 3000,
    });
    if (!due) return;
    asking.current = true;
    state.lastAt = clock;
    state.lastSteps = stepsDone(activity);
    void adapter
      .voiceAside(conversationId, { kind: 'progress', activity })
      .then((result) => {
        if (result.data?.intent === 'talk' && result.data.say && workingRef.current)
          say(result.data.say);
      })
      .finally(() => {
        asking.current = false;
      });
  }, [clock, working, phase, latest, conversationId, say]);

  /* ---------- listening: session, microphone, socket ---------- */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts everything again
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let mic: { close: () => void } | null = null;
    setPhase('connecting');
    setProblem(null);
    setHeard('');
    const stop = (message: string | null) => {
      if (closed) return;
      closed = true;
      mic?.close();
      socket?.close();
      hush();
      setPhase('stopped');
      if (message) setProblem(message);
    };
    void (async () => {
      const session = await adapter.voiceSession(conversationId);
      if (closed) return;
      if (session.data === null) {
        stop(session.error ?? session.unavailable ?? 'Voice mode could not start.');
        return;
      }
      const { url, sample_rate } = session.data;
      socket = new WebSocket(url);
      socket.onmessage = (event) => {
        let message: Message;
        try {
          message = JSON.parse(String(event.data)) as Message;
        } catch {
          return;
        }
        const text = message.text?.trim() ?? '';
        if (message.message_type === 'partial_transcript' && text) {
          lastHeardAt.current = Date.now();
          // The person is talking: stop reading to them. A finished reply is not taken up again.
          if (playing.current || queue.current.length) {
            hush();
            if (!workingRef.current) replying.current = null;
          }
          setHeard(text);
          setPhase((current) =>
            current === 'connecting' ? current : workingRef.current ? 'thinking' : 'listening',
          );
        } else if (message.message_type === 'committed_transcript' && text) {
          lastHeardAt.current = Date.now();
          setHeard(text);
          // While a turn is under way, or waits on the person, nothing is sent over it.
          if (workingRef.current || flushing.current || replying.current)
            void asideRef.current(text);
          else void sendRef.current(text);
        } else if (message.message_type?.endsWith('error') || message.error) {
          stop('The speech service stopped listening. Start again when you are ready.');
        }
      };
      socket.onclose = () => stop('The voice connection ended. Start again when you are ready.');
      socket.onopen = async () => {
        try {
          mic = await openMicrophone(sample_rate, (pcm) => {
            if (mutedRef.current || socket?.readyState !== WebSocket.OPEN) return;
            socket.send(
              JSON.stringify({
                message_type: 'input_audio_chunk',
                audio_base_64: base64(pcm),
                commit: false,
                sample_rate,
              }),
            );
          });
          if (closed) {
            mic.close();
            return;
          }
          setPhase(workingRef.current ? 'thinking' : 'listening');
        } catch (error) {
          stop(microphoneProblem(error));
        }
      };
    })();
    return () => {
      closed = true;
      mic?.close();
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      hush();
    };
  }, [conversationId, attempt, hush]);

  // The work started or ended while the call was quiet: show it.
  useEffect(() => {
    setPhase((current) =>
      current === 'listening' && working
        ? 'thinking'
        : current === 'thinking' && !working && !replying.current
          ? 'listening'
          : current,
    );
  }, [working]);

  useEffect(() => {
    if (!minimised) panel.current?.focus();
  }, [minimised]);

  // Words kept for the next message are never lost to the call ending.
  useEffect(
    () => () => {
      const text = queuedMessage(keptRef.current);
      if (text) onDraftRef.current(text);
    },
    [],
  );

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEnd();
    }
  };

  const shown = muted && phase === 'listening' ? 'Muted' : PHASE_WORDS[phase];
  const timer = elapsed(Math.max(0, clock - startedAt));

  return (
    <section
      ref={panel}
      className="voice-panel"
      data-phase={phase}
      data-minimised={minimised || undefined}
      aria-label={minimised ? `Call with ${agentName}` : 'Voice mode'}
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="voice-head">
        <span className="voice-face" aria-hidden="true">
          {avatar}
          <span className="voice-orb">
            <span />
          </span>
        </span>
        <span className="voice-name">{agentName}</span>
        <span className="voice-phase" role="status" aria-live="polite">
          {shown}
        </span>
        <span className="voice-timer">
          <span className="sr-only">Call time </span>
          {timer}
        </span>
      </div>
      {minimised ? null : (
        <div className="voice-body">
          {problem ? (
            <p className="voice-caption" data-who="problem" aria-live="polite">
              {problem}
            </p>
          ) : (
            <>
              <p className="voice-caption" data-who="you" aria-live="polite">
                <span className="voice-speaker">You</span>
                <span className="voice-words">
                  {heard || (phase === 'connecting' ? '' : 'Say what you need.')}
                </span>
              </p>
              {said ? (
                <p className="voice-caption" data-who="agent" aria-live="polite">
                  <span className="voice-speaker">{agentName}</span>
                  <span className="voice-words">{said}</span>
                </p>
              ) : null}
            </>
          )}
          {kept.length ? (
            <p className="voice-kept" title={QUEUED}>
              <Icon name="clock" size={13} />
              <span className="voice-kept-text">Next message: {queuedMessage(kept)}</span>
            </p>
          ) : null}
          {waiting && !problem ? (
            <button type="button" className="voice-link" onClick={onShowDecision}>
              {askedOnScreen(transcript, lastIndex) ? 'Show the question' : 'Show the decision'}
            </button>
          ) : null}
        </div>
      )}
      <div className="voice-actions">
        {phase === 'stopped' ? (
          <button type="button" className="voice-btn" onClick={() => setAttempt((n) => n + 1)}>
            <Icon name="refresh" size={16} />
            <span>Start again</span>
          </button>
        ) : (
          <button
            type="button"
            className="voice-btn"
            aria-pressed={muted}
            onClick={() => setMuted((value) => !value)}
          >
            <Icon name={muted ? 'micOff' : 'mic'} size={16} />
            <span className="voice-btn-label">{muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
        <button
          type="button"
          className="voice-btn"
          aria-label={minimised ? 'Open the call' : 'Minimise the call'}
          onClick={() => onMinimise(!minimised)}
        >
          <Icon name={minimised ? 'maximize' : 'chevronDown'} size={16} />
          <span className="voice-btn-label" aria-hidden="true">
            {minimised ? 'Open' : 'Minimise'}
          </span>
        </button>
        <button type="button" className="voice-btn" data-variant="end" onClick={onEnd}>
          <Icon name="x" size={16} />
          <span className="voice-btn-label">End</span>
        </button>
      </div>
    </section>
  );
}
