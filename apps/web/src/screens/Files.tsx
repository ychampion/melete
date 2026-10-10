/**
 * Everything Melete holds for the person: what it saved into their Files,
 * what it made in their chats, and what they sent it. Each opens here, the way
 * a file card in chat opens, downloads, and (except a file sent in chat, which
 * goes with its chat) deletes into the trash with a moment to undo.
 */
import { attachmentSize } from '@melete/contracts/attachments';
import { useEffect, useState } from 'react';
import { SavedFileShown } from '../chat/parts.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { LoadError } from '../design/LoadError.tsx';
import { Button, Dialog, IconButton, Segmented, Skeleton } from '../design/primitives.tsx';
import { adapter, type SavedFilePreview } from '../experience/adapter.ts';
import { useLoad, useNow } from '../experience/hooks.ts';
import type { PersonFile } from '../experience/types.ts';
import { href } from '../router.ts';
import { RailToggle, Shell, toast } from '../shell/Shell.tsx';
import './files.css';

type Filter = 'all' | PersonFile['place'];

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'files', label: 'Saved' },
  { value: 'chat', label: 'From chats' },
  { value: 'sent', label: 'You sent' },
];

/** The types the app shows in place, as the service sends them; anything else downloads. */
const SHOWN = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

export const opensHere = (file: Pick<PersonFile, 'mime'>): boolean =>
  SHOWN.has(file.mime.split(';')[0]?.trim().toLowerCase() ?? '');

/** A picture of what kind of file it is. */
export function iconFor(file: Pick<PersonFile, 'mime'>): IconName {
  if (file.mime.startsWith('image/')) return 'image';
  if (file.mime.startsWith('audio/')) return 'volume';
  return 'paperclip';
}

/** Where a file is, in words: the line under its name. */
export function whereLine(file: PersonFile, now: number): string {
  const folder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : null;
  const place =
    file.place === 'files'
      ? folder
        ? `In your Files › ${folder}`
        : 'In your Files'
      : file.place === 'chat'
        ? 'Made in a chat'
        : 'You sent it';
  return [place, attachmentSize(file.size), when(file.saved_at, now)].join(' · ');
}

function when(iso: string, now: number): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date(now).toDateString())
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** Opens a file here: a PDF, a picture or text, read from the service. */
function Preview({ file, onClose }: { file: PersonFile; onClose: () => void }) {
  const [shown, setShown] = useState<SavedFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = adapter.fileUrl(file.id);
  useEffect(() => {
    let live = true;
    let made: SavedFilePreview | null = null;
    void adapter.filePreview(file.id).then((result) => {
      if (!live) {
        if (result.data && result.data.kind !== 'text') URL.revokeObjectURL(result.data.url);
        return;
      }
      made = result.data;
      if (result.data) setShown(result.data);
      else setError(result.error ?? result.unavailable ?? 'Couldn’t open this file.');
    });
    // A picture or PDF is held at a local address while it is shown, and let go after.
    return () => {
      live = false;
      if (made && made.kind !== 'text') URL.revokeObjectURL(made.url);
    };
  }, [file.id]);
  return (
    <Dialog
      open
      onClose={onClose}
      title={file.name}
      width={720}
      sub={file.chat ? `From ${file.chat.title}` : undefined}
      footer={
        <>
          {file.chat ? (
            <a className="btn btn-md btn-ghost" href={href(`/chat/${file.chat.id}`)}>
              Open the chat
            </a>
          ) : null}
          <a className="btn btn-md btn-outline" href={link} download={file.name}>
            Download
          </a>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="permission-why">
          {error}
        </p>
      ) : shown === null ? (
        <p className="permission-why">Opening…</p>
      ) : (
        <SavedFileShown shown={shown} name={file.name} href={link} />
      )}
    </Dialog>
  );
}

