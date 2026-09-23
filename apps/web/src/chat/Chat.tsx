/**
 * A conversation: the person's bubbles, the agent's turns with their trail
 * and cards, and the composer whose one state button follows the
 * conversation's own composer state. The transcript is the saved turns plus
 * the event stream: reload and the saved answers come back; reconnect and a
 * gap marker says where streamed text may be missing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentFace } from '../design/face.tsx';
import { Icon } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { IconButton, Menu, MenuItem, MenuSep, Overline, Popover } from '../design/primitives.tsx';
import { adapter } from '../experience/adapter.ts';
import {
  agentById,
  lookOf,
  messageKey,
  useApp,
  useConversation,
  useMedia,
  useNow,
} from '../experience/hooks.ts';
import {
  answerOf,
  latestTurn,
  markPermission,
  markQuestion,
  openQuestion,
  reactionMessageSeq,
  setDrafts,
  type TranscriptTurn,
  turnIndexForReaction,
} from '../experience/reduce.ts';
import type {
  ActionResolution,
  LedgerAction,
  PermissionOption,
  Reaction,
  RuleBounds,
  TurnStatus,
} from '../experience/types.ts';
import { navigate } from '../router.ts';
import { RailToggle, Shell, toast } from '../shell/Shell.tsx';
import { CasePanel, useCase } from './CasePanel.tsx';
import { Composer } from './Composer.tsx';
import {
  ActionBar,
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

const WORKING: TurnStatus[] = ['queued', 'working', 'streaming', 'paused'];
const FINISHED: TurnStatus[] = ['done', 'stopped', 'failed'];

function titleFor(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('dinner')) return 'Dinner with friends';
  if (lower.includes('kyoto') || lower.includes('japan')) return 'Kyoto in October';
  if (lower.includes('passport')) return 'Passport renewal';
  const clean = text.replace(/[.!?].*$/, '').trim();
  return clean.length > 42 ? `${clean.slice(0, 40)}…` : clean || 'New chat';
}

function AgentChip({
  agentId,
  onChange,
}: {
  agentId: string | null;
  onChange: (id: string) => void;
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
        {agent ? <AgentFace look={lookOf(agent)} size={20} /> : <MeleteAvatar size={20} />}
        {agent?.name ?? 'Melete'}
        <Icon name="chevronDown" size={13} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Menu label="Who handles this chat" width={300}>
          <Overline style={{ padding: '6px 8px 4px' }}>Who handles this chat</Overline>
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
              <AgentFace look={lookOf(candidate)} size={28} />
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
                  {candidate.tone}
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

function TurnView({
  turn,
  now,
  touch,
  latest,
  onDecide,
  onSendDraft,
  onUndo,
  onAnswer,
  onOwn,
  unknown,
  onResolve,
  reactions = [],
  onReact,
}: {
  turn: TranscriptTurn;
  now: number;
  touch: boolean;
  latest: boolean;
  onDecide: (id: string, option: PermissionOption, version: string, bounds?: RuleBounds) => void;
  onSendDraft: (handle: string) => void;
  onUndo: (id: string) => void;
  onAnswer: (questionId: string, optionId: string) => void;
  onOwn: (text: string) => void;
  /** Effects from the broker's ledger that never confirmed; drawn on the newest turn only. */
  unknown?: LedgerAction[];
  onResolve?: (actionId: string, resolution: ActionResolution) => void;
  /** Glyphs on this turn, both bubbles. */
  reactions?: Reaction[];
  /** Absent when the agent's bubble cannot be reacted to. */
  onReact?: (emoji: string) => void;
}) {
  const { agents } = useApp();
  const { transcript } = useTranscript();
  const agent = agentById(agents, turn.turn.agent_id);
  const finished = FINISHED.includes(turn.status);
  const text = answerOf(turn);
  const open = openQuestion(transcript);
  const showText = text.length > 0 || turn.streaming;

  const rendered = turn.blocks.map((block) => {
    switch (block.type) {
      case 'card': {
        const handle =
          block.card.primary_action?.kind === 'send' ? block.card.primary_action.handle : null;
        const draft = handle ? transcript.drafts[handle] : undefined;
        return (
          <ResultCard
            key={block.card.id}
            card={block.card}
            draft={draft}
            touch={touch}
            onSend={onSendDraft}
            onUndo={onUndo}
          />
        );
      }
      case 'receipt':
        return (
          <ReceiptRow
            key={block.receipt.id}
            receipt={block.receipt}
            reversed={block.reversed}
            now={now}
            standalone
            onUndo={() => onUndo(block.receipt.id)}
          />
        );
      case 'permission':
        return (
          <PermissionCard
            key={block.permission.id}
            permission={block.permission}
            decided={block.decided}
            touch={touch}
            onDecide={(option, bounds) =>
              onDecide(block.permission.id, option, block.permission.version, bounds)
            }
          />
        );
      case 'question':
        return (
          <Questionnaire
            key={block.question.id}
            question={block.question}
            answered={block.answered}
            active={latest && open?.id === block.question.id}
            onAnswer={(optionId) => onAnswer(block.question.id, optionId)}
            onOwn={onOwn}
          />
        );
      default:
        return null;
    }
  });
  const unconfirmed = (unknown ?? []).map((action) => (
    <UnknownCard
      key={action.id}
      action={action}
      onResolve={(resolution) => onResolve?.(action.id, resolution)}
    />
  ));
  const hasBlocks = rendered.length > 0 || unconfirmed.length > 0;
  return (
    <>
      <UserBubble turn={turn} reactions={reactions.filter((r) => r.by === 'assistant')} />
      <div className="turn">
        <div className="turn-text">
          <TurnAvatar agent={agent} status={turn.status} />
          {showText ? (
            <p>
              {text}
              {turn.streaming ? <span className="caret pulse" aria-hidden="true" /> : null}
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
        {(showText && turn.trail.length > 0) || hasBlocks || finished ? (
          <div className="turn-body">
            {showText ? <Trail turn={turn} now={now} /> : null}
            {rendered}
            {unconfirmed}
            {finished && text.trim() ? (
              <ActionBar
                turn={turn}
                touch={touch}
                reactions={reactions.filter((r) => r.by === 'person')}
                onReact={onReact}
                onCopy={() => {
                  void navigator.clipboard?.writeText(text);
                  toast({ kind: 'ok', title: 'Copied' });
                }}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The transcript reaches the turn views through a tiny context, to keep props short. */
import { createContext, useContext } from 'react';
import type { Transcript } from '../experience/reduce.ts';

const TranscriptContext = createContext<{ transcript: Transcript } | null>(null);
function useTranscript() {
  const value = useContext(TranscriptContext);
  if (!value) throw new Error('useTranscript needs the TranscriptContext');
  return value;
}

export function ChatScreen({ id }: { id: string | null }) {
  const { agents, refreshConversations } = useApp();
  const conversationId = id && id !== 'new' ? id : null;
  const state = useConversation(conversationId);
  const { conversation, transcript, setTranscript } = state;
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [stuck, setStuck] = useState(true);
  const [unknown, setUnknown] = useState<LedgerAction[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  /** Turns whose bubble the service refused a reaction on; the control goes away. */
  const [unreactable, setUnreactable] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const touch = useMedia('(max-width: 767px)');
  const wide = useMedia('(min-width: 1180px)');
  // The case panel follows the width until the person opens or closes it.
  const [caseChoice, setCaseChoice] = useState<boolean | null>(null);

  const last = latestTurn(transcript);
  const composerState = transcript.composer;
  const working = WORKING.includes(transcript.status);
  const now = useNow(Boolean(last && WORKING.includes(last.status)));

  useEffect(() => {
    setAgentId(conversation?.agent_id ?? agents[0]?.id ?? null);
  }, [conversation?.agent_id, agents]);

  // Effects the connector never confirmed rest in the broker's ledger, not in
  // the conversation's events; the ledger is read whenever the turn settles.
  const settled = transcript.status;
  // Reactions live on the job stream, which this client does not follow, so
  // they are read when a turn settles and again after the person taps one.
  useEffect(() => {
    if (!conversationId || WORKING.includes(settled)) return;
    let live = true;
    void adapter.reactions(conversationId).then((result) => {
      if (live && result.data) setReactions(result.data.reactions);
    });
    return () => {
      live = false;
    };
  }, [conversationId, settled]);
  useEffect(() => {
    if (!conversationId || WORKING.includes(settled)) return;
    let live = true;
    void adapter.unknownActions(conversationId).then((result) => {
      if (!live || result.data === null) return;
      // Resting at unknown, or settled by a person: the ledger keeps that decision.
      const shown = result.data.actions
        .filter(
          (action) =>
            action.status === 'unknown' ||
            action.status === 'unresolved' ||
            action.reconciliation?.decided_by === 'owner',
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      setUnknown(shown);
    });
    return () => {
      live = false;
    };
  }, [conversationId, settled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the list belongs to one conversation and empties when the route changes
  useEffect(() => {
    setUnknown([]);
  }, [conversationId]);

  const react = (turn: TranscriptTurn, emoji: string) => {
    const messageSeq = reactionMessageSeq(turn);
    if (messageSeq === null || !conversationId) return;
    void adapter.react(messageSeq, emoji).then((result) => {
      if (result.data === null) {
        // Not a message the service lets anyone react to: the control goes away.
        setUnreactable((previous) => new Set(previous).add(turn.id));
        return;
      }
      const reaction = result.data.reaction;
      setReactions((previous) =>
        previous.some((r) => r.seq === reaction.seq) ? previous : [...previous, reaction],
      );
    });
  };

  const resolve = (actionId: string, resolution: ActionResolution) =>
    void adapter.resolveAction(actionId, resolution).then((result) => {
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t record that' });
        return;
      }
      const action = result.data.action;
      setUnknown((previous) => previous.map((entry) => (entry.id === action.id ? action : entry)));
      // A draft that never confirmed is sent or returned to the person now.
      if (conversationId)
        void adapter.drafts(conversationId).then((drafts) => {
          if (drafts.data) setTranscript((previous) => setDrafts(previous, drafts.data.drafts));
        });
    });

  // biome-ignore lint/correctness/useExhaustiveDependencies: every transcript change scrolls when the person is at the bottom
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stuck) return;
    node.scrollTop = node.scrollHeight;
  }, [transcript, stuck]);

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
      const agent = agentId ?? agents[0]?.id;
      if (!agent) {
        toast({
          kind: 'err',
          title: 'Create an agent first',
          sub: 'Every chat is handled by one.',
        });
        return;
      }
      if (!conversationId) {
        const created = await adapter.createConversation({
          title: titleFor(clean),
          agent_id: agent,
        });
        if (created.data === null) {
          toast({
            kind: 'err',
            title: 'Couldn’t start the chat',
            sub: created.error ?? created.unavailable ?? '',
          });
          setText(clean);
          return;
        }
        const accepted = await adapter.send(created.data.conversation.id, clean, messageKey());
        if (accepted.data === null)
          toast({
            kind: 'err',
            title: 'Couldn’t send',
            sub: accepted.error ?? accepted.unavailable ?? '',
          });
        refreshConversations();
        navigate(`/chat/${created.data.conversation.id}`);
        return;
      }
      const localId = state.local(clean, agent, navigator.onLine ? 'sending' : 'queued_offline');
      const key = messageKey();
      const attempt = async () => {
        const accepted = await adapter.send(conversationId, clean, key);
        if (accepted.data === null) {
          state.settle(localId, 'failed_retry');
          toast({
            kind: 'err',
            title: 'Couldn’t send',
            sub: accepted.error ?? accepted.unavailable ?? '',
            action: 'Retry',
            onAction: () => void attempt(),
          });
          return;
        }
        state.accepted(localId, accepted.data.turn_id, accepted.data.receipt.received_at);
        refreshConversations();
      };
      if (!navigator.onLine) {
        const onOnline = () => {
          window.removeEventListener('online', onOnline);
          state.settle(localId, 'sending');
          void attempt();
        };
        window.addEventListener('online', onOnline);
        return;
      }
      await attempt();
    },
    [conversationId, agentId, agents, state, refreshConversations],
  );

  const decide = (id: string, option: PermissionOption, version: string, bounds?: RuleBounds) => {
    const call =
      option === 'always' && bounds
        ? adapter.decideAlways(id, version, bounds)
        : adapter.decide(id, option === 'always' ? 'allow_once' : option, version);
    void call.then((result) => {
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t decide' });
        return;
      }
      setTranscript((previous) => markPermission(previous, id, result.data.option));
      // The draft behind the decision has moved on; read where it stands now.
      if (conversationId)
        void adapter.drafts(conversationId).then((drafts) => {
          if (drafts.data) setTranscript((previous) => setDrafts(previous, drafts.data.drafts));
        });
      if (result.data.rule)
        toast({ kind: 'ok', title: 'Rule created', sub: result.data.rule.text });
    });
  };

  const sendDraft = (handle: string) =>
    void adapter.sendDraft(handle).then((result) => {
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t send' });
        return;
      }
      setTranscript((previous) => setDrafts(previous, [result.data.draft]));
      if (result.data.permission) {
        const permission = result.data.permission;
        setTranscript((previous) => {
          const present = previous.turns.some((t) =>
            t.blocks.some((b) => b.type === 'permission' && b.permission.id === permission.id),
          );
          if (present) return previous;
          const turns = previous.turns.slice();
          const index = turns.length - 1;
          const target = turns[index];
          if (!target) return previous;
          turns[index] = {
            ...target,
            blocks: [...target.blocks, { type: 'permission', permission, decided: null }],
          };
          return { ...previous, turns };
        });
      }
    });

  const undo = (id: string) =>
    void adapter.undo(id).then((result) => {
      if (result.data === null)
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t undo' });
    });

  const answer = useCallback(
    (questionId: string, optionId: string) =>
      void adapter.answer(questionId, optionId).then((result) => {
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer' });
        else setTranscript((previous) => markQuestion(previous, questionId, optionId));
      }),
    [setTranscript],
  );

  // The newest open question in the newest turn listens to the number keys.
  const open = openQuestion(transcript);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const n = Number(event.key);
      const options = open.options.slice(0, 4);
      if (!Number.isInteger(n) || n < 1 || n > options.length + 1) return;
      event.preventDefault();
      const option = options[n - 1];
      if (option) answer(open.id, option.id);
      else document.getElementById(`own-${open.id}`)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, answer]);

  const setConversationAgent = (next: string) => {
    setAgentId(next);
    if (conversationId)
      void adapter.setAgent(conversationId, next).then((result) => {
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t switch' });
        refreshConversations();
      });
  };

  const title = conversation?.title ?? 'New chat';
  const found = useCase(conversationId, transcript.status);
  const caseOpen = Boolean(found) && !touch && (caseChoice ?? wide);
  const agent = agentById(agents, agentId);
  const lastId = last?.id ?? null;

  return (
    <Shell
      title={title}
      agentId={agentId}
      rail={!found}
      panel={
        found && caseOpen ? (
          <CasePanel
            found={found}
            transcript={transcript}
            now={now}
            onClose={() => setCaseChoice(false)}
          />
        ) : undefined
      }
    >
      <TranscriptContext.Provider value={{ transcript }}>
        <div className="chat">
          <div className="chat-head">
            <h1 className="clamp1">{title}</h1>
            <AgentChip agentId={agentId} onChange={setConversationAgent} />
            <div className="grow" />
            {found ? (
              <IconButton
                name="panelRight"
                label={caseOpen ? 'Hide the case' : 'Show the case'}
                on={caseOpen}
                aria-expanded={caseOpen}
                onClick={() => setCaseChoice(!caseOpen)}
              />
            ) : (
              <RailToggle />
            )}
          </div>
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="chat-messages">
              {state.error ? (
                <div className="marker">
                  <Icon name="alert" size={14} />
                  {state.error}
                </div>
              ) : null}
              {transcript.turns.length > 0 ? (
                <div className="day-divider">
                  <span className="overline">Today</span>
                </div>
              ) : null}
              {transcript.turns.length === 0 && !state.loading ? (
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
                    <AgentFace look={lookOf(agent)} size={64} state="idle" />
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
                      ? agent.standing_instruction || agent.tone
                      : 'Say it once. Melete checks what it needs, does the steps, and comes back for the moments that need you.'}
                  </span>
                </div>
              ) : null}
              {transcript.turns.map((turn, index) => (
                <TurnView
                  key={turn.id}
                  turn={turn}
                  now={now}
                  touch={touch}
                  latest={turn.id === lastId}
                  onDecide={decide}
                  onSendDraft={sendDraft}
                  onUndo={undo}
                  onAnswer={answer}
                  onOwn={(own) => void send(own)}
                  unknown={turn.id === lastId ? unknown : undefined}
                  onResolve={resolve}
                  reactions={reactions.filter((r) => turnIndexForReaction(transcript, r) === index)}
                  onReact={
                    reactionMessageSeq(turn) !== null && !unreactable.has(turn.id)
                      ? (emoji) => react(turn, emoji)
                      : undefined
                  }
                />
              ))}
              {transcript.gaps.map((gap) => (
                <div key={`gap-${gap.after}`} className="marker" role="status">
                  <Icon name="info" size={14} />
                  The connection dropped for a moment. Text that streamed while it was down may be
                  missing here.
                </div>
              ))}
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
                state={conversationId ? composerState : 'send'}
                working={working}
                autoFocus={!touch}
                onPause={() => conversationId && void adapter.pause(conversationId)}
                onResume={() => conversationId && void adapter.resume(conversationId)}
                onStop={() => conversationId && void adapter.stop(conversationId)}
              />
            </div>
          </div>
        </div>
      </TranscriptContext.Provider>
    </Shell>
  );
}
