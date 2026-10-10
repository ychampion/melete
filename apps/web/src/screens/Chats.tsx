/**
 * Every chat, most recently active first, a page at a time. The sidebar shows
 * the recent ones; this is where "All chats" goes, and where chats are tidied
 * up: Select picks several to delete at once, or one to rename.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeleteChatsDialog, RenameChatDialog } from '../chat/ChatActions.tsx';
import { Icon } from '../design/icons.tsx';
import { Button, Checkbox } from '../design/primitives.tsx';
import { AgentAvatar } from '../experience/AgentAvatar.tsx';
import { adapter } from '../experience/adapter.ts';
import { agentById, faceOf, useApp, useDecisions, useNow } from '../experience/hooks.ts';
import type { Conversation } from '../experience/types.ts';
import { isWaiting, waitingOn } from '../experience/waiting.ts';
import { href, navigate } from '../router.ts';
import { RailToggle, Shell } from '../shell/Shell.tsx';

const PAGE = 30;

const STATUS_WORDS: Record<Conversation['status'], string> = {
  idle: 'Ready',
  queued: 'Starting',
  working: 'Working',
  streaming: 'Answering',
  needs_you: 'Waiting for you',
  paused: 'Paused',
  done: 'Done',
  failed: 'Stopped without finishing',
  stopped: 'Stopped',
};

/** A chat's state in words; one held up by an open decision waits for the person. */
export function statusWord(chat: Conversation, waiting: ReadonlySet<string>): string {
  return STATUS_WORDS[isWaiting(chat, waiting) ? 'needs_you' : chat.status];
}

function when(iso: string, now: number): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date(now).toDateString())
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The pages read here, kept current by the list the sidebar reads again every
 * few seconds: a chat that changed shows its new state and title, and one
 * started meanwhile comes in at the top, so this list and the sidebar agree.
 * A newer chat is added only where it belongs among what has been read.
 */
export function withFresh(
  paged: readonly Conversation[],
  fresh: readonly Conversation[],
  complete: boolean,
): Conversation[] {
  if (fresh.length === 0) return [...paged];
  const byId = new Map(fresh.map((chat) => [chat.id, chat]));
  const known = new Set(paged.map((chat) => chat.id));
  const oldest = paged.at(-1)?.updated_at;
  const added = fresh.filter(
    (chat) =>
      !known.has(chat.id) && (complete || oldest === undefined || chat.updated_at >= oldest),
  );
  return [...added, ...paged.map((chat) => byId.get(chat.id) ?? chat)].sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at),
  );
}

