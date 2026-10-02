/**
 * One thin row: the text and a single state button. The button is Send when
 * it is the person's turn, Stop while an agent works or an answer streams,
 * and Resume after a pause. Stopping keeps what the turn already did. The state comes from the conversation
 * itself, never guessed here. Attachments have no contract yet, so nothing
 * offers them.
 *
 * When the installation transcribes speech, a microphone sits beside the
 * state button: tap to record, tap again to stop, and the words land in the
 * box for the person to read and send. Nothing is sent by voice alone.
 */
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { Icon } from '../design/icons.tsx';
import { IconButton } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import type { ComposerState } from '../experience/types.ts';
import { openFeedback } from '../feedback/FeedbackPanel.tsx';
import { models } from '../models/api.ts';
import { href } from '../router.ts';
import { elapsed, useNowTick, useRecorder, type VoicePlace } from './voice.ts';
import './composer.css';

/**
 * Said above the box while no model is connected, since nothing sent could be
 * answered: why, and the one step that fixes it.
 */
export function ModelMissing({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="composer-missing" role="status">
      <Icon name="info" size={15} />
      <span className="grow">
        {canEdit
          ? 'Melete needs a model to answer. Connect one and you can start.'
          : 'Melete needs a model to answer. The person who runs this server can connect one.'}
      </span>
      {canEdit ? (
        <a className="composer-missing-link" href={href('/settings/models')}>
          Connect a model
          <Icon name="chevronRight" size={13} />
        </a>
      ) : null}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  onPause,
  onResume,
  onStop,
  state = 'send',
  agentName = 'Melete',
  placeholder = `Message ${agentName}`,
  disabled = false,
  autoFocus = false,
  working = false,
  voice,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  state?: ComposerState;
  /** Who answers here: Melete unless the chat or the turn under way has another agent. */
  agentName?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The rim travels while an agent works on the task. */
  working?: boolean;
  /**
   * Present when push-to-talk is available: the longest clip the service takes,
   * where the words will be used, and why voice is off there, if it is.
   */
  voice?: { maxSeconds: number; place: VoicePlace; off: string | null };
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the box resizes on every keystroke
  useEffect(() => {
    const node = textRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 168)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) textRef.current?.focus();
  }, [autoFocus]);

  // Read on each mount, so a model connected in Settings counts at once on return.
  const model = useLoad(() => models.settings(), []);
  const noModel = model.data !== null && !model.data.active.connected;
  const canSend = value.trim().length > 0 && !noModel;
  const latest = useRef(value);
  latest.current = value;
  const recorder = useRecorder({
    maxSeconds: voice?.maxSeconds ?? 120,
    ...(voice ? { place: voice.place, off: voice.off } : {}),
    onText: (heard) => {
      const current = latest.current;
      onChange(current.trim() ? `${current.replace(/\s+$/, '')} ${heard}` : heard);
      textRef.current?.focus();
    },
  });
  const recording = recorder.state === 'recording';
  const now = useNowTick(recording);

  // `/feedback`, with or without words after it, opens a problem report instead of sending.
  const send = () => {
    const command = /^\/feedback(?:\s+([\s\S]*))?$/i.exec(value.trim());
    if (command) {
      onChange('');
      openFeedback(command[1]?.trim() ?? '');
      return;
    }
    onSend();
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (state === 'send' && canSend) send();
    }
  };

  // Pausing mid-step is not something the assistant can do, so a working turn offers Stop.
  const stateButton =
    state === 'pause' || state === 'stop' ? (
      <button
        type="button"
        className="state-btn"
        aria-label="Stop"
        title="Stop"
        onClick={onStop ?? onPause}
      >
        <span style={{ width: 12, height: 12, borderRadius: 2, background: 'currentColor' }} />
      </button>
    ) : state === 'resume' ? (
      <button
        type="button"
        className="state-btn"
        data-variant="resume"
        aria-label="Resume"
        title="Resume"
        onClick={onResume}
      >
        <Icon name="play" size={14} stroke={2.5} />
      </button>
    ) : (
      <IconButton
        name="arrowUp"
        label="Send"
        variant={canSend ? 'primary' : 'mutedFill'}
        disabled={!canSend}
        title={noModel ? 'Connect a model to send' : undefined}
        onClick={send}
      />
    );

  return (
    <div className="composer" data-disabled={disabled ? 'true' : undefined}>
      {noModel && model.data ? <ModelMissing canEdit={model.data.can_edit} /> : null}
      <div className="composer-card">
        {working ? <div className="rim" aria-hidden="true" /> : null}
        <div className="composer-row" style={{ paddingLeft: 6 }}>
          <textarea
            ref={textRef}
            rows={1}
            value={value}
            placeholder={working && state !== 'send' ? `${agentName} is working…` : placeholder}
            disabled={disabled}
            aria-label={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKey}
          />
          {voice ? (
            <button
              type="button"
              className="mic-btn"
              data-state={recorder.state}
              aria-label={
                recording
                  ? 'Stop recording'
                  : recorder.state === 'transcribing'
                    ? 'Transcribing your voice message'
                    : 'Record a voice message'
              }
              aria-pressed={recording}
              title={recording ? 'Stop recording' : (voice.off ?? 'Record a voice message')}
              data-off={voice.off ? 'true' : undefined}
              disabled={disabled}
              // Busy rather than disabled: a disabled button drops keyboard focus mid-press.
              aria-disabled={recorder.state === 'starting' || recorder.state === 'transcribing'}
              onClick={recorder.toggle}
            >
              {recording ? (
                <>
                  <span className="mic-dot" aria-hidden="true" />
                  <span className="mic-time">{elapsed(now - recorder.startedAt)}</span>
                </>
              ) : recorder.state === 'transcribing' ? (
                <Icon name="loader" size={16} className="spin" />
              ) : (
                <Icon name="mic" size={16} />
              )}
            </button>
          ) : null}
          {stateButton}
        </div>
      </div>
      {voice ? (
        <div className="composer-note" role="status" aria-live="polite">
          {recording
            ? `Recording. Tap stop when you are done; it stops by itself at ${voice.maxSeconds / 60} minutes.`
            : recorder.state === 'transcribing'
              ? 'Turning your voice message into text…'
              : (recorder.problem ?? '')}
        </div>
      ) : null}
    </div>
  );
}
