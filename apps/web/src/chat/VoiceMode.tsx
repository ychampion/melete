/**
 * Voice mode: a hands-free conversation inside the chat.
 *
 * It sits where the composer was, so the transcript, the tool trail and any
 * decision stay on screen above it. The microphone streams to a realtime
 * transcription session the service opens for this conversation; each finished
 * utterance is sent through the ordinary send path, exactly as if it had been
 * typed. The reply is read aloud a sentence at a time as it streams. Speaking
 * over it stops the playback.
 *
 * A decision is never taken by voice. When the reply waits on one, voice mode
 * says so, stops reading, and points at the card.
 */
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import { answerOf, type Transcript } from '../experience/reduce.ts';
import { base64, microphoneProblem, nextPiece, openMicrophone, speakable } from './voice.ts';

export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'stopped';

const PHASE_WORDS: Record<VoicePhase, string> = {
  connecting: 'Starting…',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  stopped: 'Stopped',
};

const DECISION = 'This needs your decision. It is on the screen.';

type Message = { message_type?: string; text?: string; error?: string };

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
  onSend,
  onEnd,
  onShowDecision,
}: {
  conversationId: string;
  transcript: Transcript;
  /** The ordinary send path. Resolves true once the service has the message. */
  onSend: (text: string) => Promise<boolean>;
  onEnd: () => void;
  /** Bring the waiting decision into view. */
  onShowDecision: () => void;
}) {
  const [phase, setPhase] = useState<VoicePhase>('connecting');
  const [muted, setMuted] = useState(false);
  const [caption, setCaption] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;
  const turns = useRef(transcript.turns.length);
  turns.current = transcript.turns.length;

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
      else {
        setPhase((current) => (current === 'speaking' ? 'listening' : current));
        // A finished reply leaves the caption, except the note that a decision waits.
        setCaption((current) => (current === DECISION ? current : ''));
      }
    };
    audio.onended = done;
    audio.onerror = done;
    await audio.play().catch(done);
  }, []);

  const say = useCallback(
    (text: string) => {
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

  /* ---------- the reply to the latest utterance ---------- */
  const replying = useRef<{ index: number; spoken: number; told: boolean } | null>(null);

  useEffect(() => {
    const current = replying.current;
    if (!current) return;
    const turn = transcript.turns[current.index];
    if (!turn) return;
    if (waitingOnPerson(transcript, current.index)) {
      if (!current.told) {
        current.told = true;
        setCaption(DECISION);
        say(DECISION);
      }
      return;
    }
    const finished = !['queued', 'working', 'streaming'].includes(turn.status) && !turn.streaming;
    const text = speakable(answerOf(turn));
    for (
      let piece = nextPiece(text, current.spoken, finished);
      piece;
      piece = nextPiece(text, current.spoken, finished)
    ) {
      current.spoken = piece.end;
      setCaption(piece.piece);
      say(piece.piece);
    }
    if (finished) {
      replying.current = null;
      if (!playing.current && queue.current.length === 0) setPhase('listening');
    }
  }, [transcript, say]);

  /* ---------- listening: session, microphone, socket ---------- */
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts everything again
  useEffect(() => {
    let closed = false;
    let socket: WebSocket | null = null;
    let mic: { close: () => void } | null = null;
    setPhase('connecting');
    setProblem(null);
    setCaption('');
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
          // The person is talking: stop reading the reply to them.
          if (playing.current || queue.current.length) {
            hush();
            replying.current = null;
          }
          setCaption(text);
          setPhase('listening');
        } else if (message.message_type === 'committed_transcript' && text) {
          setCaption(text);
          replying.current = { index: turns.current, spoken: 0, told: false };
          setPhase('thinking');
          void onSendRef.current(text).then((sent) => {
            if (!sent) {
              replying.current = null;
              setPhase('listening');
            }
          });
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
          setPhase('listening');
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

  useEffect(() => {
    panel.current?.focus();
  }, []);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEnd();
    }
  };

  const decision = waitingOnPerson(transcript, transcript.turns.length - 1);
  const shown = muted && phase === 'listening' ? 'Muted' : PHASE_WORDS[phase];

  return (
    <section
      ref={panel}
      className="voice-panel"
      data-phase={phase}
      aria-label="Voice mode"
      tabIndex={-1}
      onKeyDown={onKey}
    >
      <div className="voice-orb" aria-hidden="true">
        <span />
      </div>
      <div className="voice-body">
        <div className="voice-phase" role="status" aria-live="polite">
          {shown}
        </div>
        <p className="voice-caption" aria-live="polite">
          {problem ?? (caption || (phase === 'listening' ? 'Say what you need.' : ''))}
        </p>
        {decision && !problem ? (
          <button type="button" className="voice-link" onClick={onShowDecision}>
            Show the decision
          </button>
        ) : null}
      </div>
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
            <span>{muted ? 'Unmute' : 'Mute'}</span>
          </button>
        )}
        <button type="button" className="voice-btn" data-variant="end" onClick={onEnd}>
          <Icon name="x" size={16} />
          <span>End</span>
        </button>
      </div>
    </section>
  );
}
