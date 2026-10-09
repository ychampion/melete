/**
 * A room's thread: every message with its author, and each answer of the
 * room's agent straight after the message that asked for it, with its cards
 * and receipts. It follows the thread's live stream: people's messages land
 * as they arrive, and the agent's work is read again as it moves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../chat/Markdown.tsx';
import { ReceiptRow, ResultCard } from '../chat/parts.tsx';
import { Icon } from '../design/icons.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { Button, Status, type StatusTone } from '../design/primitives.tsx';
import { useNow } from '../experience/hooks.ts';
import { toast } from '../shell/Shell.tsx';
import {
  followThread,
  type Me,
  type RoomDetail,
  type RoomFrame,
  type RoomMessage,
  type RoomPermission,
  type RoomRequest,
  roomsApi,
  type ThreadView,
} from './api.ts';
import { PersonAvatar, Who } from './parts.tsx';
import { RoomComposer } from './RoomComposer.tsx';
import { RoomPermissionCard } from './RoomPermission.tsx';
import {
  applyFrame,
  canStop,
  decisionWords,
  mentionFor,
  namesAgent,
  needsRead,
  REQUEST_WORDS,
  recordDelta,
  type Streams,
  type Turn,
  timeline,
  upsertMessage,
  withStreams,
} from './reduce.ts';

/**
 * The shortest gap between two full reads of the thread. The stream carries
 * the agent's words, cards and receipts itself; a full read is only for what
 * it cannot: a new request or turn, or a request coming to rest.
 */
const READ_EVERY_MS = 1500;

const TONES: Record<Turn['status'], StatusTone> = {
  idle: 'kind',
  queued: 'working',
  working: 'working',
  streaming: 'working',
  stalled: 'late',
  needs_you: 'needs',
  paused: 'waiting',
  done: 'settled',
  failed: 'late',
  stopped: 'waiting',
};

const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

