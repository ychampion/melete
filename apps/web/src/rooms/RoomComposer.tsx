/**
 * Writing in a room. A message is for the people in it; "Ask" sends it to the
 * room's agent as well, by naming the agent the way the service reads a
 * mention. Enter sends, Shift+Enter starts a new line. Files go with the
 * message, through the paperclip or pasted: everyone in the room sees them,
 * and an ask hands them to the agent.
 */
import { ATTACHMENT_ACCEPT } from '@melete/contracts/attachments';
import { type ClipboardEvent, useId, useRef, useState } from 'react';
import { fileNote, useAttachments } from '../chat/attachments.ts';
import { FileTile } from '../chat/Composer.tsx';
import { Button, IconButton } from '../design/primitives.tsx';
import { messageKey } from '../experience/hooks.ts';
import { type HeldSend, mentionFor, namesAgent, sendKey } from './reduce.ts';
import '../chat/composer.css';

export function RoomComposer({
  roomId,
  agentName,
  placeholder,
  onSend,
  autoFocus = false,
}: {
  roomId: string;
  agentName: string;
  placeholder: string;
  /**
   * Resolves true once the message is accepted, so the draft can be cleared.
   * `key` stays the same for a retry of the same message, so a send whose
   * answer was lost cannot post it twice. `files` are the uploads it carries.
   */
  onSend: (text: string, ask: boolean, key: string, files: readonly string[]) => Promise<boolean>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const pending = useRef<HeldSend | null>(null);
  const hintId = useId();
  const base = `/rooms/${encodeURIComponent(roomId)}`;
  const attachments = useAttachments(base);
  const asks = namesAgent(text, agentName);
  const waiting = attachments.files.some((file) => file.state !== 'ready');
  const ready = text.trim().length > 0 && !waiting && !busy;
  const note = fileNote(attachments.problem, attachments.files);

  const send = async (ask: boolean) => {
    const body = text.trim();
    if (!body || busy || waiting) return;
    const asking = ask || asks;
    const files = attachments.ready.map((file) => file.id);
    // The same message, with the same files, sent again after a failure, keeps its key.
    const held = pending.current;
    const same = `${body}\u0000${files.join(',')}`;
    const key = sendKey(held, same, asking, messageKey);
    pending.current = { text: same, ask: asking, key };
    setBusy(true);
    const ok = await onSend(body, asking, key, files);
    setBusy(false);
    if (ok) {
      pending.current = null;
      setText('');
      attachments.clear();
    }
    field.current?.focus();
  };

  // A pasted picture (a photo of a letter, say) is attached; pasted text stays text.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (!pasted.length) return;
    event.preventDefault();
    attachments.add(pasted);
  };

  return (
    <form
      className="room-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send(false);
      }}
    >
      {attachments.files.length ? (
        <ul className="composer-tiles" aria-label="Files to post">
          {attachments.files.map((file) => (
            <FileTile
              key={file.key}
              file={file}
              base={base}
              onRemove={() => attachments.remove(file.key)}
            />
          ))}
        </ul>
      ) : null}
      <label className="sr-only" htmlFor={`${hintId}-field`}>
        Message
      </label>
      <textarea
        id={`${hintId}-field`}
        ref={field}
        className="room-composer-field"
        value={text}
        rows={2}
        maxLength={20_000}
        placeholder={placeholder}
        aria-describedby={hintId}
        // biome-ignore lint/a11y/noAutofocus: opening a new thread is a request to write in it
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(false);
          }
        }}
      />
      <div className="room-composer-foot">
        <IconButton
          name="paperclip"
          label="Attach a photo or file"
          className="attach-btn"
          disabled={busy}
          onClick={() => pick.current?.click()}
        />
        <input
          ref={pick}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          hidden
          tabIndex={-1}
          aria-hidden="true"
          data-testid="room-attach-input"
          onChange={(event) => {
            attachments.add([...(event.target.files ?? [])]);
            event.target.value = '';
            field.current?.focus();
          }}
        />
        <span id={hintId} className="room-composer-hint" role={note ? 'alert' : undefined}>
          {note
            ? note
            : asks
              ? `This asks ${agentName}.`
              : `Everyone in the room sees this. Write ${mentionFor(agentName)} or press Ask to bring in ${agentName}.`}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <Button
            type="submit"
            variant={asks ? 'primary' : 'outline'}
            size="sm"
            disabled={!ready}
            loading={busy}
          >
            Send
          </Button>
          {asks ? null : (
            <Button size="sm" icon="sparkles" disabled={!ready} onClick={() => void send(true)}>
              Ask {agentName}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
