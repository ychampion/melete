/**
 * Writing in a room. A message is for the people in it; "Ask" sends it to the
 * room's agent as well, by naming the agent the way the service reads a
 * mention. Enter sends, Shift+Enter starts a new line.
 */
import { useId, useRef, useState } from 'react';
import { Button } from '../design/primitives.tsx';
import { messageKey } from '../experience/hooks.ts';
import { type HeldSend, mentionFor, namesAgent, sendKey } from './reduce.ts';

export function RoomComposer({
  agentName,
  placeholder,
  onSend,
  autoFocus = false,
}: {
  agentName: string;
  placeholder: string;
  /**
   * Resolves true once the message is accepted, so the draft can be cleared.
   * `key` stays the same for a retry of the same message, so a send whose
   * answer was lost cannot post it twice.
   */
  onSend: (text: string, ask: boolean, key: string) => Promise<boolean>;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<HeldSend | null>(null);
  const hintId = useId();
  const asks = namesAgent(text, agentName);

  const send = async (ask: boolean) => {
    const body = text.trim();
    if (!body || busy) return;
    const asking = ask || asks;
    // The same message, sent again after a failure, keeps its key.
    const held = pending.current;
    const key = sendKey(held, body, asking, messageKey);
    pending.current = { text: body, ask: asking, key };
    setBusy(true);
    const ok = await onSend(body, asking, key);
    setBusy(false);
    if (ok) {
      pending.current = null;
      setText('');
    }
    field.current?.focus();
  };

  return (
    <form
      className="room-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void send(false);
      }}
    >
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
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void send(false);
          }
        }}
      />
      <div className="room-composer-foot">
        <span id={hintId} className="room-composer-hint">
          {asks
            ? `This asks ${agentName}.`
            : `Everyone in the room sees this. Write ${mentionFor(agentName)} or press Ask to bring in ${agentName}.`}
        </span>
        <div className="row" style={{ gap: 8 }}>
          <Button
            type="submit"
            variant={asks ? 'primary' : 'outline'}
            size="sm"
            disabled={!text.trim() || busy}
            loading={busy}
          >
            Send
          </Button>
          {asks ? null : (
            <Button
              size="sm"
              icon="sparkles"
              disabled={!text.trim() || busy}
              onClick={() => void send(true)}
            >
              Ask {agentName}
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