export function ChatsScreen() {
  const { agents, conversations, refreshConversations } = useApp();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null);
  const waiting = waitingOn(useDecisions());
  const now = useNow(true, 60_000);
  const [chats, setChats] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback((after: string | null) => {
    setLoading(true);
    void adapter.conversationsPage(PAGE, after).then((result) => {
      setLoading(false);
      if (result.data === null) {
        setError(result.error ?? result.unavailable);
        return;
      }
      const page = result.data;
      setError(null);
      // Pages neither skip nor repeat a chat; the id guard keeps a retry from doubling one.
      setChats((previous) => [
        ...previous,
        ...page.conversations.filter((chat) => !previous.some((known) => known.id === chat.id)),
      ]);
      setCursor(page.next_cursor);
    });
  }, []);

  useEffect(() => read(null), [read]);

  // Deleted here: kept out until the sidebar's list has caught up.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(
    () =>
      withFresh(
        chats,
        conversations.filter((chat) => !gone.has(chat.id)),
        cursor === null && !loading,
      ),
    [chats, conversations, gone, cursor, loading],
  );
  const chosen = shown.filter((chat) => picked.has(chat.id));
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  const toggle = (id: string, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Shell title="Chats">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 4 }}>
            <h1>Chats</h1>
            <p style={{ fontSize: 14, color: 'var(--muted)' }}>
              Every conversation, the most recent first.
            </p>
          </div>
          {selecting ? (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <span aria-live="polite" style={{ fontSize: 13, color: 'var(--muted)' }}>
                {picked.size} selected
              </span>
              <Button
                variant="outline"
                icon="pencil"
                disabled={chosen.length !== 1}
                onClick={() => setDialog('rename')}
              >
                Rename
              </Button>
              <Button
                variant="destructive"
                icon="trash"
                disabled={chosen.length === 0}
                onClick={() => setDialog('delete')}
              >
                Delete
              </Button>
              <Button variant="ghost" onClick={stopSelecting}>
                Done
              </Button>
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              {shown.length > 0 ? (
                <Button variant="outline" icon="check" onClick={() => setSelecting(true)}>
                  Select
                </Button>
              ) : null}
              <Button icon="compose" onClick={() => navigate('/chat/new')}>
                New chat
              </Button>
              <RailToggle />
            </div>
          )}
        </div>
        {error ? (
          <div className="row" style={{ gap: 12, fontSize: 13, color: 'var(--secondary)' }}>
            <span>Couldn’t read your chats. {error}</span>
            <Button size="sm" variant="outline" onClick={() => read(cursor)}>
              Try again
            </Button>
          </div>
        ) : null}
        <div className="card-12" style={{ overflow: 'hidden' }}>
          {shown.map((chat, index) => {
            const agent = agentById(agents, chat.agent_id);
            const body = (
              <>
                <AgentAvatar
                  agent={agent}
                  size={28}
                  state={faceOf(isWaiting(chat, waiting) ? 'needs_you' : chat.status)}
                />
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span
                    className="clamp1"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                  >
                    {chat.title}
                  </span>
                  <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {agent?.name ?? 'Melete'} · {statusWord(chat, waiting)}
                  </span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {when(chat.updated_at, now)}
                </span>
              </>
            );
            const first = index === 0 ? { borderTop: 0 } : undefined;
            return selecting ? (
              // biome-ignore lint/a11y/noLabelWithoutControl: the checkbox inside is the control
              <label
                key={chat.id}
                className="list-row"
                data-picked={picked.has(chat.id) ? 'true' : undefined}
                style={{ ...first, cursor: 'pointer' }}
              >
                <Checkbox
                  checked={picked.has(chat.id)}
                  onChange={(on) => toggle(chat.id, on)}
                  label={`Select ${chat.title}`}
                />
                {body}
              </label>
            ) : (
              <a key={chat.id} className="list-row" href={href(`/chat/${chat.id}`)} style={first}>
                {body}
                <span style={{ color: 'var(--secondary)', display: 'flex' }}>
                  <Icon name="chevronRight" size={16} />
                </span>
              </a>
            );
          })}
          {!loading && shown.length === 0 && !error ? (
            <div style={{ padding: '28px 16px', fontSize: 14, color: 'var(--muted)' }}>
              Your first conversation lands here.
            </div>
          ) : null}
        </div>
        {cursor ? (
          <div>
            <Button
              variant="outline"
              loading={loading}
              disabled={loading}
              onClick={() => read(cursor)}
            >
              Show more
            </Button>
          </div>
        ) : null}
      </div>
      {dialog === 'rename' && chosen[0] ? (
        <RenameChatDialog
          chat={chosen[0]}
          open
          onClose={() => setDialog(null)}
          onRenamed={(renamed) => {
            setChats((previous) =>
              previous.map((chat) => (chat.id === renamed.id ? renamed : chat)),
            );
            refreshConversations();
          }}
        />
      ) : null}
      <DeleteChatsDialog
        chats={chosen}
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        onDeleted={(ids) => {
          setChats((previous) => previous.filter((chat) => !ids.includes(chat.id)));
          setGone((previous) => new Set([...previous, ...ids]));
          // Any that couldn't be deleted stay picked, ready to try again.
          setPicked((previous) => new Set([...previous].filter((id) => !ids.includes(id))));
          refreshConversations();
        }}
      />
    </Shell>
  );
}
