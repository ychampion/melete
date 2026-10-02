/**
 * A room's thread: every message with its author, and each answer of the
 * room's agent straight after the message that asked for it, with its cards
 * and receipts. It follows the thread's live stream: people's messages land
 * as they arrive, and the agent's work is read again as it moves.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../chat/Markdown.tsx';
import { ReceiptRow, ResultCard } from '../chat/parts.tsx';
import { MeleteAvatar } from '../design/mark.tsx';
import { Button, Status, type StatusTone } from '../design/primitives.tsx';
import { messageKey, useNow } from '../experience/hooks.ts';
import { toast } from '../shell/Shell.tsx';
import {
  followThread,
  type Me,
  type RoomDetail,
  type RoomFrame,
  type RoomMessage,
  type RoomRequest,
  roomsApi,
  type ThreadView,
} from './api.ts';
import { PersonAvatar, Who } from './parts.tsx';
import { RoomComposer } from './RoomComposer.tsx';
import {
  applyFrame,
  canStop,
  mentionFor,
  namesAgent,
  needsRead,
  REQUEST_WORDS,
  type Turn,
  timeline,
  upsertMessage,
} from './reduce.ts';

/** The shortest gap between two reads of the thread while the agent works. */
const READ_EVERY_MS = 400;

const TONES: Record<Turn['status'], StatusTone> = {
  idle: 'kind',
  queued: 'working',
  working: 'working',
  streaming: 'working',
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
  onActivity,
  onGone,
}: {
  roomId: string;
  threadId: string;
  detail: RoomDetail;
  me: Me | null;
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

  const read = useCallback(async () => {
    const mine = ++latestRead.current;
    const from = counter.current;
    const result = await roomsApi.thread(roomId, threadId);
    if (mine !== latestRead.current) return;
    if (result.data) {
      let next = result.data;
      for (const entry of frames.current) if (entry.n >= from) next = applyFrame(next, entry.frame);
      frames.current = frames.current.filter((entry) => entry.n >= from);
      setView(next);
      setError(null);
    } else if (result.status === 404 || result.status === 403) onGoneRef.current();
    else setError(result.error ?? result.unavailable);
  }, [roomId, threadId]);

  const schedule = useCallback(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void read();
    }, READ_EVERY_MS);
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
        if (signal.type === 'open') {
          schedule();
          continue;
        }
        const frame = signal.frame;
        counter.current += 1;
        frames.current.push({ n: counter.current, frame });
        if (frames.current.length > 500) frames.current = frames.current.slice(-500);
        const current = viewRef.current;
        setView((held) => (held ? applyFrame(held, frame) : held));
        if (!current || needsRead(current, frame)) schedule();
      }
    })();
    return () => {
      control.abort();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [roomId, threadId, read, schedule]);

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

  const send = async (text: string, ask: boolean) => {
    const body =
      ask && !namesAgent(text, detail.room.agent_name)
        ? `${mentionFor(detail.room.agent_name)} ${text}`
        : text;
    const result = await roomsApi.post(roomId, threadId, body, messageKey());
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
              <Message key={entry.message.id} message={entry.message} agent={agent} />
            ) : (
              <Answer
                key={entry.turn.id}
                agent={agent}
                request={entry.request}
                turn={entry.turn}
                last={entry.last}
                stoppable={entry.last && canStop(entry.request, me?.id ?? null, role)}
                onStop={() => void stop(entry.request)}
              />
            ),
          )}
        </div>
      </div>
      <RoomComposer agentName={agent} placeholder="Reply to the thread" onSend={send} />
    </div>
  );
}

function Message({ message, agent }: { message: RoomMessage; agent: string }) {
  return (
    <article className="room-msg">
      <PersonAvatar id={message.author.principal_id} label={message.author.display_name} />
      <div className="col room-msg-main">
        <div className="room-msg-head">
          <Who label={message.author.display_name} />
          {message.via_agent ? <span className="room-msg-tag">via Melete</span> : null}
          <time dateTime={message.created_at}>{timeOf(message.created_at)}</time>
          {message.request_state === 'pending' ? (
            <Status tone="waiting" quiet>
              Waits its turn
            </Status>
          ) : message.request_state === 'started' ? (
            <span className="room-msg-tag">Asked {agent}</span>
          ) : null}
        </div>
        {message.text === null ? (
          <p className="room-msg-text" data-removed="true">
            Deleted by its author
          </p>
        ) : (
          <p className="room-msg-text">{message.text}</p>
        )}
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
}: {
  agent: string;
  request: RoomRequest;
  turn: Turn;
  last: boolean;
  stoppable: boolean;
  onStop: () => void;
}) {
  const status = last ? request.status : turn.status;
  const streaming = status === 'streaming' || status === 'working' || status === 'queued';
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
        onSend={async (text, ask) => {
          const result = await roomsApi.startThread(roomId, text, ask);
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
