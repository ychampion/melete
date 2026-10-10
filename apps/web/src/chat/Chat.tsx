/**
 * A conversation: the person's bubbles, the agent's turns with their trail
 * and cards, and the composer whose one state button follows the
 * conversation's own composer state. The transcript is the saved turns plus
 * the event stream: reload and the saved answers come back; reconnect and a
 * gap marker says where streamed text may be missing.
 */

import type { AttachmentView } from '@melete/contracts/attachments';
import { mentionedAgent } from '@melete/contracts/mention';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { amountWords } from '../companies/format.ts';
import { Icon } from '../design/icons.tsx';
import {
  Button,
  Dialog,
  IconButton,
  Menu,
  MenuItem,
  MenuSep,
  Overline,
  Popover,
} from '../design/primitives.tsx';
import { AgentAvatar } from '../experience/AgentAvatar.tsx';
import { adapter } from '../experience/adapter.ts';
import { dayWords } from '../experience/clock.ts';
import { useInFlight, useTapOnce } from '../experience/decide.ts';
import {
  agentById,
  defaultAgentOf,
  messageKey,
  turnAgent,
  useApp,
  useConversation,
  useMedia,
  useNow,
} from '../experience/hooks.ts';
import { Outbox } from '../experience/outbox.ts';
import {
  latestTurn,
  markPermission,
  markQuestion,
  openQuestion,
  reactionMessageSeq,
  setDrafts,
  type TranscriptTurn,
  type TurnBlock,
  turnIndexForReaction,
} from '../experience/reduce.ts';
import { shortTitle } from '../experience/title.ts';
import { foldedOptions, foldTogether, type Seen, seenTogether } from '../experience/together.ts';
import type {
  ActionResolution,
  CardAction,
  LedgerAction,
  Permission,
  PermissionOption,
  Reaction,
  RuleBounds,
  TurnStatus,
} from '../experience/types.ts';
import { navigate, useRoute } from '../router.ts';
import { RunChatCards } from '../runs/RunCards.tsx';
import { RailToggle, Shell, toast } from '../shell/Shell.tsx';
import { useAttachments } from './attachments.ts';
import { shownBlocks } from './blocks.ts';
import { CasePanel, useCase } from './CasePanel.tsx';
import { ChatActions } from './ChatActions.tsx';
import { Composer } from './Composer.tsx';
import { ComputerPanel, useComputer } from './ComputerPanel.tsx';
import { Markdown } from './Markdown.tsx';
import { PrivateTopic } from './PrivateTopic.tsx';
import { Protected } from './Protected.tsx';
import {
  ActionBar,
  ownComputerStep,
  PermissionCard,
  Questionnaire,
  ReceiptRow,
  ResultCard,
  TurnAvatar,
  UnknownCard,
  UserBubble,
} from './parts.tsx';
import { followDraft, type PastedSpan, sentSpans, wholeDraft } from './pasted.ts';
import { pauseOrStop } from './pause.ts';
import { takeOverFromCard } from './take-over.ts';
import { VoicePanel } from './VoiceMode.tsx';
import { useVoiceStatus } from './voice.ts';
import { WelcomeThread } from './Welcome.tsx';
import { AgentLine, EarlierMessages, LogEntries, WorkLog } from './WorkLog.tsx';
import type { WelcomeRef } from './welcome.ts';
import { FINISHED, finalText, foldedTurns, layoutTurn } from './worklog.ts';
import './chat.css';

/** One-tap changes to a draft waiting on a decision; each is sent as the person's next message. */
const QUICK_EDITS = ['Make it firmer', 'Shorter'] as const;

const WORKING: TurnStatus[] = ['queued', 'working', 'streaming', 'stalled', 'paused'];

function titleFor(text: string): string {
  return shortTitle(text) || 'New chat';
}

type Outcome = { data: unknown; error: string | null; unavailable: string | null };

/** A control that did not take says why, instead of doing nothing. */
async function reportFailure(pending: Promise<Outcome>, verb: string) {
  const result = await pending;
  if (result.data === null)
    toast({
      kind: 'err',
      title: `Couldn’t ${verb}`,
      sub: result.unavailable ?? result.error ?? '',
    });
}

/** Pausing mid-step needs the engine's help; without it, stopping keeps the progress. */
async function pauseTurn(id: string) {
  const result = await pauseOrStop({
    pause: () => adapter.pause(id),
    stop: () => adapter.stop(id),
  });
  if (result.outcome === 'stopped')
    toast({
      kind: 'info',
      title: 'Stopped this turn',
      sub: 'This assistant can’t pause mid-step, so it stopped. Your progress is saved.',
    });
  else if (result.outcome === 'failed')
    toast({ kind: 'err', title: 'Couldn’t pause', sub: result.reason });
}

