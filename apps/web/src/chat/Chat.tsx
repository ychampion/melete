/**
 * A conversation: the person's bubbles, the agent's turns with their trail
 * and cards, and the composer with its one state button. The transcript is the
 * event stream: reload and the durable events come back; reconnect and a gap
 * marker says where streamed text may be missing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import {
  Button,
  Dialog,
  IconButton,
  Input,
  Menu,
  MenuItem,
  MenuSep,
  Overline,
  Popover,
} from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import { agentById, useApp, useConversation, useMedia, useNow } from '../experience/hooks.ts';
import { claimedPermissions, latestTurn, type TranscriptItem } from '../experience/reduce.ts';
import type { Block, BrowserSessionData, PermissionData, Turn } from '../experience/types.ts';
import { href, navigate } from '../router.ts';
import { Shell, toast } from '../shell/Shell.tsx';
import { type Attachment, Composer, type ComposerState } from './Composer.tsx';
import {
  ActionBar,
  BrowserCard,
  BrowserFrame,
  DraftCard,
  PermissionCard,
  Questionnaire,
  ReceiptRow,
  ResultCard,
  Trail,
  TurnAvatar,
  UnknownCard,
  UserBubble,
} from './parts.tsx';
import './chat.css';

function composerState(turn: Turn | null): ComposerState {
  if (!turn) return 'send';
  switch (turn.status) {
    case 'queued':
    case 'running':
      return 'pause';
    case 'paused':
      return 'resume';
    case 'streaming':
      return 'stop';
    default:
      return 'send';
  }
}

function AgentChip({
  agentId,
  onChange,
}: {
  agentId: string | null;
  onChange: (id: string | null) => void;
}) {
  const { agents } = useApp();
  const [open, setOpen] = useState(false);
  const agent = agentById(agents, agentId);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn btn-sm nav-hover"
        style={{
          height: 28,
          padding: '0 8px 0 4px',
          borderRadius: 999,
          border: '1px solid var(--line)',
          background: 'var(--surface)',
          color: 'var(--text)',
          gap: 6,
        }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {agent ? <AgentFace look={agent.look} size={20} /> : <MeleteAvatar size={20} />}
        {agent?.name ?? 'Melete'}
        <Icon name="chevronDown" size={13} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Menu label="Who handles this chat" width={300}>
          <Overline style={{ padding: '6px 8px 4px' }}>Who handles this chat</Overline>
          <button
            type="button"
            className="menu-item"
            style={{ height: 44 }}
            onClick={() => {
              setOpen(false);
              onChange(null);
            }}
          >
            <MeleteAvatar size={28} />
            <span className="col grow" style={{ gap: 0, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>Melete</span>
              <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400 }}>
                Default · asks first
              </span>
            </span>
            {agentId === null ? (
              <Icon name="check" size={14} stroke={2.25} style={{ color: 'var(--heading)' }} />
            ) : null}
          </button>
          {agents.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              className="menu-item"
              style={{ height: 44 }}
              onClick={() => {
                setOpen(false);
                onChange(candidate.id);
              }}
            >
              <AgentFace look={candidate.look} size={28} />
              <span className="col grow" style={{ gap: 0, alignItems: 'flex-start', minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
                  {candidate.name}
                  <span style={{ fontWeight: 400, color: 'var(--muted)' }}>
                    {' '}
                    · {candidate.role}
                  </span>
                </span>
                <span
                  className="clamp1"
                  style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, maxWidth: '100%' }}
                >
                  {candidate.blurb}
                </span>
              </span>
              {candidate.id === agentId ? (
                <Icon name="check" size={14} stroke={2.25} style={{ color: 'var(--heading)' }} />
              ) : null}
            </button>
          ))}
          <MenuSep />
          <MenuItem icon="plus" onSelect={() => navigate('/agents/new')}>
            New agent
          </MenuItem>
          <MenuItem icon="sliders" onSelect={() => navigate('/agents')}>
            Manage agents
          </MenuItem>
        </Menu>
      </Popover>
    </div>
  );
}

function BrowserPanel({ session, onClose }: { session: BrowserSessionData; onClose: () => void }) {
  const working = session.status === 'working';
  return (
    <aside className="browser-panel side-panel" aria-label="Browser">
      <div
        className="row"
        style={{
          gap: 10,
          height: 56,
          padding: '0 12px 0 20px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <span
          className="row"
          style={{
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 8,
            background: 'var(--soft)',
            color: 'var(--secondary)',
          }}
        >
          <Icon name="globe" size={16} />
        </span>
        <div className="col grow" style={{ minWidth: 0 }}>
          <span
            style={{ fontSize: 14, fontWeight: 600, color: 'var(--heading)', lineHeight: '18px' }}
          >
            Browser
          </span>
          <span
            className="row"
            style={{ gap: 6, fontSize: 12, color: 'var(--muted)', lineHeight: '16px' }}
          >
            {working ? (
              <span className="spin" style={{ display: 'flex', color: 'var(--primary)' }}>
                <Icon name="loader" size={11} stroke={2} />
              </span>
            ) : null}
            {working
              ? `Melete is browsing · ${session.url.split('/')[0]}`
              : session.status === 'needs-you'
                ? 'You have the browser'
                : session.status === 'done'
                  ? 'Finished'
                  : 'Stopped'}
          </span>
        </div>
        <IconButton name="x" label="Close the browser panel" onClick={onClose} />
      </div>
      <div className="col grow" style={{ padding: 16, background: 'var(--canvas)', minHeight: 0 }}>
        <BrowserFrame
          session={session}
          dense
          height={Math.max(360, Math.min(660, window.innerHeight - 260))}
        />
      </div>
      <div
        className="col"
        style={{ gap: 8, padding: '12px 16px 16px', borderTop: '1px solid var(--line)' }}
      >
        <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
          Melete pauses the moment you take control. Nothing is booked until it confirms with you.
        </span>
        <div className="row" style={{ gap: 8 }}>
          {working ? (
            <Button icon="cursor" block onClick={() => void adapter.browserTakeControl(session.id)}>
              Take control of the browser
            </Button>
          ) : session.status === 'needs-you' ? (
            <Button icon="check" block onClick={() => void adapter.browserHandBack(session.id)}>
              Hand it back
            </Button>
          ) : null}
          {working || session.status === 'needs-you' ? (
            <Button
              variant="outline"
              icon="square"
              block
              onClick={() => void adapter.browserStop(session.id)}
            >
              Stop the task
            </Button>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function TurnView({
  turn,
  now,
  touch,
  conversationId,
  latest,
  onOpenBrowser,
}: {
  turn: Turn;
  now: number;
  touch: boolean;
  conversationId: string;
  latest: boolean;
  onOpenBrowser: (session: BrowserSessionData) => void;
}) {
  const { agents } = useApp();
  const agent = agentById(agents, turn.agent_id);
  const claimed = useMemo(() => claimedPermissions(turn), [turn]);
  const permissions = new Map<string, PermissionData>();
  for (const block of turn.blocks)
    if (block.kind === 'permission') permissions.set(block.permission.id, block.permission);

  const decide = (id: string, decision: 'allow_once' | 'always' | 'deny', hash: string) =>
    void adapter.decide(id, decision, hash).then((result) => {
      if (result.error) toast({ kind: 'err', title: result.error });
    });

  const answer = useCallback(
    (questionId: string, text: string) =>
      void adapter.answer(questionId, text).then((result) => {
        if (result.error) toast({ kind: 'err', title: result.error });
      }),
    [],
  );

  const openQuestions = turn.blocks.filter(
    (b): b is Extract<Block, { kind: 'question' }> => b.kind === 'question' && !b.question.answered,
  );
  const newestQuestion = openQuestions[openQuestions.length - 1]?.question.id ?? null;

  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < turn.blocks.length; index += 1) {
    const block = turn.blocks[index];
    if (!block) continue;
    switch (block.kind) {
      case 'card': {
        const permission =
          block.card.primary.effect.kind === 'permission'
            ? (permissions.get(block.card.primary.effect.permission_id) ?? null)
            : null;
        const receipt =
          turn.blocks.find(
            (b): b is Extract<Block, { kind: 'receipt' }> =>
              b.kind === 'receipt' && b.receipt.attaches_to === block.card.id,
          )?.receipt ?? null;
        rendered.push(
          <ResultCard
            key={block.card.id}
            card={block.card}
            permission={permission}
            touch={touch}
            onDecide={(decision) =>
              permission && decide(permission.id, decision, permission.payload_hash)
            }
          >
            {receipt ? (
              <ReceiptRow receipt={receipt} onUndo={() => void adapter.undo(receipt.id)} />
            ) : null}
          </ResultCard>,
        );
        break;
      }
      case 'receipt':
        if (block.receipt.attaches_to) break;
        rendered.push(
          <ReceiptRow
            key={block.receipt.id}
            receipt={block.receipt}
            standalone
            onUndo={() => void adapter.undo(block.receipt.id)}
          />,
        );
        break;
      case 'draft':
        rendered.push(
          <DraftCard
            key={block.draft.id}
            draft={block.draft}
            onSend={() =>
              void adapter
                .sendDraft(block.draft.id)
                .then((r) => r.error && toast({ kind: 'err', title: r.error }))
            }
            onEdit={(body) => void adapter.editDraft(block.draft.id, body)}
          />,
        );
        break;
      case 'permission':
        if (claimed.has(block.permission.id)) break;
        rendered.push(
          <PermissionCard
            key={block.permission.id}
            permission={block.permission}
            onDecide={(decision) =>
              decide(block.permission.id, decision, block.permission.payload_hash)
            }
          />,
        );
        break;
      case 'question':
        rendered.push(
          <Questionnaire
            key={block.question.id}
            question={block.question}
            active={latest && block.question.id === newestQuestion}
            onAnswer={(text) => answer(block.question.id, text)}
          />,
        );
        break;
      case 'unknown':
        rendered.push(
          <UnknownCard
            key={block.unknown.id}
            unknown={block.unknown}
            onResolve={(resolution) =>
              void adapter.resolveUnknown(block.unknown.id, resolution, '')
            }
          />,
        );
        break;
      case 'browser':
        rendered.push(
          <BrowserCard
            key={block.browser.id}
            session={block.browser}
            onTakeControl={() => void adapter.browserTakeControl(block.browser.id)}
            onHandBack={() => void adapter.browserHandBack(block.browser.id)}
            onStop={() => void adapter.browserStop(block.browser.id)}
            onOpen={() => onOpenBrowser(block.browser)}
          />,
        );
        break;
      case 'notice':
        rendered.push(
          <div key={`${block.title}-${index}`} className="marker">
            <Icon name={block.level === 'problem' ? 'alert' : 'info'} size={14} />
            {block.title}
            {block.body ? ` · ${block.body}` : ''}
          </div>,
        );
        break;
      case 'error':
        rendered.push(
          <div key={`err-${index}`} className="card-pad" style={{ gap: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--heading)' }}>
              {block.what}
            </span>
            <span style={{ fontSize: 13, color: 'var(--secondary)' }}>{block.done_about_it}</span>
          </div>,
        );
        break;
      default:
        break;
    }
  }

  const finished = turn.status === 'done' || turn.status === 'stopped' || turn.status === 'failed';
  const showText = turn.text.length > 0 || turn.text_streaming;
  return (
    <div className="turn">
      <div className="turn-text">
        <TurnAvatar agent={agent} turn={turn} />
        {showText ? (
          <p>
            {turn.text}
            {turn.text_streaming ? <span className="caret pulse" aria-hidden="true" /> : null}
          </p>
        ) : (
          <div className="col grow" style={{ paddingTop: 2 }}>
            <Trail turn={turn} now={now} />
            {turn.trail.length === 0 && !finished ? (
              <div className="col" style={{ gap: 10, paddingTop: 6 }}>
                <div className="shimmer" style={{ height: 12, width: '82%', borderRadius: 6 }} />
                <div className="shimmer" style={{ height: 12, width: '56%', borderRadius: 6 }} />
              </div>
            ) : null}
          </div>
        )}
      </div>
      {(showText && turn.trail.length > 0) || rendered.length > 0 || finished ? (
        <div className="turn-body">
          {showText ? <Trail turn={turn} now={now} /> : null}
          {rendered}
          {finished ? (
            <ActionBar
              turn={turn}
              touch={touch}
              onReact={(reaction) => void adapter.react(conversationId, turn.id, reaction)}
              onCopy={() => {
                void navigator.clipboard?.writeText(turn.text);
                toast({ kind: 'ok', title: 'Copied' });
              }}
              onSave={() =>
                toast({
                  kind: 'info',
                  title: 'Saving to a plan is not available on this instance yet.',
                })
              }
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GapMarker({ item }: { item: Extract<TranscriptItem, { role: 'gap' }> }) {
  return (
    <div className="marker" role="status">
      <Icon name="info" size={14} />
      {item.gap.reason === 'reconnect'
        ? 'The connection dropped for a moment. Text that streamed while it was down may be missing here.'
        : `Some events between ${item.gap.after + 1} and ${(item.gap.next ?? item.gap.after) - 1} are missing here.`}
    </div>
  );
}

export function ChatScreen({ id }: { id: string | null }) {
  const { agents, conversations, refreshConversations, capabilities } = useApp();
  const conversation = useConversation(id);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserSessionData | null>(null);
  const [browserDismissed, setBrowserDismissed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [stuck, setStuck] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const touch = useMedia('(max-width: 767px)');
  const phone = touch;

  const summary = conversation.summary ?? conversations.find((c) => c.id === id) ?? null;
  const turn = latestTurn(conversation.transcript);
  const state = composerState(turn);
  const working = state === 'pause' || state === 'stop' || state === 'resume';
  const now = useNow(Boolean(turn && !turn.ended_at));

  useEffect(() => {
    setAgentId(summary?.agent_id ?? null);
  }, [summary?.agent_id]);

  // The newest browser session in the newest turn docks the panel on desktop.
  const liveBrowser = useMemo(() => {
    if (!turn) return null;
    const blocks = turn.blocks.filter(
      (b): b is Extract<Block, { kind: 'browser' }> => b.kind === 'browser',
    );
    return blocks[blocks.length - 1]?.browser ?? null;
  }, [turn]);
  useEffect(() => {
    if (capabilities.browser !== 'available') return;
    if (liveBrowser && !browserDismissed && !phone) setBrowser(liveBrowser);
    else if (liveBrowser && browser && liveBrowser.id === browser.id) setBrowser(liveBrowser);
    if (!liveBrowser) setBrowser(null);
  }, [liveBrowser, browserDismissed, phone, browser, capabilities.browser]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: every transcript change scrolls when the person is at the bottom
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stuck) return;
    node.scrollTop = node.scrollHeight;
  }, [conversation.transcript, stuck]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    setStuck(node.scrollHeight - node.scrollTop - node.clientHeight < 80);
  };

  const send = useCallback(
    async (body: string) => {
      const clean = body.trim();
      if (!clean) return;
      setText('');
      setAttachments([]);
      if (!navigator.onLine) {
        conversation.optimistic(clean, 'queued');
        const onOnline = () => {
          window.removeEventListener('online', onOnline);
          void send(clean);
        };
        window.addEventListener('online', onOnline);
        return;
      }
      if (!id || id === 'new') {
        const result = await adapter.startConversation({ text: clean, agent_id: agentId });
        if (result.error !== null) {
          toast({
            kind: 'err',
            title: 'Couldn’t start the chat',
            sub: result.error,
            action: 'Retry',
            onAction: () => void send(clean),
          });
          setText(clean);
          return;
        }
        refreshConversations();
        navigate(`/chat/${result.data.conversation.id}`);
        return;
      }
      conversation.optimistic(clean, 'sending');
      const result = await adapter.send(id, clean);
      if (result.error !== null) {
        conversation.settle(clean, 'failed');
        toast({ kind: 'err', title: 'Couldn’t send', sub: result.error });
      }
    },
    [id, agentId, conversation, refreshConversations],
  );

  const setConversationAgent = (next: string | null) => {
    setAgentId(next);
    if (id && id !== 'new') void adapter.setAgent(id, next).then(refreshConversations);
  };

  const title = summary?.title ?? 'New chat';
  const items = conversation.transcript.items;
  const lastTurnId = turn?.id ?? null;
  const agent = agentById(agents, agentId);

  const header = (
    <div className="chat-head">
      <h1 className="clamp1">{title}</h1>
      <AgentChip agentId={agentId} onChange={setConversationAgent} />
      <div className="grow" />
      {id && id !== 'new' ? (
        <div className="row" style={{ gap: 2, position: 'relative' }}>
          <IconButton
            name="share"
            label="Share chat"
            onClick={() => {
              void navigator.clipboard?.writeText(`${window.location.origin}/#/chat/${id}`);
              toast({ kind: 'ok', title: 'Link copied', sub: 'Anyone with it sees this chat.' });
            }}
          />
          <IconButton
            name="pin"
            label={summary?.pinned ? 'Unpin' : 'Pin to top'}
            on={summary?.pinned ?? false}
            onClick={() => void adapter.pin(id, !summary?.pinned).then(refreshConversations)}
          />
          <IconButton
            name="more"
            label="More"
            onClick={() => setMenu((m) => !m)}
            aria-haspopup="menu"
            aria-expanded={menu}
          />
          <Popover open={menu} onClose={() => setMenu(false)} align="right">
            <Menu label="Chat options">
              <MenuItem
                icon="pencil"
                onSelect={() => {
                  setMenu(false);
                  setRename(title);
                }}
              >
                Rename
              </MenuItem>
              <MenuSep />
              <MenuItem
                icon="trash"
                danger
                onSelect={() => {
                  setMenu(false);
                  setConfirm(true);
                }}
              >
                Delete
              </MenuItem>
            </Menu>
          </Popover>
        </div>
      ) : null}
    </div>
  );

  return (
    <Shell
      title={title}
      agentId={agentId}
      panel={
        browser ? (
          <BrowserPanel
            session={browser}
            onClose={() => {
              setBrowser(null);
              setBrowserDismissed(true);
            }}
          />
        ) : undefined
      }
    >
      <div className="chat">
        {header}
        <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat-messages">
            {conversation.error ? (
              <div className="marker">
                <Icon name="alert" size={14} />
                {conversation.error}
              </div>
            ) : null}
            {items.length > 0 ? (
              <div className="day-divider">
                <span className="overline">Today</span>
              </div>
            ) : null}
            {items.length === 0 && !conversation.loading ? (
              <div
                className="col"
                style={{
                  alignItems: 'center',
                  gap: 12,
                  padding: '64px 0 24px',
                  textAlign: 'center',
                }}
              >
                {agent ? (
                  <AgentFace look={agent.look} size={64} state="idle" />
                ) : (
                  <MeleteAvatar size={56} />
                )}
                <span
                  style={{
                    fontSize: 20,
                    fontFamily: 'var(--font-head)',
                    fontWeight: 600,
                    color: 'var(--heading)',
                  }}
                >
                  {agent ? `${agent.name} is listening.` : 'What do you want to get done?'}
                </span>
                <span style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 420 }}>
                  {agent
                    ? agent.blurb
                    : 'Say it once. Melete checks what it needs, does the steps, and comes back for the moments that need you.'}
                </span>
              </div>
            ) : null}
            {items.map((item) =>
              item.role === 'user' ? (
                <UserBubble key={item.id} message={item} onRetry={() => void send(item.text)} />
              ) : item.role === 'gap' ? (
                <GapMarker key={item.id} item={item} />
              ) : (
                <TurnView
                  key={item.id}
                  turn={item}
                  now={now}
                  touch={touch}
                  conversationId={id ?? ''}
                  latest={item.id === lastTurnId}
                  onOpenBrowser={(session) => {
                    setBrowserDismissed(false);
                    setBrowser(session);
                  }}
                />
              ),
            )}
          </div>
        </div>
        <div className="chat-foot">
          <div className="chat-foot-inner">
            {!stuck ? (
              <button
                type="button"
                className="jump-pill"
                onClick={() => {
                  const node = scrollRef.current;
                  if (node) node.scrollTop = node.scrollHeight;
                  setStuck(true);
                }}
              >
                <Icon name="arrowDown" size={14} />
                {working ? 'Melete is working' : 'Jump to latest'}
              </button>
            ) : null}
            <Composer
              value={text}
              onChange={setText}
              onSend={() => void send(text)}
              state={state}
              working={working}
              autoFocus={!phone}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              onPause={() => id && void adapter.pause(id)}
              onResume={() => id && void adapter.resume(id)}
              onStop={() => id && void adapter.stop(id)}
            />
          </div>
        </div>
      </div>
      <Dialog
        open={rename !== null}
        onClose={() => setRename(null)}
        title="Rename chat"
        width={400}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                const next = rename?.trim();
                setRename(null);
                if (!next || !id) return;
                void adapter.rename(id, next).then(refreshConversations);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input
          value={rename ?? ''}
          onChange={(event) => setRename(event.target.value)}
          width="100%"
          aria-label="Chat title"
        />
      </Dialog>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete this chat?"
        sub="The conversation and its drafts are removed. Anything you saved to a plan stays."
        icon="trash"
        tone="danger"
        width={400}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirm(false);
                if (!id) return;
                void adapter.deleteConversation(id).then(() => {
                  refreshConversations();
                  navigate('/chat');
                });
              }}
            >
              Delete chat
            </Button>
          </>
        }
      />
      {!id || id === 'new' ? (
        <span className="sr-only">
          <a href={href('/chat')}>Chats</a>
        </span>
      ) : null}
    </Shell>
  );
}
