/**
 * Room → Board: the room's dated events, tasks, questions and notes, as the
 * signed-in person may see them. They claim a task, mark it done, or answer
 * a question put to them; every open board updates live. The service decides
 * who sees what; this page only shows what it was given.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Status } from '../design/primitives.tsx';
import { clockTime, dayWords } from '../experience/clock.ts';
import { useApp } from '../experience/hooks.ts';
import { webHref } from '../experience/markdown.ts';
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { roomsApi } from './api.ts';
import { type BoardItem, boardApi, followBoard, itemWhen, mergeItems } from './board-api.ts';
import { useNameOf } from './parts.tsx';
import './board.css';

const KIND_WORDS: Record<BoardItem['kind'], string> = {
  event: 'Event',
  task: 'Task',
  question: 'Question',
  note: 'Note',
};

/** A room label without the code after it: "Bob <K3F9Q>" reads as "Bob". */
export const shortName = (label: string) => label.replace(/\s*<[^>]*>\s*$/, '') || label;

/**
 * The reader of a board: their id, null when it could not be read, or
 * undefined while it is still being read.
 */
export type Reader = string | null | undefined;

/** Whether an item is assigned to the reader. */
const isMine = (entry: BoardItem, me: Reader) =>
  typeof me === 'string' && entry.assignee?.principal_id === me;

/** Whether the reader has claimed an item. */
const claimedByMe = (entry: BoardItem, me: Reader) =>
  typeof me === 'string' && entry.claimed_by?.principal_id === me;

/** Who sees an item, in words. */
export function visibilityWords(
  entry: BoardItem,
  me: Reader = null,
  nameOf: (label: string) => string = shortName,
): string {
  if (entry.visibility === 'everyone') return 'Everyone in the room';
  if (entry.visibility === 'owners' || !entry.assignee) return 'Owners only';
  return isMine(entry, me)
    ? 'You and the owners'
    : `${nameOf(entry.assignee.display_name)} and the owners`;
}

/** The line under an item: when it is, who it is for, and who sees it. */
export function metaWords(
  entry: BoardItem,
  me: Reader = null,
  nameOf: (label: string) => string = shortName,
  now = new Date(),
): string {
  const mine = isMine(entry, me);
  const forWho = entry.assignee
    ? mine
      ? 'For you'
      : `For ${nameOf(entry.assignee.display_name)}`
    : null;
  // "For you · You and the owners" names the reader twice; the owners are what it adds.
  const seen =
    mine && entry.visibility === 'assignee'
      ? 'The owners see it too'
      : visibilityWords(entry, me, nameOf);
  return [whenWords(entry, now), forWho, seen].filter(Boolean).join(' · ');
}

/**
 * Claim takes on someone else's task or nobody's, never one that is already the
 * reader's; until the reader is known it is not offered at all.
 */
export const canClaim = (entry: BoardItem, me: Reader) =>
  me !== undefined && entry.can.claim && !isMine(entry, me) && !claimedByMe(entry, me);

/** A detail's text, with each web address in it as a link. */
export type DetailPart = { text: string } | { href: string; label: string };

const ADDRESS = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * A detail split into text and links, so a pasted address reads as its site
 * ("docs.google.com") rather than in full. Only http and https addresses
 * become links; punctuation that ends a sentence stays text.
 */