/** Each agent that can handle the chat, the current one ticked. */
function AgentOptions({
  agentId,
  onPick,
}: {
  agentId: string | null;
  onPick: (id: string) => void;
}) {
  const { agents } = useApp();
  return (
    <>
      {agents.map((candidate) => (
        <button
          key={candidate.id}
          type="button"
          className="menu-item"
          style={{ height: 44 }}
          aria-current={candidate.id === agentId ? 'true' : undefined}
          onClick={() => onPick(candidate.id)}
        >
          <AgentAvatar agent={candidate} size={28} />
          <span className="col grow" style={{ gap: 0, alignItems: 'flex-start', minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--heading)' }}>
              {candidate.name}
              <span style={{ fontWeight: 400, color: 'var(--muted)' }}> · {candidate.role}</span>
            </span>
            <span
              className="clamp1"
              style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 400, maxWidth: '100%' }}
            >
              {candidate.fixed_reach
                ? 'Uses everything you connect'
                : `${candidate.tone} · @${candidate.name} in any chat`}
            </span>
          </span>
          {candidate.id === agentId ? (
            <Icon name="check" size={14} stroke={2.25} style={{ color: 'var(--heading)' }} />
          ) : null}
        </button>
      ))}
    </>
  );
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
        <AgentAvatar agent={agent} size={20} />
        {agent?.name ?? 'Melete'}
        <Icon name="chevronDown" size={13} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Menu label="Who handles this chat" width={300}>
          <Overline style={{ padding: '6px 8px 4px' }}>Who handles this chat</Overline>
          <AgentOptions
            agentId={agentId}
            onPick={(id) => {
              setOpen(false);
              onChange(id);
            }}
          />
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

/**
 * The phone has no room for the chip, so the agent's name under the title
 * opens the same choice as a sheet.
 */
