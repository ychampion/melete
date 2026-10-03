/**
 * One thin row: the text and a single state button. The button is Send when
 * it is the person's turn, Stop while an agent works or an answer streams,
 * and Resume after a pause. Stopping keeps what the turn already did. The state comes from the conversation
 * itself, never guessed here.
 *
 * Where the box is given `attachments`, files come in three ways: the
 * paperclip, a drop on the box, or a paste. Each shows as a tile above the
 * words (a thumbnail for a picture, a name for a document) while it uploads,
 * and a file Melete cannot take is refused with a sentence saying why.
 *
 * When the installation transcribes speech, a microphone sits beside the
 * state button: tap to record, tap again to stop, and the words land in the
 * box for the person to read and send. Nothing is sent by voice alone.
 */
import { ATTACHMENT_ACCEPT, attachmentSize } from '@melete/contracts/attachments';
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Icon } from '../design/icons.tsx';
import { IconButton } from '../design/primitives.tsx';
import { useLoad } from '../experience/hooks.ts';
import type { ComposerState } from '../experience/types.ts';
import { openFeedback } from '../feedback/FeedbackPanel.tsx';
import { models } from '../models/api.ts';
import { href } from '../router.ts';
import { type AttachmentsControl, attachmentUrl, type PendingFile } from './attachments.ts';
import { elapsed, useNowTick, useRecorder, type VoicePlace } from './voice.ts';
import './composer.css';
import './message-files.css';

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
  attachments,
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
  /** The files in the box, where files can be sent. */
  attachments?: AttachmentsControl;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [dropping, setDropping] = useState(false);

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
  const files = attachments?.files ?? [];
  const waiting = files.some((file) => file.state !== 'ready');
  const canSend =
    (value.trim().length > 0 || (attachments?.ready.length ?? 0) > 0) && !waiting && !noModel;
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

  // Only a drag that carries files is a drop for the box; dragged text is left alone.
  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!attachments || disabled || !carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropping(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropping(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!attachments || disabled || !carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    attachments.add([...event.dataTransfer.files]);
    textRef.current?.focus();
  };
  // A pasted picture (a screenshot, say) is attached; pasted text stays text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachments) return;
    const pasted = [...event.clipboardData.files];
    if (!pasted.length || event.clipboardData.types.includes('text/plain')) return;
    event.preventDefault();
    attachments.add(pasted);
  };
  const note = attachments?.problem
    ? attachments.problem
    : files.some((file) => file.state === 'failed')
      ? 'A file didn’t upload. Remove it to send, or attach it again.'
      : null;

  return (
    <div className="composer" data-disabled={disabled ? 'true' : undefined}>
      {noModel && model.data ? <ModelMissing canEdit={model.data.can_edit} /> : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target only; the paperclip is the keyboard way in */}
      <div
        className="composer-card"
        data-dropping={dropping ? 'true' : undefined}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {working ? <div className="rim" aria-hidden="true" /> : null}
        {files.length ? (
          <ul className="composer-tiles" aria-label="Files to send">
            {files.map((file) => (
              <FileTile key={file.key} file={file} onRemove={() => attachments?.remove(file.key)} />
            ))}
          </ul>
        ) : null}
        {dropping ? (
          <div className="composer-drop" aria-hidden="true">
            <Icon name="paperclip" size={16} />
            Drop to attach
          </div>
        ) : null}
        <div className="composer-row" style={{ paddingLeft: attachments ? 0 : 6 }}>
          {attachments ? (
            <>
              <IconButton
                name="paperclip"
                label="Attach files"
                className="attach-btn"
                disabled={disabled}
                onClick={() => pickRef.current?.click()}
              />
              <input
                ref={pickRef}
                type="file"
                multiple
                accept={ATTACHMENT_ACCEPT}
                hidden
                tabIndex={-1}
                aria-hidden="true"
                data-testid="attach-input"
                onChange={(event) => {
                  attachments.add([...(event.target.files ?? [])]);
                  event.target.value = '';
                  textRef.current?.focus();
                }}
              />
            </>
          ) : null}
          <textarea
            ref={textRef}
            rows={1}
            value={value}
            placeholder={working && state !== 'send' ? `${agentName} is working…` : placeholder}
            disabled={disabled}
            aria-label={placeholder}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={onKey}
            onPaste={onPaste}
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
      {note ? (
        <div className="composer-note composer-problem" role="alert">
          {note}
        </div>
      ) : null}
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

/** One file in the box: a thumbnail or a name, its state, and a way to take it out. */
function FileTile({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const picture =
    file.kind === 'image'
      ? (file.thumb ?? (file.view?.has_preview ? attachmentUrl(file.view.id, true) : null))
      : null;
  const state =
    file.state === 'uploading'
      ? 'Uploading'
      : file.state === 'failed'
        ? (file.error ?? 'Didn’t upload')
        : attachmentSize(file.size);
  return (
    <li
      className="attach-tile"
      data-doc={picture ? undefined : 'true'}
      data-state={file.state}
      title={`${file.name} · ${state}`}
    >
      {picture ? (
        <img src={picture} alt={file.name} />
      ) : (
        <>
          <Icon name={file.state === 'failed' ? 'alert' : 'fileText'} size={16} />
          <span className="attach-name">
            <span className="attach-title">{file.name}</span>
            <span className="attach-meta">{state}</span>
          </span>
        </>
      )}
      {file.state === 'uploading' ? (
        <span className="attach-busy" role="status" aria-label={`Uploading ${file.name}`}>
          <Icon name="loader" size={14} className="spin" />
        </span>
      ) : file.state === 'failed' && picture ? (
        <span className="attach-busy" data-failed="true" role="img" aria-label={state}>
          <Icon name="alert" size={14} />
        </span>
      ) : null}
      <button
        type="button"
        className="attach-x"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
      >
        <span>
          <Icon name="x" size={10} stroke={3} />
        </span>
      </button>
    </li>
  );
}