export function Thread({
  roomId,
  threadId,
  detail,
  me,
  ruleChanged = 0,
  onActivity,
  onGone,
}: {
  roomId: string;
  threadId: string;
  detail: RoomDetail;
  me: Me | null;
  /** Bumped when the room's rule changes: who may answer what waits is read again. */
  ruleChanged?: number;
  onActivity: () => void;
  onGone: () => void;
}) {
  const [view, setView] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewRef = useRef<ThreadView | null>(null);
  viewRef.current = view;
  // Frames that arrived while a read was out are folded into that read's answer.
  const frames = useRef<{ n: number; frame: RoomFrame }[]>([]);
  const counter = useRef(0);
  const latestRead = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  const missed = useRef(false);
  const streams = useRef<Streams>(new Map());
  const scheduleRef = useRef<() => void>(() => undefined);

  const read = useCallback(async () => {
    const mine = ++latestRead.current;
    const from = counter.current;
    const result = await roomsApi.thread(roomId, threadId);
    if (mine !== latestRead.current) return;
    if (result.data) {
      // Messages that arrived while the read was out are folded in again; they
      // replace by id. The agent's events cannot be told apart from what the
      // read already holds, so if any came, the thread is read once more.
      let next = result.data;
      let during = false;
      for (const entry of frames.current) {
        if (entry.n < from) continue;
        if (entry.frame.kind === 'message') next = applyFrame(next, entry.frame, streams.current);
        else during = true;
      }
      frames.current = frames.current.filter((entry) => entry.n >= from);
      setView(withStreams(next, streams.current));
      setError(null);
      if (during) scheduleRef.current();
    } else if (result.status === 404 || result.status === 403) onGoneRef.current();
    else setError(result.error ?? result.unavailable);
  }, [roomId, threadId]);

  // One coalesced read at a time, never more often than READ_EVERY_MS, and
  // none while the page is hidden: it catches up once it is shown again.
  const schedule = useCallback(() => {
    if (document.visibilityState === 'hidden') {
      missed.current = true;
      return;
    }
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void read();
    }, READ_EVERY_MS);
  }, [read]);
  scheduleRef.current = schedule;

  useEffect(() => {
    const shown = () => {
      if (document.visibilityState !== 'visible' || !missed.current) return;
      missed.current = false;
      void read();
    };
    document.addEventListener('visibilitychange', shown);
    return () => document.removeEventListener('visibilitychange', shown);
  }, [read]);

  useEffect(() => {
    void read();
    const control = new AbortController();
    void (async () => {
      for await (const signal of followThread(roomId, threadId, control.signal)) {
        if (signal.type === 'gone') {
          onGoneRef.current();
          return;
        }
        if (signal.type === 'signed_out') return;
        if (signal.type === 'open') {
          schedule();
          continue;
        }
        const frame = signal.frame;
        counter.current += 1;
        frames.current.push({ n: counter.current, frame });
        if (frames.current.length > 500) frames.current = frames.current.slice(-500);
        const current = viewRef.current;
        recordDelta(streams.current, current, frame);
        setView((held) => (held ? applyFrame(held, frame, streams.current) : held));
        if (!current || needsRead(current, frame)) schedule();
      }
    })();
    return () => {
      control.abort();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [roomId, threadId, read, schedule]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again only when the rule changes
  useEffect(() => {
    if (ruleChanged > 0) void read();
  }, [ruleChanged]);

  // Keep the newest message in sight while the person is already at the bottom.
  const log = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const entries = view ? timeline(view) : [];
  const tail = entries.at(-1);
  const tailKey = tail
    ? tail.type === 'message'
      ? `${tail.message.id}:${tail.message.request_state}`
      : `${tail.turn.id}:${tail.turn.answer.length}:${tail.request.cards.length}`
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the last entry grows
  useEffect(() => {
    const node = log.current;
    if (node && atBottom.current) node.scrollTop = node.scrollHeight;
  }, [tailKey]);

  const send = async (text: string, ask: boolean, key: string) => {
    const body =
      ask && !namesAgent(text, detail.room.agent_name)
        ? `${mentionFor(detail.room.agent_name)} ${text}`
        : text;
    const result = await roomsApi.post(roomId, threadId, body, key);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t send that' });
      return false;
    }
    const posted = result.data;
    atBottom.current = true;
    setView((current) => (current ? upsertMessage(current, posted.message) : current));
    if (posted.request_job_id) schedule();
    onActivity();
    return true;
  };

  const remove = async (message: RoomMessage) => {
    const result = await roomsApi.deleteMessage(roomId, message.id);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t delete it' });
      return false;
    }
    const deleted = result.data.message;
    setView((current) => (current ? upsertMessage(current, deleted) : current));
    toast({ kind: 'ok', title: 'Deleted', sub: 'Nobody reads it now, and Melete forgets it.' });
    // The buttons that held focus are gone; the thread keeps it.
    log.current?.focus();
    return true;
  };

  // One answer per permission at a time; the thread is read again once it lands.
  const [answering, setAnswering] = useState<string | null>(null);
  const answer = async (permission: RoomPermission, option: 'allow_once' | 'deny') => {
    if (answering) return;
    setAnswering(permission.id);
    const result = await roomsApi.answer(roomId, permission, option);
    setAnswering(null);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t answer it' });
      void read();
      return;
    }
    toast({ kind: 'ok', title: option === 'allow_once' ? 'Allowed once' : 'Denied' });
    void read();
  };

  const stop = async (request: RoomRequest) => {
    const result = await roomsApi.stop(roomId, request.job_id);
    if (!result.data) {
      toast({ kind: 'err', title: result.error ?? result.unavailable ?? 'Couldn’t stop it' });
      return;
    }
    schedule();
  };

  const role = detail.room.my_role;
  const agent = detail.room.agent_name;

  return (
    <div className="room-thread-inner">
      <div className="room-thread-head">
        <h2 className="clamp1">{view?.thread.title ?? ' '}</h2>
        {view ? (
          <span className="room-thread-by">
            Started by <Who label={view.thread.created_by.display_name} strong={false} />
          </span>
        ) : null}
      </div>
      <div
        ref={log}
        className="room-log"
        role="log"
        aria-label="Messages"
        aria-live="polite"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls, so the keyboard can reach it
        tabIndex={0}
        onScroll={(event) => {
          const node = event.currentTarget;
          atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        <div className="room-log-inner">
          {error ? (
            <div className="row room-error">
              <span>Couldn’t read this thread. {error}</span>
              <Button size="sm" variant="outline" onClick={() => void read()}>
                Try again
              </Button>
            </div>
          ) : null}
          {entries.map((entry) =>
            entry.type === 'message' ? (
              <Message
                key={entry.message.id}
                message={entry.message}
                agent={agent}
                mine={entry.message.author.principal_id === me?.id}
                onDelete={() => remove(entry.message)}
              />
            ) : (
              <Answer
                key={entry.turn.id}
                agent={agent}
                request={entry.request}
                turn={entry.turn}
                last={entry.last}
                stoppable={entry.last && canStop(entry.request, me?.id ?? null, role)}
                onStop={() => void stop(entry.request)}
                me={me?.id ?? null}
                answering={answering}
                onAnswer={(permission, option) => void answer(permission, option)}
              />
            ),
          )}
        </div>
      </div>
      <RoomComposer agentName={agent} placeholder="Reply to the thread" onSend={send} />
    </div>
  );
}

function Message({
  message,
  agent,
  mine,
  onDelete,
}: {
  message: RoomMessage;
  agent: string;
  mine: boolean;
  onDelete: () => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const deleteRef = useRef<HTMLButtonElement>(null);
  // A line the service wrote: how a handoff went, said as the person it was for.
  if (message.kind === 'system')
    return (
      <p className="room-note">
        <Icon name="info" size={14} />
        <span>{message.text ?? 'Deleted by its author'}</span>
        <time dateTime={message.created_at}>{timeOf(message.created_at)}</time>
      </p>
    );
  const deletable = mine && message.kind === 'person' && message.text !== null;
  return (
    <article className="room-msg">
      <PersonAvatar id={message.author.principal_id} label={message.author.display_name} />
      <div className="col room-msg-main">
        <div className="room-msg-head">
          <Who label={message.author.display_name} />
          {message.via_agent ? <span className="room-msg-tag">via Melete</span> : null}
          {message.kind === 'handoff_result' ? (
            <span className="room-msg-tag">Shared from their own setup</span>
          ) : null}
          <time dateTime={message.created_at}>{timeOf(message.created_at)}</time>
          {message.request_state === 'pending' ? (
            <Status tone="waiting" quiet>
              Waits its turn
            </Status>
          ) : message.request_state === 'started' ? (
            <span className="room-msg-tag">Asked {agent}</span>
          ) : null}
          {deletable && !confirming ? (
            <button
              ref={deleteRef}
              type="button"
              className="room-msg-delete"
              aria-label="Delete your message"
              title="Delete your message"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={14} />
            </button>
          ) : null}
        </div>
        {message.text === null ? (
          <p className="room-msg-text" data-removed="true">
            Deleted by its author
          </p>
        ) : (
          <p className="room-msg-text">{message.text}</p>
        )}
        {confirming ? (
          <fieldset className="room-msg-confirm">
            <legend>
              Delete this message? Nobody in the room reads it again, and Melete forgets what it
              learned from it.
            </legend>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <Button
                size="sm"
                variant="destructive"
                autoFocus
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  const done = await onDelete();
                  setBusy(false);
                  if (!done) setConfirming(false);
                }}
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirming(false);
                  requestAnimationFrame(() => deleteRef.current?.focus());
                }}
              >
                Keep it
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
    </article>
  );
}

