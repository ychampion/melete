/**
 * One thin row: the text and a single state button. The button is Send when
 * it is the person's turn, Pause while an agent works, Resume after a pause,
 * and Stop while an answer streams. The state comes from the conversation
 * itself, never guessed here. Attachments and voice have no contract yet, so
 * nothing offers them.
 */
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { Icon } from '../design/icons.tsx';
import { IconButton } from '../design/primitives.tsx';
import type { ComposerState } from '../experience/types.ts';

export function Composer({
  value,
  onChange,
  onSend,
  onPause,
  onResume,
  onStop,
  state = 'send',
  placeholder = 'Message Melete',
  disabled = false,
  autoFocus = false,
  working = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: () => void;
  state?: ComposerState;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** The rim travels while an agent works on the task. */
  working?: boolean;
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

  const canSend = value.trim().length > 0;

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (state === 'send' && canSend) onSend();
    }
  };

  const stateButton =
    state === 'pause' ? (
      <button
        type="button"
        className="state-btn"
        aria-label="Pause"
        title="Pause"
        onClick={onPause}
      >
        <span style={{ display: 'flex', gap: 3 }}>
          <span style={{ width: 3, height: 12, borderRadius: 1.5, background: 'currentColor' }} />
          <span style={{ width: 3, height: 12, borderRadius: 1.5, background: 'currentColor' }} />
        </span>
      </button>
    ) : state === 'stop' ? (
      <button type="button" className="state-btn" aria-label="Stop" title="Stop" onClick={onStop}>
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
        onClick={onSend}
      />
    );

  return (
    <div className="composer" data-disabled={disabled ? 'true' : undefined}>
      <div className="composer-card">
        {working ? <div className="rim" aria-hidden="true" /> : null}
        <div className="composer-row" style={{ paddingLeft: 6 }}>
          <textarea
            ref={textRef}
            rows={1}
            value={value}
            placeholder={working && state !== 'send' ? 'Melete is working…' : placeholder}
            disabled={disabled}
            aria-label={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKey}
          />
          {stateButton}
        </div>
      </div>
    </div>
  );
}
