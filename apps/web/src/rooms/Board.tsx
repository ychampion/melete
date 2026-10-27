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
import { href } from '../router.ts';
import { toast } from '../shell/Shell.tsx';
import { type BoardItem, boardApi, followBoard, itemWhen, mergeItems } from './board-api.ts';
import './board.css';

const KIND_WORDS: Record<BoardItem['kind'], string> = {
  event: 'Event',
  task: 'Task',
  question: 'Question',
  note: 'Note',
};

/** A room label without the code after it: "Bob <K3F9Q>" reads as "Bob". */
export const shortName = (label: string) => label.replace(/\s*<[^>]*>\s*$/, '') || label;

/** Who sees an item, in words. */
export function visibilityWords(entry: BoardItem): string {
  if (entry.visibility === 'everyone') return 'Everyone in the room';
  if (entry.visibility === 'owners') return 'Owners only';
  return entry.assignee
    ? `${shortName(entry.assignee.display_name)} and the owners`
    : 'Owners only';
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

function stateOf(entry: BoardItem) {
  if (entry.state === 'claimed')
    return {
      tone: 'working' as const,
      words: `${shortName(entry.claimed_by?.display_name ?? 'Someone')} is on it`,
    };
  if (entry.state === 'done') return { tone: 'settled' as const, words: 'Done' };
  if (entry.state === 'answered') return { tone: 'settled' as const, words: 'Answered' };
  return { tone: 'needs' as const, words: entry.assignee ? 'Open' : 'Unassigned' };
}

/** One item, and what the reader may do with it. */
export function BoardRow({
  entry,
  onChanged,
  showRoom = false,
}: {
  entry: BoardItem;
  onChanged: (entry: BoardItem) => void;
  showRoom?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const state = stateOf(entry);
  const when = whenWords(entry);
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
        {entry.detail ? <span className="board-detail clamp2">{entry.detail}</span> : null}
        <span className="board-meta">
          {[
            when,
            entry.assignee ? `For ${shortName(entry.assignee.display_name)}` : null,
            visibilityWords(entry),
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {entry.answer ? (
          <span className="board-answer">
            {shortName(entry.assignee?.display_name ?? 'They')} answered: {entry.answer}
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
          {entry.can.claim ? (
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
export function Board({ roomId, me }: { roomId: string; me: string | null }) {
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
            <BoardGroup title="Waiting on you" items={groups.yours} onChanged={changed} />
          ) : null}
          {groups.rest.length ? (
            <BoardGroup title="Coming up" items={groups.rest} onChanged={changed} />
          ) : null}
          {groups.closed.length ? (
            <div className="board-group">
              <Button size="sm" variant="ghost" onClick={() => setShowDone((was) => !was)}>
                {showDone ? 'Hide done' : `Show done (${groups.closed.length})`}
              </Button>
              {showDone ? (
                <ul className="board-list">
                  {groups.closed.map((entry) => (
                    <BoardRow key={entry.id} entry={entry} onChanged={changed} />
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
  onChanged,
  showRoom = false,
}: {
  title: string;
  items: BoardItem[];
  onChanged: (entry: BoardItem) => void;
  showRoom?: boolean;
}) {
  return (
    <div className="board-group">
      <h3 className="board-group-title">{title}</h3>
      <ul className="board-list">
        {items.map((entry) => (
          <BoardRow key={entry.id} entry={entry} onChanged={onChanged} showRoom={showRoom} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Home's "Waiting on you": open items in any room that are assigned to the
 * person. Nothing is drawn when there are none, or rooms are switched off.
 */
export function WaitingOnYou() {
  const { capabilities } = useApp();
  const [items, setItems] = useState<BoardItem[]>([]);
  const on = capabilities.multiplayer;
  useEffect(() => {
    if (!on) return;
    let live = true;
    void boardApi.across({ mine: true }).then((result) => {
      if (live && result.data) setItems(result.data.items);
    });
    return () => {
      live = false;
    };
  }, [on]);
  if (!on || items.length === 0) return null;
  const changed = (entry: BoardItem) =>
    setItems((held) =>
      mergeItems(held, [entry]).filter((kept) => kept.state === 'open' || kept.state === 'claimed'),
    );
  return (
    <div className="board-waiting">
      <BoardGroup
        title="Waiting on you"
        items={[...items].sort(byWhen)}
        onChanged={changed}
        showRoom
      />
    </div>
  );
}