export function detailParts(text: string): DetailPart[] {
  const parts: DetailPart[] = [];
  let at = 0;
  for (const match of text.matchAll(ADDRESS)) {
    let raw = match[0];
    for (;;) {
      const last = raw.at(-1) ?? '';
      const unmatched = raw.split(')').length > raw.split('(').length;
      if (/[.,;:!?'"\]}]/.test(last) || (last === ')' && unmatched)) raw = raw.slice(0, -1);
      else break;
    }
    const start = match.index ?? 0;
    const target = webHref(raw);
    if (!target) continue;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ href: target, label: new URL(target).hostname.replace(/^www\./, '') });
    at = start + raw.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

function DetailText({ text }: { text: string }) {
  return (
    <>
      {detailParts(text).map((part, index) =>
        'href' in part ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order
            key={index}
            className="board-link"
            href={part.href}
            title={part.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {part.label}
          </a>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text, in order
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** The signed-in person's id, for what is theirs on boards read outside a room. */
export function useMeId(on = true): Reader {
  const [me, setMe] = useState<Reader>(undefined);
  useEffect(() => {
    if (!on) return;
    let live = true;
    void roomsApi.me().then((result) => {
      if (live) setMe(result.data ? result.data.owner.id : null);
    });
    return () => {
      live = false;
    };
  }, [on]);
  return me;
}

/** When an item happens, as a person would say it. */
export function whenWords(entry: BoardItem, now = new Date()): string | null {
  const at = itemWhen(entry);
  if (!at) return null;
  const date = new Date(at);
  const day = dayWords(date, now);
  const time = clockTime(date);
  return entry.starts_at ? `${day}, ${time}` : `Due ${day}, ${time}`;
}

function stateOf(entry: BoardItem, me: Reader, nameOf: (label: string) => string) {
  if (entry.state === 'claimed')
    return {
      tone: 'working' as const,
      words: claimedByMe(entry, me)
        ? 'You are on it'
        : `${nameOf(entry.claimed_by?.display_name ?? 'Someone')} is on it`,
    };
  if (entry.state === 'done') return { tone: 'settled' as const, words: 'Done' };
  if (entry.state === 'answered') return { tone: 'settled' as const, words: 'Answered' };
  return { tone: 'needs' as const, words: entry.assignee ? 'Open' : 'Unassigned' };
}

/** One item, and what the reader may do with it. */
export function BoardRow({
  entry,
  me,
  onChanged,
  showRoom = false,
}: {
  entry: BoardItem;
  /** The reader, once known: what is already theirs is not offered to them. */
  me: Reader;
  onChanged: (entry: BoardItem) => void;
  showRoom?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const nameOf = useNameOf();
  const state = stateOf(entry, me, nameOf);
  const act = async (what: 'claim' | 'done') => {
    setBusy(true);
    const result =
      what === 'claim'
        ? await boardApi.claim(entry.room_id, entry.id)
        : await boardApi.done(entry.room_id, entry.id);
    setBusy(false);
    if (!result.data) {
      toast({
        kind: 'err',
        title: what === 'claim' ? 'Couldn’t claim it' : 'Couldn’t mark it done',
        sub: result.error ?? '',
      });
      return;
    }
    onChanged(result.data.item);
  };
  const reply = async (words: string) => {
    const text = words.trim();
    if (!text) return;
    setBusy(true);
    const result = await boardApi.answer(entry.room_id, entry.id, text);
    setBusy(false);
    if (!result.data) {
      toast({ kind: 'err', title: 'Couldn’t send your answer', sub: result.error ?? '' });
      return;
    }
    setAnswer('');
    toast({ kind: 'ok', title: 'Answer sent', sub: 'It is in the room as your message.' });
    onChanged(result.data.item);
  };
  const answerId = `board-answer-${entry.id}`;
  return (
    <li className="board-row" data-state={entry.state} data-kind={entry.kind}>
      <div className="col grow board-words">
        <span className="board-kind">
          {KIND_WORDS[entry.kind]}
          {showRoom ? ` · ${entry.room_name}` : ''}
        </span>
        <span className="board-title">{entry.title}</span>
        {entry.detail ? (
          <span className="board-detail clamp2">
            <DetailText text={entry.detail} />
          </span>
        ) : null}
        <span className="board-meta">{metaWords(entry, me, nameOf)}</span>
        {entry.answer ? (
          <span className="board-answer">
            {isMine(entry, me) ? 'You' : nameOf(entry.assignee?.display_name ?? 'They')} answered:{' '}
            {entry.answer}
          </span>
        ) : null}
        {entry.can.answer ? (
          <form
            className="row board-reply"
            onSubmit={(event) => {
              event.preventDefault();
              void reply(answer);
            }}
          >
            {(entry.choices ?? []).map((choice) => (
              <Button
                key={choice}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void reply(choice)}
              >
                {choice}
              </Button>
            ))}
            <label className="sr-only" htmlFor={answerId}>
              Your answer to: {entry.title}
            </label>
            <Input
              id={answerId}
              value={answer}
              placeholder="Your answer"
              onChange={(event) => setAnswer(event.target.value)}
              disabled={busy}
            />
            <Button size="sm" type="submit" disabled={busy || !answer.trim()}>
              Send
            </Button>
          </form>
        ) : null}
      </div>
      <div className="col board-side">
        <Status tone={state.tone} quiet>
          {state.words}
        </Status>
        <span className="row board-actions">
          {canClaim(entry, me) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              aria-label={`Claim: ${entry.title}`}
              onClick={() => void act('claim')}
            >
              Claim
            </Button>
          ) : null}
          {entry.can.done ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Mark done: ${entry.title}`}
              onClick={() => void act('done')}
            >
              Done
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

const byWhen = (a: BoardItem, b: BoardItem) =>
  (itemWhen(a) ?? '9999').localeCompare(itemWhen(b) ?? '9999') ||
  a.created_at.localeCompare(b.created_at);

/** The board of one room, kept live while it is open. */
export function Board({ roomId, me }: { roomId: string; me: Reader }) {
  const [items, setItems] = useState<BoardItem[] | null>(null);
  const [gone, setGone] = useState(false);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    const stop = new AbortController();
    setItems(null);
    void (async () => {
      for await (const signal of followBoard(roomId, stop.signal)) {
        if (signal.type === 'gone' || signal.type === 'signed_out') setGone(true);
        else if (signal.type === 'open') {
          // A stream that (re)opened sends what changed since; start from the whole board.
          const listed = await boardApi.list(roomId);
          if (listed.data && !stop.signal.aborted) setItems(listed.data.items);
        } else setItems((held) => mergeItems(held ?? [], signal.items));
      }
    })();
    return () => stop.abort();
  }, [roomId]);

  const changed = (entry: BoardItem) => setItems((held) => mergeItems(held ?? [], [entry]));
  const groups = useMemo(() => {
    const all = [...(items ?? [])].sort(byWhen);
    const closed = all.filter((entry) => entry.state === 'done' || entry.state === 'answered');
    const open = all.filter((entry) => !closed.includes(entry));
    const yours = open.filter(
      (entry) => entry.assignee?.principal_id === me || entry.claimed_by?.principal_id === me,
    );
    return { yours, rest: open.filter((entry) => !yours.includes(entry)), closed };
  }, [items, me]);

  if (gone) return <p className="board-empty">You can no longer see this board.</p>;
  return (
    <section className="board" aria-labelledby={`board-${roomId}`}>
      <header className="board-head">
        <h2 id={`board-${roomId}`}>Board</h2>
        <p className="board-sub">
          The room’s events, tasks, questions and notes. Each one shows only to the people it is
          for.{' '}
          <a href={href('/board')} className="board-link">
            See the week across your rooms
          </a>
        </p>
      </header>
      {items === null ? (
        <p className="board-empty">Reading the board…</p>
      ) : items.length === 0 ? (
        <p className="board-empty">
          Nothing on the board yet. Ask the agent to add something, or to put a question to someone.
        </p>
      ) : (
        <>
          {groups.yours.length ? (
            <BoardGroup title="Waiting on you" items={groups.yours} me={me} onChanged={changed} />
          ) : null}
          {groups.rest.length ? (
            <BoardGroup title="Coming up" items={groups.rest} me={me} onChanged={changed} />
          ) : null}
          {groups.closed.length ? (
            <div className="board-group">
              <Button size="sm" variant="ghost" onClick={() => setShowDone((was) => !was)}>
                {showDone ? 'Hide done' : `Show done (${groups.closed.length})`}
              </Button>
              {showDone ? (
                <ul className="board-list">
                  {groups.closed.map((entry) => (
                    <BoardRow key={entry.id} entry={entry} me={me} onChanged={changed} />
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function BoardGroup({
  title,
  items,
  me,
  onChanged,
  showRoom = false,
}: {
  title: string;
  items: BoardItem[];
  me: Reader;
  onChanged: (entry: BoardItem) => void;
  showRoom?: boolean;
}) {
  return (
    <div className="board-group">
      <h3 className="board-group-title">{title}</h3>
      <ul className="board-list">
        {items.map((entry) => (
          <BoardRow
            key={entry.id}
            entry={entry}
            me={me}
            onChanged={onChanged}
            showRoom={showRoom}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Home's "Waiting on you": open items in any room that are assigned to the
 * person, read once rooms are switched on. Home holds them, so the section
 * they sit in knows whether anything waits before it says nothing does.
 */
export function useWaitingOnYou() {
  const { capabilities } = useApp();
  const [items, setItems] = useState<BoardItem[]>([]);
  // Null while the read is out; the read's error when it failed.
  const [read, setRead] = useState<{ error: string | null } | null>(null);
  // Bumped by "Try again": the board is read once more.
  const [attempt, setAttempt] = useState(0);
  const on = capabilities.multiplayer;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt is the reason to read again
  useEffect(() => {
    if (!on) return;
    let live = true;
    setRead(null);
    void boardApi.across({ mine: true }).then((result) => {
      if (!live) return;
      if (result.data) setItems(result.data.items);
      setRead({ error: result.data ? null : (result.error ?? result.unavailable ?? 'Try again.') });
    });
    return () => {
      live = false;
    };
  }, [on, attempt]);
  const changed = (entry: BoardItem) =>
    setItems((held) =>
      mergeItems(held, [entry]).filter((kept) => kept.state === 'open' || kept.state === 'claimed'),
    );
  // With rooms switched off there is nothing to read, so nothing waits there.
  return {
    items: on ? items : [],
    loaded: !on || read !== null,
    error: on ? (read?.error ?? null) : null,
    changed,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** The items `useWaitingOnYou` read, or that they could not be read; nothing when there are none. */
export function WaitingOnYou({ waiting }: { waiting: ReturnType<typeof useWaitingOnYou> }) {
  const me = useMeId(waiting.items.length > 0);
  if (waiting.error)
    return (
      <div className="queue-failed board-waiting" role="status">
        <span>Couldn’t read what waits on you in your rooms. {waiting.error}</span>
        <Button size="sm" variant="outline" onClick={waiting.retry}>
          Try again
        </Button>
      </div>
    );
  if (waiting.items.length === 0) return null;
  return (
    <div className="board-waiting">
      <BoardGroup
        title="Waiting on you"
        items={[...waiting.items].sort(byWhen)}
        me={me}
        onChanged={waiting.changed}
        showRoom
      />
    </div>
  );
}
