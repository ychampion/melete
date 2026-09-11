/**
 * Home: say what you want done, then what is already moving. The day panel
 * carries today's events and tasks; Home does not repeat them.
 */
import { useState } from 'react';
import { Composer } from '../chat/Composer.tsx';
import { Icon, type IconName } from '../design/icons.tsx';
import { Button, Chip, TabsUnderline } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { useApp, useLoad } from '../experience/hooks.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { PlanTable } from './Plans.tsx';

function relative(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString();
  if (date.toDateString() === today)
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function HomeScreen() {
  const { refreshConversations } = useApp();
  const home = useLoad(() => adapter.home(), []);
  const plans = useLoad(() => adapter.plans(), []);
  const [text, setText] = useState('');
  const [tab, setTab] = useState<'chats' | 'files'>('chats');
  const [busy, setBusy] = useState(false);

  const start = async (body: string) => {
    const clean = body.trim();
    if (!clean || busy) return;
    setBusy(true);
    const result = await adapter.startConversation({ text: clean, agent_id: 'nova' });
    setBusy(false);
    if (result.error !== null) {
      toast({ kind: 'err', title: 'Couldn’t start the chat', sub: result.error });
      return;
    }
    refreshConversations();
    navigate(`/chat/${result.data.conversation.id}`);
  };

  const data = home.data;
  const active = (plans.data?.plans ?? []).filter((plan) => plan.status === 'in_progress');
  return (
    <Shell title="Home">
      <div className="page">
        <div className="page-head">
          <div className="col" style={{ gap: 6 }}>
            <h1>{data?.greeting ?? 'Hello'}</h1>
            <div style={{ fontSize: 14, color: 'var(--muted)' }}>{data?.date_line ?? ''}</div>
          </div>
          <Button variant="outline" icon="plus" onClick={() => navigate('/plans?new=1')}>
            New plan
          </Button>
        </div>
        {home.error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{home.error}</p> : null}
        <div className="col" style={{ gap: 12 }}>
          <Composer
            value={text}
            onChange={setText}
            onSend={() => void start(text)}
            placeholder="What do you want to get done?"
            disabled={busy}
          />
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {(data?.prompts ?? []).map((prompt) => (
              <Chip
                key={prompt.label}
                icon={prompt.icon as IconName}
                onClick={() => void start(prompt.text)}
              >
                {prompt.label}
              </Chip>
            ))}
          </div>
        </div>
        {active.length > 0 || plans.loading ? (
          <div className="col" style={{ gap: 12 }}>
            <div className="section-head">
              <h2>Active plans</h2>
              <a className="section-link" href={href('/plans')}>
                All plans
                <Icon name="chevronRight" size={14} />
              </a>
            </div>
            <PlanTable plans={active} />
          </div>
        ) : null}
        <div className="col" style={{ gap: 12 }}>
          <div className="section-head">
            <h2>Recent</h2>
            <Button
              size="sm"
              variant="outline"
              icon="compose"
              onClick={() => navigate('/chat/new')}
            >
              New chat
            </Button>
          </div>
          <TabsUnderline
            label="Recent"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'chats', label: 'Conversations', count: data?.recent.length ?? 0 },
              { value: 'files', label: 'Files', count: data?.files.length ?? 0 },
            ]}
          />
          <div className="card-12" style={{ overflow: 'hidden' }}>
            <div style={{ height: 1 }} />
            {tab === 'chats'
              ? (data?.recent ?? []).map((chat) => (
                  <a key={chat.id} className="list-row" href={href(`/chat/${chat.id}`)}>
                    <span style={{ color: 'var(--muted)', display: 'flex' }}>
                      <Icon name="chat" size={18} />
                    </span>
                    <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span
                        className="clamp1"
                        style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                      >
                        {chat.title}
                      </span>
                      <span className="clamp1" style={{ fontSize: 13, color: 'var(--muted)' }}>
                        {chat.preview}
                      </span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {relative(chat.updated_at)}
                    </span>
                    <span style={{ color: 'var(--secondary)', display: 'flex' }}>
                      <Icon name="chevronRight" size={16} />
                    </span>
                  </a>
                ))
              : (data?.files ?? []).map((file) => (
                  <div key={file.id} className="list-row">
                    <span style={{ color: 'var(--muted)', display: 'flex' }}>
                      <Icon name="fileText" size={18} />
                    </span>
                    <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                      <span
                        className="clamp1"
                        style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}
                      >
                        {file.name}
                      </span>
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{file.size}</span>
                    </div>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{file.updated_at}</span>
                  </div>
                ))}
            {tab === 'chats' && data && data.recent.length === 0 ? (
              <div
                className="col"
                style={{
                  alignItems: 'center',
                  gap: 12,
                  padding: '32px 24px',
                  textAlign: 'center',
                  borderTop: '1px solid var(--line)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-head)',
                    fontSize: 16,
                    fontWeight: 600,
                    color: 'var(--heading)',
                  }}
                >
                  Nothing yet
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Your first conversation lands here.
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Shell>
  );
}