export function FileRow({
  file,
  now,
  onOpen,
  onDelete,
}: {
  file: PersonFile;
  now: number;
  onOpen: (file: PersonFile) => void;
  onDelete: (file: PersonFile) => void;
}) {
  const link = adapter.fileUrl(file.id);
  const name = (
    <>
      <span className="files-tile" aria-hidden="true">
        <Icon name={iconFor(file)} size={16} />
      </span>
      <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
        <span className="files-name clamp1">{file.name}</span>
        <span className="files-where clamp1">{whereLine(file, now)}</span>
      </span>
    </>
  );
  return (
    <li className="list-row files-row">
      {opensHere(file) ? (
        <button
          type="button"
          className="files-open"
          onClick={() => onOpen(file)}
          aria-label={`Open ${file.name}`}
        >
          {name}
        </button>
      ) : (
        <a className="files-open" href={link} download={file.name}>
          {name}
        </a>
      )}
      {file.chat ? (
        <a className="files-chat clamp1" href={href(`/chat/${file.chat.id}`)}>
          {file.chat.title}
        </a>
      ) : null}
      <span className="files-actions">
        <a
          className="icon-btn icon-ghost"
          style={{ width: 32, height: 32 }}
          href={link}
          download={file.name}
          aria-label={`Download ${file.name}`}
          title="Download"
        >
          <Icon name="download" size={16} />
        </a>
        {file.deletable ? (
          <IconButton name="trash" label={`Delete ${file.name}`} onClick={() => onDelete(file)} />
        ) : null}
      </span>
    </li>
  );
}

export function FilesScreen() {
  const loaded = useLoad(() => adapter.files(), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [opened, setOpened] = useState<PersonFile | null>(null);
  const [deleting, setDeleting] = useState<PersonFile | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(true, 60_000);
  const files = loaded.data?.files ?? [];
  const shown = filter === 'all' ? files : files.filter((file) => file.place === filter);

  const remove = async (file: PersonFile) => {
    setBusy(true);
    const result = await adapter.deleteFile(file.id);
    setBusy(false);
    setDeleting(null);
    if (result.data === null) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t delete it' });
      loaded.reload();
      return;
    }
    const trash = result.data.trash_id;
    loaded.set({ files: files.filter((item) => item.id !== file.id) });
    toast({
      kind: 'ok',
      title: `Deleted ${file.name}`,
      sub: `It’s in the trash until ${new Date(result.data.restorable_until).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`,
      action: 'Undo',
      onAction: () =>
        void adapter.restoreFile(file.id, trash).then((restored) => {
          if (restored.data === null) {
            toast({
              kind: 'err',
              title: restored.error ?? restored.unavailable ?? 'Couldn’t put it back',
            });
            return;
          }
          toast({ kind: 'ok', title: `${file.name} is back` });
          loaded.reload();
        }),
    });
  };

  return (
    <Shell title="Files">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Files</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              What Melete saved for you, what it made in your chats, and what you sent it.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <RailToggle />
          </div>
        </div>
        {files.length > 0 ? (
          <div className="files-filter">
            <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />
          </div>
        ) : null}
        {loaded.error ? (
          <LoadError what="your files" error={loaded.error} onRetry={loaded.reload} />
        ) : null}
        {loaded.loading && !loaded.data ? (
          <div className="card-12" aria-busy="true">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="list-row files-row"
                style={row ? undefined : { borderTop: 0 }}
              >
                <span className="files-tile" />
                <span className="col grow" style={{ gap: 6 }}>
                  <Skeleton width="45%" height={14} />
                  <Skeleton width="30%" height={12} />
                </span>
              </div>
            ))}
          </div>
        ) : loaded.data && files.length === 0 ? (
          <div className="card-12 files-empty">
            <span className="files-empty-icon" aria-hidden="true">
              <Icon name="files" size={22} />
            </span>
            <span className="files-empty-title">No files yet</span>
            <span className="files-empty-sub">
              When Melete saves something for you, or you send it a file in chat, it shows up here.
            </span>
          </div>
        ) : loaded.data ? (
          <div className="card-12" style={{ overflow: 'hidden' }}>
            {shown.length ? (
              <ul className="files-list">
                {shown.map((file) => (
                  <FileRow
                    key={file.id}
                    file={file}
                    now={now}
                    onOpen={setOpened}
                    onDelete={setDeleting}
                  />
                ))}
              </ul>
            ) : (
              <div className="files-none">Nothing here.</div>
            )}
          </div>
        ) : null}
      </div>
      {opened ? <Preview file={opened} onClose={() => setOpened(null)} /> : null}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : 'Delete this file?'}
        tone="danger"
        icon="trash"
        sub="It goes to the trash, and you can undo this straight after."
        footer={
          <>
            <Button variant="outline" disabled={busy} onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy}
              disabled={busy}
              onClick={() => deleting && void remove(deleting)}
            >
              Delete
            </Button>
          </>
        }
      />
    </Shell>
  );
}
