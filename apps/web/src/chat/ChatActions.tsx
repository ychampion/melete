/**
 * Tidying up chats: rename one, or delete one or several. A delete says
 * plainly what happens before it happens: work under way stops, anything
 * waiting for the person's OK is withdrawn, the messages go, files on the
 * computer stay, and what Melete learned stays unless they choose to have it
 * forgotten too.
 */
import { type FormEvent, useState } from 'react';
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  Input,
  Menu,
  MenuItem,
  Popover,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import type { Conversation } from '../experience/types.ts';
import { toast } from '../shell/Shell.tsx';

const BUSY: ReadonlySet<Conversation['status']> = new Set([
  'queued',
  'working',
  'streaming',
  'stalled',
  'needs_you',
  'paused',
]);

/** Rename a chat. Undo puts the old name back. */
export function RenameChatDialog({
  chat,
  open,
  onClose,
  onRenamed,
}: {
  chat: Conversation;
  open: boolean;
  onClose: () => void;
  onRenamed: (chat: Conversation) => void;
}) {
  const [title, setTitle] = useState(chat.title);
  const [saving, setSaving] = useState(false);
  const clean = title.trim();
  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!clean || saving) return;
    if (clean === chat.title) {
      onClose();
      return;
    }
    setSaving(true);
    const result = await adapter.rename(chat.id, clean);
    setSaving(false);
    if (result.data === null) {
      toast({ kind: 'err', title: 'Couldn’t rename', sub: result.error ?? result.unavailable });
      return;
    }
    const before = chat.title;
    onRenamed(result.data.conversation);
    onClose();
    toast({
      kind: 'ok',
      title: 'Renamed',
      sub: clean,
      action: 'Undo',
      onAction: () =>
        void adapter.rename(chat.id, before).then((undone) => {
          if (undone.data) onRenamed(undone.data.conversation);
          else toast({ kind: 'err', title: 'Couldn’t undo the rename' });
        }),
    });
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename chat"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} disabled={!clean || saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={(event) => void save(event)}>
        <Input
          aria-label="Chat name"
          value={title}
          maxLength={200}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setTitle(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

type Failure = { chat: Conversation; reason: string };

/**
 * Delete one chat or several. Each is deleted by the service in turn, and one
 * that can't be deleted doesn't stop the rest. Any that stay are named with
 * the reason, and can be tried again from here.
 */
export function DeleteChatsDialog({
  chats,
  open,
  onClose,
  onDeleted,
}: {
  chats: Conversation[];
  open: boolean;
  onClose: () => void;
  /** The ids the service deleted. */
  onDeleted: (ids: string[]) => void;
}) {
  const [forget, setForget] = useState(false);
  const [working, setWorking] = useState(false);
  // Set after a delete where some chats stayed; the dialog then lists them.
  const [failed, setFailed] = useState<Failure[] | null>(null);
  const [tried, setTried] = useState(0);
  const one = chats.length === 1;
  const busy = chats.some((chat) => BUSY.has(chat.status));
  const name = one ? `“${chats[0]?.title ?? 'this chat'}”` : `${chats.length} chats`;
  const close = () => {
    setFailed(null);
    setForget(false);
    onClose();
  };
  const remove = async (list: Conversation[]) => {
    setWorking(true);
    const gone: string[] = [];
    const left: Failure[] = [];
    let forgotten = 0;
    for (const chat of list) {
      const result = await adapter.deleteConversation(chat.id, forget);
      if (result.data === null) {
        left.push({ chat, reason: result.error ?? result.unavailable });
        continue;
      }
      gone.push(chat.id);
      forgotten += result.data.forgotten;
    }
    setWorking(false);
    if (gone.length) onDeleted(gone);
    if (left.length) {
      setTried(list.length);
      setFailed(left);
      return;
    }
    close();
    toast({
      kind: 'ok',
      title: gone.length === 1 ? 'Chat deleted' : `${gone.length} chats deleted`,
      sub: forget
        ? forgotten
          ? `Melete also forgot ${forgotten === 1 ? 'one thing' : `${forgotten} things`} it learned there.`
          : 'Melete had nothing saved from there to forget.'
        : 'What Melete learned there is still in Memory.',
    });
  };
  if (failed)
    return (
      <Dialog
        open={open}
        onClose={working ? () => {} : close}
        icon="trash"
        tone="danger"
        title={
          failed.length === tried
            ? failed.length === 1
              ? 'Couldn’t delete this chat'
              : `Couldn’t delete ${failed.length} chats`
            : `Deleted ${tried - failed.length} of ${tried}`
        }
        sub={
          failed.length === tried
            ? 'Nothing was deleted. Here is why:'
            : failed.length === 1
              ? 'This one is still here:'
              : `These ${failed.length} are still here:`
        }
        footer={
          <>
            <Button variant="outline" disabled={working} onClick={close}>
              Close
            </Button>
            <Button
              loading={working}
              disabled={working}
              onClick={() => void remove(failed.map((entry) => entry.chat))}
            >
              Try again
            </Button>
          </>
        }
      >
        <ul className="col" style={{ gap: 8, margin: 0, padding: 0 }}>
          {failed.map(({ chat, reason }) => (
            <li key={chat.id} className="col" style={{ gap: 2, listStyle: 'none' }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
                {chat.title || 'Untitled chat'}
              </span>
              <span style={{ fontSize: 13, color: 'var(--muted)' }}>{reason}</span>
            </li>
          ))}
        </ul>
      </Dialog>
    );
  return (
    <Dialog
      open={open}
      onClose={working ? () => {} : close}
      icon="trash"
      tone="danger"
      title={one ? 'Delete this chat?' : `Delete ${chats.length} chats?`}
      sub={
        <>
          {busy
            ? 'Melete stops what it is doing there first, and anything waiting for your OK is withdrawn. '
            : ''}
          The messages in {name} are deleted for good. Files on the computer stay, and anything it
          sent or changed stays listed in Settings, Activity.
        </>
      }
      footer={
        <>
          <Button variant="outline" disabled={working} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={working}
            disabled={working}
            onClick={() => void remove(chats)}
          >
            {one ? 'Delete chat' : `Delete ${chats.length} chats`}
          </Button>
        </>
      }
    >
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control */}
      <label className="row" style={{ gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
        <Checkbox
          checked={forget}
          onChange={setForget}
          label={`Also forget what Melete learned from ${one ? 'this chat' : 'these chats'}`}
        />
        <span className="col" style={{ gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
            Also forget what Melete learned from {one ? 'this chat' : 'these chats'}
          </span>
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>
            {forget
              ? 'Details that came only from here are forgotten too.'
              : 'Left unticked, what Melete learned stays, and you can change it in Memory.'}
          </span>
        </span>
      </label>
    </Dialog>
  );
}

/** The chat's own menu: rename and delete. */
export function ChatActions({
  chat,
  onRenamed,
  onDeleted,
  size = 32,
}: {
  chat: Conversation;
  onRenamed: (chat: Conversation) => void;
  onDeleted: () => void;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  return (
    <div style={{ position: 'relative', display: 'flex' }}>
      <IconButton
        name="more"
        label="Chat options"
        size={size}
        iconSize={size > 32 ? 20 : 16}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      />
      <Popover open={open} onClose={() => setOpen(false)} align="right">
        <Menu label="Chat options" width={196}>
          <MenuItem
            icon="pencil"
            onSelect={() => {
              setOpen(false);
              setDialog('rename');
            }}
          >
            Rename
          </MenuItem>
          <MenuItem
            icon="trash"
            danger
            onSelect={() => {
              setOpen(false);
              setDialog('delete');
            }}
          >
            Delete chat
          </MenuItem>
        </Menu>
      </Popover>
      {dialog === 'rename' ? (
        <RenameChatDialog chat={chat} open onClose={() => setDialog(null)} onRenamed={onRenamed} />
      ) : null}
      <DeleteChatsDialog
        chats={[chat]}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onDeleted={onDeleted}
      />
    </div>
  );
}
