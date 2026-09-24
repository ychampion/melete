/**
 * Every chat, most recently active first, a page at a time. The sidebar shows
 * the recent ones; this is where "All chats" goes.
 */
import { useCallback, useEffect, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { Button } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { agentById, faceOf, lookOf, useApp, useNow } from '../experience/hooks.ts';
import type { Conversation } from '../experience/types.ts';
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

function when(iso: string, now: number): string {
  const date = new Date(iso);
  if (date.toDateString() === new Date(now).toDateString())
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ChatsScreen() {
  const { agents } = useApp();
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
          <div className="row" style={{ gap: 8 }}>
            <Button icon="compose" onClick={() => navigate('/chat/new')}>
              New chat
            </Button>
            <RailToggle />
          </div>
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
          {chats.map((chat, index) => {
            const agent = agentById(agents, chat.agent_id);
            return (
              <a
                key={chat.id}
                className="list-row"
                href={href(`/chat/${chat.id}`)}
                style={index === 0 ? { borderTop: 0 } : undefined}
              >
                {agent ? (
                  <AgentFace look={lookOf(agent)} size={28} state={faceOf(chat.status)} />
                ) : (
                  <MeleteAvatar size={28} />
                )}
                <span className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span
                    className="clamp1"
                    style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                  >
                    {chat.title}
                  </span>
                  <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                    {agent?.name ?? 'Melete'} · {STATUS_WORDS[chat.status]}
                  </span>
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {when(chat.updated_at, now)}
                </span>
                <span style={{ color: 'var(--secondary)', display: 'flex' }}>
                  <Icon name="chevronRight" size={16} />
                </span>
              </a>
            );
          })}
          {!loading && chats.length === 0 && !error ? (
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
    </Shell>
  );
}