function Answer({
  agent,
  request,
  turn,
  last,
  stoppable,
  onStop,
  me,
  answering,
  onAnswer,
}: {
  agent: string;
  request: RoomRequest;
  turn: Turn;
  last: boolean;
  stoppable: boolean;
  onStop: () => void;
  me: string | null;
  answering: string | null;
  onAnswer: (permission: RoomPermission, option: 'allow_once' | 'deny') => void;
}) {
  const status = last ? request.status : turn.status;
  const streaming = ['streaming', 'stalled', 'working', 'queued'].includes(status);
  const now = useNow(last && request.receipts.some((receipt) => receipt.undo), 30_000);
  return (
    <article
      className="room-answer"
      aria-label={`${agent}, answering ${request.requested_by.display_name}`}
    >
      <MeleteAvatar size={28} />
      <div className="col room-msg-main">
        <div className="room-msg-head">
          <span className="who-name" data-strong="true">
            {agent}
          </span>
          <span className="room-answer-for">
            for <Who label={request.requested_by.display_name} strong={false} />
          </span>
          <Status tone={TONES[status]} quiet>
            {REQUEST_WORDS[status]}
          </Status>
          {stoppable ? (
            <Button size="sm" variant="ghost" icon="square" onClick={onStop}>
              Stop
            </Button>
          ) : null}
        </div>
        {turn.answer || streaming ? (
          <div className="room-answer-text">
            <Markdown text={turn.answer} streaming={streaming && last} />
          </div>
        ) : null}
        {last ? (
          <Waiting request={request} me={me} answering={answering} onAnswer={onAnswer} />
        ) : null}
        {last && (request.cards.length > 0 || request.receipts.length > 0) ? (
          <div className="col room-answer-work">
            {request.cards.map((card) => (
              <ResultCard key={card.id} card={card} readOnly />
            ))}
            {request.receipts.map(({ undo: _undo, ...receipt }) => (
              <ReceiptRow
                key={receipt.id}
                receipt={receipt}
                reversed={false}
                now={now}
                onUndo={() => undefined}
                standalone
              />
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/**
 * What a request waits on, and what was answered. Everyone in the room sees
 * each waiting permission whole, with what exactly it would do, and who may
 * answer it under the room's rule; only those people get its answers. Each
 * answer names who gave it.
 */
function Waiting({
  request,
  me,
  answering,
  onAnswer,
}: {
  request: RoomRequest;
  me: string | null;
  answering: string | null;
  onAnswer: (permission: RoomPermission, option: 'allow_once' | 'deny') => void;
}) {
  const permissions = request.permissions ?? [];
  const decisions = request.decisions ?? [];
  if (permissions.length === 0 && decisions.length === 0) return null;
  return (
    <div className="col room-waiting">
      {permissions.map((permission) => (
        <RoomPermissionCard
          key={permission.id}
          permission={permission}
          me={me}
          busy={answering === permission.id}
          onAnswer={onAnswer}
        />
      ))}
      {decisions.map((decision) => (
        <span key={decision.approval_id} className="room-decision">
          <Icon name={decision.decision === 'approved' ? 'circleCheck' : 'circleX'} size={14} />
          {decisionWords(decision)}
        </span>
      ))}
    </div>
  );
}

/** The first message of a new thread: for the people in the room, or an ask of its agent. */
export function NewThread({
  roomId,
  detail,
  onStarted,
}: {
  roomId: string;
  detail: RoomDetail;
  onStarted: (threadId: string) => void;
}) {
  const agent = detail.room.agent_name;
  return (
    <div className="room-thread-inner">
      <div className="room-new">
        <MeleteAvatar size={40} />
        <h2 className="room-new-title">Start a thread in {detail.room.name}</h2>
        <p className="room-new-sub">
          Everyone in the room reads it. {agent} answers when you ask, and everyone sees the answer
          and what it did.
        </p>
      </div>
      <RoomComposer
        agentName={agent}
        placeholder="Write the first message"
        autoFocus
        onSend={async (text, ask, key) => {
          const result = await roomsApi.startThread(roomId, text, ask, key);
          if (!result.data) {
            toast({
              kind: 'err',
              title: result.error ?? result.unavailable ?? 'Couldn’t start the thread',
            });
            return false;
          }
          onStarted(result.data.thread.id);
          return true;
        }}
      />
    </div>
  );
}