function AgentSheet({
  open,
  agentId,
  onClose,
  onChange,
}: {
  open: boolean;
  agentId: string | null;
  onClose: () => void;
  onChange: (id: string) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Who handles this chat"
      sub="Or type @ and an agent’s name to ask it for one message."
      footer={
        <>
          <Button variant="ghost" icon="sliders" onClick={() => navigate('/agents')}>
            Manage agents
          </Button>
          <div className="grow" />
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="col" style={{ gap: 2 }}>
        <AgentOptions
          agentId={agentId}
          onPick={(id) => {
            onClose();
            onChange(id);
          }}
        />
      </div>
    </Dialog>
  );
}

/**
 * On the phone the decision moves to a bar at the bottom of the screen. A
 * permission that also offers "Always allow" keeps its card footer, because
 * that choice opens its own dialog from the card.
 */
const barePermission = (permission: Permission, together: readonly Permission[] = []) =>
  !foldedOptions(permission, together).includes('always');

/** A turn's permission blocks, with the asks made together folded under the first. */
const foldBlocks = (blocks: readonly TurnBlock[]) =>
  foldTogether(
    blocks,
    (block) => (block.type === 'permission' ? block.permission : null),
    (block) => (block.type === 'permission' ? String(block.decided) : ''),
  );

function TurnView({
  turn,
  now,
  touch,
  latest,
  onDecide,
  onSendDraft,
  onUndo,
  onTakeOver,
  onAnswer,
  onOwn,
  unknown,
  onResolve,
  reactions = [],
  onReact,
  busy,
  onRetry,
  conversationAgentId,
}: {
  turn: TranscriptTurn;
  now: number;
  touch: boolean;
  latest: boolean;
  onDecide: (
    id: string,
    option: PermissionOption,
    version: string,
    bounds?: RuleBounds,
    together?: Seen[],
  ) => void;
  onSendDraft: (handle: string) => void;
  onUndo: (id: string) => void;
  /** Take the agent's browser or computer over, from a card that hands the work over. */
  onTakeOver: (action: CardAction) => void;
  /** An offered answer by its id, or `{ text }` for one in the person's words. */
  onAnswer: (questionId: string, answer: string | { text: string }) => void;
  onOwn: (text: string) => void;
  /** Effects from the broker's ledger that never confirmed; drawn on the newest turn only. */
  unknown?: LedgerAction[];
  onResolve?: (actionId: string, resolution: ActionResolution) => void;
  /** Glyphs on this turn, both bubbles. */
  reactions?: Reaction[];
  /** Absent when the agent's bubble cannot be reacted to. */
  onReact?: (emoji: string) => void;
  /** Whether a decision's request is in flight. */
  busy: (id: string) => boolean;
  /** Resend this turn's message when it failed to send. */
  onRetry?: (localId: string) => void;
  /** The agent the chat belongs to; a turn answered by another one says so. */
  conversationAgentId: string | null;
}) {
  const { agents, removedAgents } = useApp();
  const { transcript } = useTranscript();
  const agent = turnAgent(agents, removedAgents, turn.turn.agent_id);
  const finished = FINISHED.includes(turn.status);
  const open = openQuestion(transcript);

  const shown = new Set(shownBlocks(turn.blocks));
  // Asks made together show as the first of them; the rest are listed on it.
  const togetherOf = new Map(foldBlocks(turn.blocks).map((entry) => [entry.item, entry.together]));
  const renderBlock = (block: TurnBlock) => {
    if (!shown.has(block)) return null;
    const together = togetherOf.get(block);
    if (!together) return null;
    switch (block.type) {
      case 'card': {
        const handle =
          block.card.primary_action?.kind === 'send' ? block.card.primary_action.handle : null;
        const draft = handle ? transcript.drafts[handle] : undefined;
        return (
          <ResultCard
            card={block.card}
            draft={draft}
            touch={touch}
            onSend={onSendDraft}
            onUndo={onUndo}
            onTakeOver={onTakeOver}
          />
        );
      }
      case 'receipt':
        return (
          <ReceiptRow
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
            permission={block.permission}
            decided={block.decided}
            touch={touch}
            bare={touch && barePermission(block.permission, together)}
            busy={busy(block.permission.id)}
            together={together}
            onDecide={(option, bounds) =>
              onDecide(
                block.permission.id,
                option,
                block.permission.version,
                bounds,
                seenTogether(together),
              )
            }
          />
        );
      case 'question':
        return (
          <Questionnaire
            question={block.question}
            answered={block.answered}
            busy={busy(block.question.id)}
            active={latest && open?.id === block.question.id}
            onAnswer={(optionId) => onAnswer(block.question.id, optionId)}
            // A question that takes free text is answered in it; one that does
            // not takes the words as the next message instead.
            onOwn={(text) =>
              block.question.free_text ? onAnswer(block.question.id, { text }) : onOwn(text)
            }
          />
        );
      default:
        return null;
    }
  };
  const unconfirmed = (unknown ?? []).map((action) => (
    <UnknownCard
      key={action.id}
      action={action}
      onResolve={(resolution) => onResolve?.(action.id, resolution)}
    />
  ));
  const layout = layoutTurn(turn);
  // A turn handed to another agent with @Name: that agent starts, and says when it is done.
  const handedTo = agent && conversationAgentId && agent.id !== conversationAgentId ? agent : null;
  const answer = finalText(turn);
  const hasBody = unconfirmed.length > 0 || finished;
  return (
    <>
      <UserBubble
        turn={turn}
        reactions={reactions.filter((r) => r.by === 'assistant')}
        onRetry={onRetry ? () => onRetry(turn.id) : undefined}
      />
      <div className="turn">
        <div className="turn-text">
          <TurnAvatar agent={agent} status={turn.status} />
          <div className="turn-main">
            {handedTo ? (
              <AgentLine
                face={<AgentAvatar agent={handedTo} size={16} />}
                text={`${handedTo.name} started working`}
              />
            ) : null}
            <WorkLog
              turn={turn}
              now={now}
              items={layout.log}
              finished={layout.finished}
              renderBlock={renderBlock}
            />
            {layout.answer ? <Answer text={layout.answer} /> : null}
            {layout.after.length ? (
              <LogEntries
                items={layout.after}
                live={false}
                streaming={false}
                renderBlock={renderBlock}
              />
            ) : null}
            {handedTo && turn.status === 'done' ? (
              <AgentLine
                face={<AgentAvatar agent={handedTo} size={16} />}
                text={`${handedTo.name} finished`}
              />
            ) : null}
          </div>
        </div>
        {hasBody ? (
          <div className="turn-body">
            {unconfirmed}
            {finished ? (
              <Protected conversationId={turn.turn.conversation_id} turnId={turn.turn.id} />
            ) : null}
            {finished && answer ? (
              <ActionBar
                turn={turn}
                touch={touch}
                reactions={reactions.filter((r) => r.by === 'person')}
                onReact={onReact}
                onCopy={() => {
                  void navigator.clipboard?.writeText(answer);
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

/** The final answer, drawn from its Markdown. */
function Answer({ text }: { text: string }) {
  return (
    <div className="final-answer">
      <Markdown text={text} streaming={false} />
    </div>
  );
}

/** The transcript reaches the turn views through a tiny context, to keep props short. */
import { createContext, useContext } from 'react';
import type { Transcript } from '../experience/reduce.ts';

const TranscriptContext = createContext<{ transcript: Transcript } | null>(null);

/** A routine writes each run here on its schedule; a question about a result starts a chat. */
function RoutineThreadNote() {
  return (
    <div
      className="row"
      role="note"
      style={{
        gap: 10,
        padding: '12px 14px',
        borderRadius: 14,
        border: '1px solid var(--line)',
        background: 'var(--surface)',
        fontSize: 13,
        color: 'var(--muted)',
        flexWrap: 'wrap',
      }}
    >
      <Icon name="automations" size={16} />
      <span className="grow" style={{ minWidth: 200 }}>
        This routine adds each run here on its schedule. To ask about a result, start a chat.
      </span>
      <Button size="sm" variant="outline" icon="plus" onClick={() => navigate('/chat/new')}>
        New chat
      </Button>
    </div>
  );
}
function useTranscript() {
  const value = useContext(TranscriptContext);
  if (!value) throw new Error('useTranscript needs the TranscriptContext');
  return value;
}

/**
 * Voice mode asked for from a new chat: the chat is made first, and the screen
 * for it opens straight into voice mode.
 */
let voiceOnArrival: string | null = null;

export function ChatScreen({ id }: { id: string | null }) {
  const { agents, refreshConversations } = useApp();
  const route = useRoute();
  const conversationId = id && id !== 'new' ? id : null;
  // A new chat started from an agent (Home, the sidebar) begins with that agent.
  const asked = conversationId ? null : agentById(agents, route.query.get('agent'));
  const fallback = asked ?? defaultAgentOf(agents);
  const state = useConversation(conversationId);
  const { conversation, transcript, setTranscript } = state;
  // A library agent's first chat opens with its welcome. Its link names the
  // template, so the welcome stays once the chat starts and after a reload.
  const welcomeId = route.query.get('welcome');
  const welcomeAgent = conversationId ? (conversation?.agent_id ?? null) : (asked?.id ?? null);
  const welcome: WelcomeRef | null = useMemo(
    () => (welcomeAgent && welcomeId ? { agentId: welcomeAgent, templateId: welcomeId } : null),
    [welcomeAgent, welcomeId],
  );
  const chatActions = (size?: number) =>
    conversation ? (
      <ChatActions
        chat={conversation}
        size={size}
        onRenamed={(renamed) => {
          state.renamed(renamed);
          refreshConversations();
        }}
        onDeleted={() => {
          refreshConversations();
          navigate('/chats');
        }}
      />
    ) : null;
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);
  const [stuck, setStuck] = useState(true);
  const [unknown, setUnknown] = useState<LedgerAction[]>([]);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  /** Turns whose bubble the service refused a reaction on; the control goes away. */
  const [unreactable, setUnreactable] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const touch = useMedia('(max-width: 767px)');
  const flight = useInFlight();
  // A message that failed to send keeps its request, so Retry resends that message once.
  const outbox = useRef<Outbox | null>(null);
  /**
   * Where the draft holds text the person pasted. Every change to the draft
   * goes through `changeDraft`, so the marks follow it; the next change after
   * a paste is the pasted text going in.
   */
  const pasteMarks = useRef<PastedSpan[]>([]);
  const pasting = useRef(false);
  const draft = useRef(text);
  const changeDraft = useCallback((next: string | ((current: string) => string)) => {
    const value = typeof next === 'function' ? next(draft.current) : next;
    pasteMarks.current = followDraft(pasteMarks.current, draft.current, value, pasting.current);
    pasting.current = false;
    draft.current = value;
    setText(value);
  }, []);
  // Files in the message box, uploaded as they are added and sent with the words.
  const files = useAttachments();
  const { clear: clearFiles, restore: restoreFiles } = files;
  if (outbox.current === null) outbox.current = new Outbox();
  // A quick edit is sent once: its chips stay disabled until the conversation moves on.
  const quick = useTapOnce<string>();
  const wide = useMedia('(min-width: 1180px)');
  // The case panel follows the width until the person opens or closes it.
  const [caseChoice, setCaseChoice] = useState<boolean | null>(null);
  // The conversation's own agent counts once it exists; before that, the one a new chat gets.
  const voicePlace = {
    conversationId,
    agentId: conversationId ? null : (agentId ?? fallback?.id ?? null),
  };
  const voice = useVoiceStatus(voicePlace);
  const [voiceOpen, setVoiceOpen] = useState(() => {
    const arriving = conversationId !== null && voiceOnArrival === conversationId;
    if (arriving) voiceOnArrival = null;
    return arriving;
  });
  /** The call shrunk to a bar, so the chat can be used while it goes on. */
  const [voiceMin, setVoiceMin] = useState(false);
  /** The phone's agent sheet, opened from the name under the title. */
  const [agentSheet, setAgentSheet] = useState(false);
  /** The agent's computer is opened by the person and stays as they left it. */
  // A link handing the person the agent's browser (`?computer=1`) opens with the computer showing.
  const [computerOpen, setComputerOpen] = useState(() => route.query.get('computer') === '1');

  const last = latestTurn(transcript);
  // A long chat opens on its newest turns; the older ones are a tap away.
  const [showAll, setShowAll] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each conversation opens folded
  useEffect(() => setShowAll(false), [conversationId]);
  const folded = foldedTurns(transcript.turns);
  const hidden = showAll ? 0 : folded.count;
  const composerState = transcript.composer;
  // A spent quick edit comes free once the conversation moves on.
  useEffect(() => quick.settle(composerState), [quick, composerState]);
  const working = WORKING.includes(transcript.status);
  // A message held before sending counts down on its receipt.
  const holding = transcript.turns.some((turn) =>
    turn.blocks.some(
      (block) =>
        block.type === 'receipt' &&
        block.receipt.sending_until !== undefined &&
        Date.parse(block.receipt.sending_until) > Date.now(),
    ),
  );
  const now = useNow(Boolean(last && WORKING.includes(last.status)) || holding);

  useEffect(() => {
    setAgentId(conversation?.agent_id ?? fallback?.id ?? null);
  }, [conversation?.agent_id, fallback?.id]);

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
        // A step on the agent's own computer is the agent's to check, never the person's.
        .filter((action) => !ownComputerStep(action))
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
    /** Resolves true once the service has the message (or will, when back online). */
    async (
      body: string,
      attached: readonly AttachmentView[] = [],
      /** Where `body` holds pasted text, when `body` is the draft. */
      marks: readonly PastedSpan[] = [],
    ): Promise<boolean> => {
      const clean = body.trim();
      if (!clean && !attached.length) return false;
      const fileIds = attached.map((file) => file.id);
      const pasted = sentSpans(marks, body);
      changeDraft('');
      pasteMarks.current = [];
      if (attached.length) clearFiles();
      // With no agent chosen the service hands the chat to Melete.
      const agent = agentId ?? fallback?.id;
      if (!conversationId) {
        const created = await adapter.createConversation({
          title: titleFor(clean || (attached[0]?.name ?? 'Files')),
          ...(agent ? { agent_id: agent } : {}),
        });
        if (created.data === null) {
          toast({
            kind: 'err',
            title: 'Couldn’t start the chat',
            sub: created.error ?? created.unavailable ?? '',
          });
          changeDraft(clean);
          // Put back as a whole, a draft that had a paste in it is marked whole.
          pasteMarks.current = wholeDraft(pasted, clean);
          restoreFiles(attached);
          return false;
        }
        const accepted = await adapter.send(
          created.data.conversation.id,
          clean,
          messageKey(),
          fileIds,
          pasted,
        );
        if (accepted.data === null)
          toast({
            kind: 'err',
            title: 'Couldn’t send',
            sub: accepted.error ?? accepted.unavailable ?? '',
          });
        refreshConversations();
        // The welcome's link, with where the person got to, moves to the new chat.
        const kept = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
        kept.delete('agent');
        navigate(
          `/chat/${created.data.conversation.id}${welcome && kept.size ? `?${kept.toString()}` : ''}`,
        );
        return accepted.data !== null;
      }
      // "@Scout …" is answered by Scout; the drawn message says so before the service does.
      const speaker = mentionedAgent(clean, agents)?.id ?? agent ?? '';
      const localId = state.local(clean, speaker, navigator.onLine ? 'sending' : 'queued_offline', [
        ...attached,
      ]);
      // Every try of this message carries this key, so the service keeps one copy.
      const key = messageKey();
      const box = outbox.current;
      if (!box) return false;
      const post = async (): Promise<boolean> => {
        state.settle(localId, 'sending');
        const accepted = await adapter.send(conversationId, clean, key, fileIds, pasted);
        if (accepted.data === null) {
          state.settle(localId, 'failed_retry');
          toast({
            kind: 'err',
            title: 'Couldn’t send',
            sub: accepted.error ?? accepted.unavailable ?? '',
            action: 'Retry',
            onAction: () => void box.retry(localId),
          });
          return false;
        }
        state.accepted(localId, accepted.data.turn_id, accepted.data.receipt.received_at);
        refreshConversations();
        return true;
      };
      if (!navigator.onLine) {
        const onOnline = () => {
          window.removeEventListener('online', onOnline);
          void box.send(localId, post);
        };
        window.addEventListener('online', onOnline);
        return true;
      }
      return box.send(localId, post);
    },
    [
      conversationId,
      agentId,
      fallback,
      agents,
      state,
      refreshConversations,
      welcome,
      clearFiles,
      restoreFiles,
      changeDraft,
    ],
  );

  const retry = (localId: string) => void outbox.current?.retry(localId);

  // One request per decision: a second press while the first is in flight is refused.
  const decide = (
    id: string,
    option: PermissionOption,
    version: string,
    bounds?: RuleBounds,
    together: Seen[] = [],
  ) =>
    void flight.run(id, async () => {
      const result =
        option === 'always' && bounds
          ? await adapter.decideAlways(id, version, bounds)
          : await adapter.decide(
              id,
              option === 'always' ? 'allow_once' : option,
              version,
              together,
            );
      if (result.data === null) {
        toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t decide' });
        return;
      }
      // Every ask the answer settled closes; one it could not stays, on its own card.
      const answered = result.data.answered ?? [id];
      setTranscript((previous) =>
        answered.reduce(
          (marked, settled) => markPermission(marked, settled, result.data.option),
          previous,
        ),
      );
      // Home's count and the sidebar read the same lists; refresh them together.
      refreshConversations();
      // The draft behind the decision has moved on; read where it stands now.
      if (conversationId)
        void adapter.drafts(conversationId).then((drafts) => {
          if (drafts.data) setTranscript((previous) => setDrafts(previous, drafts.data.drafts));
        });
      if (result.data.rule)
        toast({ kind: 'ok', title: 'Rule created', sub: result.data.rule.text });
    });

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

  // The computer shows either way: what the person can do there is theirs to see.
  const takeOver = (action: CardAction) =>
    void takeOverFromCard(action).then((result) => {
      setComputerOpen(true);
      if (result.ok)
        toast({
          kind: 'ok',
          title: result.what === 'browser' ? 'You have the browser' : 'You have the computer',
        });
      else toast({ kind: 'err', title: result.error });
    });

  const answer = useCallback(
    (questionId: string, answer: string | { text: string }) =>
      void flight.run(questionId, async () => {
        const result = await adapter.answer(questionId, answer);
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer' });
        else
          setTranscript((previous) =>
            markQuestion(previous, questionId, typeof answer === 'string' ? answer : answer.text),
          );
      }),
    [flight, setTranscript],
  );

  const setConversationAgent = (next: string) => {
    setAgentId(next);
    if (conversationId)
      void adapter.setAgent(conversationId, next).then((result) => {
        if (result.data === null)
          toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t switch' });
        refreshConversations();
      });
  };

  const startVoice = async () => {
    // A private space or agent, or a sensitive conversation: say why rather than open.
    if (voice?.off_reason) {
      toast({ kind: 'err', title: 'Voice is off here', sub: voice.off_reason });
      return;
    }
    if (conversationId) {
      setVoiceOpen(true);
      return;
    }
    const agent = agentId ?? fallback?.id;
    const created = await adapter.createConversation({
      title: 'Voice chat',
      ...(agent ? { agent_id: agent } : {}),
    });
    if (created.data === null) {
      toast({
        kind: 'err',
        title: 'Couldn’t start the chat',
        sub: created.error ?? created.unavailable ?? '',
      });
      return;
    }
    voiceOnArrival = created.data.conversation.id;
    refreshConversations();
    navigate(`/chat/${created.data.conversation.id}`);
  };

  const showDecision = () => {
    const card = scrollRef.current?.querySelector<HTMLElement>(
      '.permission[data-pending="true"], .question',
    );
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.focus({ preventScroll: true });
  };

  const title = conversation?.title ?? 'New chat';
  // A stop reads the case again: the item no longer names this job.
  const [caseRead, setCaseRead] = useState(0);
  const found = useCase(conversationId, `${transcript.status}:${caseRead}`);
  // A draft waiting on a decision can be changed in one tap before it goes.
  const draftWaiting = transcript.turns.some((turn) =>
    turn.blocks.some(
      (block) => block.type === 'permission' && block.decided === null && block.permission.draft,
    ),
  );
  const pending = touch
    ? transcript.turns
        .flatMap((turn) => foldBlocks(turn.blocks))
        .flatMap(({ item, together }) =>
          item.type === 'permission' &&
          item.decided === null &&
          barePermission(item.permission, together)
            ? [{ permission: item.permission, together }]
            : [],
        )[0]
    : undefined;
  const amount = found ? amountWords(found.item) : null;
  const caseOpen = Boolean(found) && !touch && (caseChoice ?? wide);
  const agent = agentById(agents, agentId);
  const lastId = last?.id ?? null;
  const voiceButton = (size: number) =>
    voice?.voice_mode ? (
      <IconButton
        name="voice"
        label={voiceOpen ? 'End voice mode' : 'Voice mode'}
        size={size}
        iconSize={size > 32 ? 20 : 16}
        on={voiceOpen}
        aria-pressed={voiceOpen}
        onClick={() => {
          setVoiceMin(false);
          if (voiceOpen) setVoiceOpen(false);
          else void startVoice();
        }}
      />
    ) : null;
  // A new tool entry on the stream is when the computer most likely changed.
  const toolPulse = `${transcript.status}:${transcript.turns.reduce(
    (count, turn) => count + turn.trail.length,
    0,
  )}`;
  const computer = useComputer(conversationId, computerOpen && Boolean(conversationId), toolPulse);
  const showComputer = computerOpen && Boolean(conversationId);
  const computerLabel = `${showComputer ? 'Hide' : 'Show'} ${agent?.name ?? 'Melete'}’s computer`;
  const computerToggle = (size?: number) =>
    conversationId ? (
      <IconButton
        name="monitor"
        label={computerLabel}
        on={showComputer}
        aria-expanded={showComputer}
        {...(size ? { size, iconSize: 20 } : {})}
        onClick={() => setComputerOpen(!showComputer)}
      />
    ) : null;

  return (
    <Shell
      title={title}
      agentId={agentId}
      phoneBack={() => (window.history.length > 1 ? window.history.back() : navigate('/'))}
      phoneSub={
        agent ? (
          <>
            <button
              type="button"
              className="phone-agent"
              aria-haspopup="dialog"
              aria-expanded={agentSheet}
              aria-label={`${agent.name} handles this chat. Choose another agent`}
              onClick={() => setAgentSheet(true)}
            >
              <AgentAvatar agent={agent} size={14} />
              {agent.name}
              <Icon name="chevronDown" size={12} />
            </button>
            {amount
              ? ` · ${amount.figure} ${found?.item.status === 'settled' ? 'settled' : amount.direction}`
              : ''}
          </>
        ) : undefined
      }
      rail={!found && !showComputer}
      phoneActions={
        <>
          {voiceButton(44)}
          {computerToggle(44)}
          {chatActions(44)}
        </>
      }
      panel={
        showComputer ? (
          <ComputerPanel
            agent={agent}
            computer={computer.computer}
            desktop={computer.desktop}
            error={computer.error}
            working={working}
            onClose={() => setComputerOpen(false)}
            onChanged={() => void computer.refresh()}
          />
        ) : found && caseOpen ? (
          <CasePanel
            found={found}
            transcript={transcript}
            now={now}
            onClose={() => setCaseChoice(false)}
            onStopped={() => {
              setCaseRead((n) => n + 1);
              refreshConversations();
            }}
          />
        ) : undefined
      }
    >
      <AgentSheet
        open={agentSheet}
        agentId={agentId}
        onClose={() => setAgentSheet(false)}
        onChange={setConversationAgent}
      />
      <TranscriptContext.Provider value={{ transcript }}>
        <div className="chat">
          <div className="chat-head">
            <h1 className="clamp1">{title}</h1>
            <AgentChip agentId={agentId} onChange={setConversationAgent} />
            <div className="grow" />
            {touch ? null : voiceButton(32)}
            {computerToggle()}
            {chatActions()}
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
          <PrivateTopic conversationId={conversationId} refresh={transcript.status} />
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
                  <span className="overline">
                    {dayWords(
                      new Date(transcript.turns[0]?.turn.created_at ?? Date.now()),
                      new Date(),
                    )}
                  </span>
                </div>
              ) : null}
              {welcome ? <WelcomeThread welcome={welcome} onTry={changeDraft} /> : null}
              {transcript.turns.length === 0 && !state.loading && !welcome ? (
                <div
                  className="col"
                  style={{
                    alignItems: 'center',
                    gap: 12,
                    padding: '64px 0 24px',
                    textAlign: 'center',
                  }}
                >
                  <AgentAvatar agent={agent} size={agent && !agent.is_default ? 64 : 56} />
                  <span
                    style={{
                      fontSize: 20,
                      fontFamily: 'var(--font-head)',
                      fontWeight: 600,
                      color: 'var(--heading)',
                    }}
                  >
                    {agent && !agent.is_default
                      ? `${agent.name} is listening.`
                      : 'What do you want to get done?'}
                  </span>
                  <span style={{ fontSize: 14, color: 'var(--muted)', maxWidth: 420 }}>
                    {agent
                      ? agent.standing_instruction || agent.tone
                      : 'Say it once. Melete checks what it needs, does the steps, and comes back for the moments that need you.'}
                  </span>
                </div>
              ) : null}
              {folded.count > 0 && !showAll ? (
                <EarlierMessages
                  summarised={folded.summarised > 0}
                  messages={folded.messages}
                  open={false}
                  onToggle={() => setShowAll(true)}
                />
              ) : null}
              {transcript.turns.map((turn, index) =>
                index < hidden ? null : (
                  <Fragment key={turn.id}>
                    {index > hidden && index === folded.summarised ? (
                      <EarlierMessages
                        summarised
                        messages={folded.messages}
                        open
                        onToggle={folded.count > 0 ? () => setShowAll(false) : undefined}
                      />
                    ) : null}
                    <TurnView
                      turn={turn}
                      now={now}
                      touch={touch}
                      latest={turn.id === lastId}
                      onDecide={decide}
                      onSendDraft={sendDraft}
                      onUndo={undo}
                      onTakeOver={takeOver}
                      onAnswer={answer}
                      onOwn={(own) => void send(own)}
                      unknown={turn.id === lastId ? unknown : undefined}
                      onResolve={resolve}
                      busy={(id) => flight.has(id)}
                      onRetry={retry}
                      conversationAgentId={conversation?.agent_id ?? null}
                      reactions={reactions.filter(
                        (r) => turnIndexForReaction(transcript, r) === index,
                      )}
                      onReact={
                        reactionMessageSeq(turn) !== null && !unreactable.has(turn.id)
                          ? (emoji) => react(turn, emoji)
                          : undefined
                      }
                    />
                  </Fragment>
                ),
              )}
              <RunChatCards conversationId={conversationId} refresh={transcript.status} />
              {transcript.gaps.map((gap) => (
                <div key={`gap-${gap.after}`} className="marker" role="status">
                  <Icon name="info" size={14} />
                  The connection dropped for a moment. Text that streamed while it was down may be
                  missing here.
                </div>
              ))}
            </div>
          </div>
          {voiceOpen && conversationId ? (
            <div className="chat-foot" data-call={voiceMin ? 'minimised' : 'open'}>
              <div className="chat-foot-inner">
                <VoicePanel
                  conversationId={conversationId}
                  transcript={transcript}
                  agentName={agent?.name?.trim() || 'Melete'}
                  avatar={<AgentAvatar agent={agent} size={28} />}
                  minimised={voiceMin}
                  onMinimise={setVoiceMin}
                  onSend={send}
                  onDraft={(words) =>
                    changeDraft((current) =>
                      current.trim()
                        ? `${current.trimEnd()}
${words}`
                        : words,
                    )
                  }
                  onEnd={() => {
                    setVoiceOpen(false);
                    setVoiceMin(false);
                    // Back to the control that opened it, for a keyboard user.
                    requestAnimationFrame(() =>
                      document.querySelector<HTMLElement>('[aria-label="Voice mode"]')?.focus(),
                    );
                  }}
                  onShowDecision={showDecision}
                />
              </div>
            </div>
          ) : null}
          {pending ? (
            <div className="decide-bar">
              <span className="decide-caption">
                <Icon name="lock" size={13} />
                This request can be allowed once or denied.
              </span>
              {pending.permission.options.includes('allow_once') ? (
                <Button
                  block
                  className="btn-tall"
                  disabled={flight.has(pending.permission.id)}
                  onClick={() =>
                    decide(
                      pending.permission.id,
                      'allow_once',
                      pending.permission.version,
                      undefined,
                      seenTogether(pending.together),
                    )
                  }
                >
                  Allow once
                </Button>
              ) : null}
              {pending.permission.options.includes('deny') ? (
                <Button
                  block
                  variant="ghost"
                  className="btn-tall"
                  disabled={flight.has(pending.permission.id)}
                  onClick={() =>
                    decide(
                      pending.permission.id,
                      'deny',
                      pending.permission.version,
                      undefined,
                      seenTogether(pending.together),
                    )
                  }
                >
                  Deny
                </Button>
              ) : null}
            </div>
          ) : null}
          <div className="chat-foot" hidden={Boolean(pending) || (voiceOpen && !voiceMin)}>
            <div className="chat-foot-inner">
              {!stuck ? (
                <button
                  type="button"
                  className="jump-pill"
                  aria-label={working ? 'Jump to latest, still working' : 'Jump to latest'}
                  title="Jump to latest"
                  onClick={() => {
                    const node = scrollRef.current;
                    if (node) node.scrollTop = node.scrollHeight;
                    setStuck(true);
                  }}
                >
                  <Icon name="arrowDown" size={16} />
                </button>
              ) : null}
              {draftWaiting && conversationId && composerState === 'send' ? (
                <div className="suggestions" style={{ marginBottom: 10 }}>
                  {QUICK_EDITS.map((label) => (
                    <button
                      key={label}
                      type="button"
                      className="suggestion"
                      disabled={quick.spent}
                      onClick={() => {
                        if (quick.tap(composerState))
                          void send(label).then((sent) => {
                            if (!sent) quick.release();
                          });
                      }}
                    >
                      <Icon name="pencil" size={14} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {conversation?.automation_id ? (
                <RoutineThreadNote />
              ) : (
                <Composer
                  value={text}
                  onChange={changeDraft}
                  onSend={() => void send(text, files.ready, pasteMarks.current)}
                  attachments={files}
                  onPasteText={() => {
                    pasting.current = true;
                  }}
                  agentName={
                    // A turn handed to another agent with @Name is that agent's while it works.
                    (working ? agentById(agents, last?.turn.agent_id) : null)?.name ??
                    agent?.name ??
                    'Melete'
                  }
                  placeholder={
                    agents.length > 1
                      ? `Message ${agent?.name ?? 'Melete'}, or @name`
                      : `Message ${agent?.name ?? 'Melete'}`
                  }
                  state={conversationId ? composerState : 'send'}
                  working={working}
                  autoFocus={!touch}
                  onPause={() => conversationId && void pauseTurn(conversationId)}
                  onResume={() =>
                    conversationId && void reportFailure(adapter.resume(conversationId), 'resume')
                  }
                  onStop={() =>
                    conversationId && void reportFailure(adapter.stop(conversationId), 'stop')
                  }
                  voice={
                    voice?.push_to_talk
                      ? {
                          maxSeconds: voice.max_recording_seconds,
                          place: voicePlace,
                          off: voice.off_reason,
                        }
                      : undefined
                  }
                />
              )}
            </div>
          </div>
        </div>
      </TranscriptContext.Provider>
    </Shell>
  );
}
