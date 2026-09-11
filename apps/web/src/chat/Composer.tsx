/**
 * One thin row: attach, text, and a single state button. The button is Send
 * when idle, Pause while an agent works, Resume after a pause, and Stop while
 * an answer streams. Attachments queue as tiles with a progress bar and a
 * cancel that works mid-upload.
 */
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Icon } from '../design/icons.tsx';
import { IconButton, Menu, MenuItem, MenuSep, Popover } from '../design/primitives.tsx';
import { useApp } from '../experience/hooks.ts';

export type ComposerState = 'send' | 'pause' | 'resume' | 'stop';

export type Attachment = {
  id: string;
  name: string;
  kind: 'image' | 'doc';
  progress: number;
  url?: string;
};

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
  attachments = [],
  onAttachmentsChange,
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
  attachments?: Attachment[];
  onAttachmentsChange?: (next: Attachment[] | ((current: Attachment[]) => Attachment[])) => void;
  /** The rim travels while an agent works on the task. */
  working?: boolean;
}) {
  const { capabilities } = useApp();
  const [menu, setMenu] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const canAttach = capabilities.attachments === 'available' && Boolean(onAttachmentsChange);

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

  const canSend = value.trim().length > 0 && attachments.every((a) => a.progress >= 100);

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (state === 'send' && canSend) onSend();
    }
  };

  const addFiles = (files: FileList | null) => {
    if (!files || !onAttachmentsChange) return;
    const next = [...attachments];
    for (const file of Array.from(files)) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const kind: Attachment['kind'] = file.type.startsWith('image/') ? 'image' : 'doc';
      const url = kind === 'image' ? URL.createObjectURL(file) : undefined;
      next.push({ id, name: file.name, kind, progress: 0, url });
      // Upload progress comes from the service; until the upload endpoint
      // exists the tile fills over a second so the cancel path can be tried.
      let progress = 0;
      const timer = setInterval(() => {
        progress = Math.min(100, progress + 12);
        onAttachmentsChange((current) =>
          current.map((a) => (a.id === id ? { ...a, progress } : a)),
        );
        if (progress >= 100) clearInterval(timer);
      }, 90);
    }
    onAttachmentsChange(next);
  };

  const remove = (id: string) => onAttachmentsChange?.(attachments.filter((a) => a.id !== id));

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
        {attachments.length ? (
          <div className="composer-tiles">
            {attachments.map((tile) => (
              <div
                key={tile.id}
                className="attach-tile"
                data-doc={tile.kind === 'doc' ? 'true' : undefined}
              >
                {tile.kind === 'image' && tile.url ? (
                  <img src={tile.url} alt={tile.name} />
                ) : (
                  <>
                    <span
                      style={{
                        color: tile.progress < 100 ? 'var(--primary)' : 'var(--secondary)',
                        display: 'flex',
                      }}
                    >
                      <Icon name="fileText" size={18} stroke={1.6} />
                    </span>
                    <span className="clamp1">{tile.name}</span>
                  </>
                )}
                {tile.progress < 100 ? (
                  <span className="attach-bar" aria-hidden="true">
                    <span style={{ width: `${tile.progress}%` }} />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="attach-x"
                  aria-label={tile.progress < 100 ? `Cancel ${tile.name}` : `Remove ${tile.name}`}
                  onClick={() => remove(tile.id)}
                >
                  <span>
                    <Icon name="x" size={10} stroke={2.5} />
                  </span>
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-row">
          {canAttach ? (
            <div style={{ position: 'relative' }}>
              <IconButton
                name="plus"
                label="Add to your message"
                iconSize={18}
                variant={menu ? 'soft' : 'ghost'}
                onClick={() => setMenu((m) => !m)}
                aria-haspopup="menu"
                aria-expanded={menu}
              />
              <Popover open={menu} onClose={() => setMenu(false)} side="top" offset={8}>
                <Menu label="Add to your message" width={232}>
                  <MenuItem
                    icon="paperclip"
                    onSelect={() => {
                      setMenu(false);
                      fileRef.current?.click();
                    }}
                  >
                    Attach a file
                  </MenuItem>
                  <MenuItem
                    icon="image"
                    onSelect={() => {
                      setMenu(false);
                      fileRef.current?.click();
                    }}
                  >
                    Photo or screenshot
                  </MenuItem>
                  <MenuSep />
                  <MenuItem icon="plans" sub onSelect={() => setMenu(false)}>
                    Reference a plan
                  </MenuItem>
                </Menu>
              </Popover>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(event) => addFiles(event.target.files)}
                aria-label="Attach files"
              />
            </div>
          ) : null}
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
          {capabilities.voice === 'available' ? (
            <IconButton name="mic" label="Speak" iconSize={18} />
          ) : null}
          {stateButton}
        </div>
      </div>
    </div>
  );
}
