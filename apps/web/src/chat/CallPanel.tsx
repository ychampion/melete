/**
 * A call with the agent inside the chat, through the speech service.
 *
 * The service starts the call and hands this page a token that is good for a
 * couple of minutes; the speech service's browser client takes the microphone,
 * plays the voice and handles talking over it. Everything the agent does
 * happens in the chat itself: what the person says arrives as a message, the
 * tool rows and the answer stream into the transcript above as they would for
 * a typed turn, and a decision waits on its card on the screen.
 *
 * It sits where the composer was, as voice mode does, and minimises to a bar
 * so the chat can be used while the call goes on. Hanging up ends only the
 * call: work the agent started carries on, and its answer lands in the chat.
 */
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { adapter } from '../experience/adapter.ts';
import type { Transcript } from '../experience/reduce.ts';
import { elapsed, microphoneProblem, useNowTick } from './voice.ts';

export type CallPhase = 'connecting' | 'listening' | 'speaking' | 'ended';

const PHASE_WORDS: Record<CallPhase, string> = {
  connecting: 'Calling…',
  listening: 'Listening',
  speaking: 'Speaking',
  ended: 'Call ended',
};

/** The part of the speech service's call this panel uses. */
type Line = { endSession: () => Promise<void>; setMicMuted: (muted: boolean) => void };

/** Whether the latest turn waits on a decision or a question on the screen. */
function waitingOnPerson(transcript: Transcript): 'decision' | 'question' | null {
  const turn = transcript.turns.at(-1);
  if (!turn) return null;
  if (turn.blocks.some((block) => block.type === 'question' && block.answered === null))
    return 'question';
  if (
    turn.status === 'needs_you' ||
    turn.blocks.some((block) => block.type === 'permission' && block.decided === null)
  )
    return 'decision';
  return null;
}

export function CallPanel({
  conversationId,
  transcript,
  agentName,
  avatar,
  minimised,
  onMinimise,
  onEnd,
  onShowDecision,
}: {
  conversationId: string;
  transcript: Transcript;
  agentName: string;
  avatar: ReactNode;
  minimised: boolean;
  onMinimise: (minimised: boolean) => void;
  onEnd: () => void;
  onShowDecision: () => void;
}) {
  const [phase, setPhase] = useState<CallPhase>('connecting');
  const [muted, setMuted] = useState(false);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const clock = useNowTick(phase !== 'ended');
  const panel = useRef<HTMLDivElement>(null);
  const line = useRef<Line | null>(null);
  /** Whether the person muted, read by a call that connects after they did. */
  const mutedNow = useRef(muted);
  mutedNow.current = muted;
  const waiting = waitingOnPerson(transcript);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts the call again
  useEffect(() => {
    let closed = false;
    setPhase('connecting');
    setProblem(null);
    setHeard('');
    setSaid('');
    setStartedAt(null);
    const end = (message: string | null) => {
      if (closed) return;
      closed = true;
      setPhase('ended');
      if (message) setProblem(message);
    };
    void (async () => {
      // The microphone is asked for first, so a refusal is explained before anything is spent.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
      } catch (error) {
        end(microphoneProblem(error));
        return;
      }
      if (closed) return;
      // Loaded with the first call, so chats that never call do not carry it,
      // and before the token, so a slow or failed load spends none of its minutes.
      let client: typeof import('@elevenlabs/client');
      try {
        client = await import('@elevenlabs/client');
      } catch (error) {
        console.warn('call: the call client could not load', error);
        end('The call could not load. Reload the page and call again.');
        return;
      }
      if (closed) return;
      const started = await adapter.startCall(conversationId);
      if (closed) return;
      if (started.data === null) {
        end(started.error ?? started.unavailable ?? 'The call could not start.');
        return;
      }
      try {
        const conversation = await client.Conversation.startSession({
          conversationToken: started.data.token,
          connectionType: 'webrtc',
          onConnect: () => {
            setStartedAt(Date.now());
            setPhase('listening');
          },
          onModeChange: ({ mode }) => {
            if (!closed) setPhase(mode === 'speaking' ? 'speaking' : 'listening');
          },
          onMessage: ({ message, role }) => {
            const words = message.trim();
            if (!words) return;
            if (role === 'user') setHeard(words);
            else setSaid(words);
          },
          onError: (message) => {
            console.warn('call: the call reported a problem', message);
            end('The call ran into a problem. Call again when you are ready.');
          },
          onDisconnect: (details) =>
            end(
              details.reason === 'user'
                ? null
                : details.reason === 'error'
                  ? 'The call dropped. Call again when you are ready.'
                  : null,
            ),
        });
        if (closed) {
          void conversation.endSession().catch(() => {});
          return;
        }
        line.current = conversation as unknown as Line;
        // Muted before this call connected (or on the call before it): the
        // microphone follows what the button shows.
        if (mutedNow.current) line.current.setMicMuted(true);
      } catch (error) {
        console.warn('call: the call could not connect', error);
        end(
          error instanceof DOMException
            ? microphoneProblem(error)
            : 'The call could not connect. Call again when you are ready.',
        );
      }
    })();
    return () => {
      closed = true;
      const current = line.current;
      line.current = null;
      void current?.endSession().catch(() => {});
    };
  }, [conversationId, attempt]);

  useEffect(() => {
    try {
      line.current?.setMicMuted(muted);
    } catch (error) {
      // A call that has just dropped has no microphone left to mute.
      console.warn('call: the microphone could not be muted', error);
    }
  }, [muted]);

  useEffect(() => {
    if (!minimised) panel.current?.focus();
  }, [minimised]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onEnd();
    }
  };

  const shown = muted && phase === 'listening' ? 'Muted' : PHASE_WORDS[phase];
  const timer = elapsed(startedAt === null ? 0 : Math.max(0, clock - startedAt));

  return (
    <section
      ref={panel}
      className="voice-panel"
      data-phase={phase === 'ended' ? 'stopped' : phase}
      data-minimised={minimised || undefined}
      aria-label={`Call with ${agentName}`}
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
          {waiting && !problem ? (
            <button type="button" className="voice-link" onClick={onShowDecision}>
              {waiting === 'question' ? 'Show the question' : 'Show the decision'}
            </button>
          ) : null}
        </div>
      )}
      <div className="voice-actions">
        {phase === 'ended' ? (
          <button type="button" className="voice-btn" onClick={() => setAttempt((n) => n + 1)}>
            <Icon name="phone" size={16} />
            <span>Call again</span>
          </button>
        ) : (
          <button
            type="button"
            className="voice-btn"
            aria-pressed={muted}
            disabled={phase === 'connecting'}
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
          <span className="voice-btn-label">{phase === 'ended' ? 'Close' : 'Hang up'}</span>
        </button>
      </div>
    </section>
  );
}
