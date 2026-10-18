/**
 * Reading a chat a page at a time. A chat opens on its newest turns and their
 * events in one read, and older turns are read as the person scrolls back to
 * them, so opening a chat of a thousand turns costs what opening one of twelve
 * does. What was read is kept for a while: going back to a chat draws it at
 * once from that copy, and the copy is read again behind it.
 */
import { adapter } from './adapter.ts';
import {
  applyHistory,
  fromTurns,
  setDrafts,
  type Transcript,
  type TranscriptTurn,
} from './reduce.ts';
import type { Conversation, ExperienceEvent, Turn, TurnPage, TurnStatus } from './types.ts';

/** The turns a chat opens on. The folded view shows the newest six of them. */
export const FIRST_PAGE = 12;
/** The turns each read back through history adds. */
export const OLDER_PAGE = 30;
/** The most reads one page's events may take, a guard against a service that never says it is done. */
const EVENT_READS = 50;

/** Saved answers already contain what the replayed deltas said. */
export const quiet = (transcript: Transcript): Transcript => ({
  ...transcript,
  turns: transcript.turns.map((turn) => ({ ...turn, streamed: '', streaming: false })),
});

/** Where the history last left each turn, beside what the saved turns say. */
export function endedIn(events: readonly ExperienceEvent[], into = new Map<string, TurnStatus>()) {
  for (const event of events)
    if (event.item.type === 'status' && event.turn_id) into.set(event.turn_id, event.item.status);
  return into;
}

export type Opened = {
  conversation: Conversation;
  /** The newest turns with their history applied, quiet. */
  transcript: Transcript;
  /** The saved turns as read. */
  turns: Turn[];
  /** Where the history left each turn. */
  ended: Map<string, TurnStatus>;
  /** Where older turns continue; null when every turn is here. */
  older: string | null;
  /** How many turns the chat has in all, when the service says. */
  total: number | null;
  /** The conversation stream carries on after this seq. */
  cursor: number;
  /** The job stream carries these turns' messages after this seq. */
  messagesAfter: number;
};

/** `gone` when the service says the chat is not there for this person: deleted, or never theirs. */
export type Read<T> = { data: T; error: null } | { data: null; error: string; gone?: true };

const failed = (
  result: { error: string | null; unavailable: string | null; code?: string },
  what: string,
): { data: null; error: string; gone?: true } => ({
  data: null,
  error: result.error ?? result.unavailable ?? what,
  ...(result.code === 'not_found' ? { gone: true as const } : {}),
});

/**
 * One page with all its events: the first answer, then the same page again
 * from `events_cursor` while the service says more of its events follow.
 */
async function pageWithEvents(
  id: string,
  query: { limit: number; before?: string },
  signal?: AbortSignal,
): Promise<Read<TurnPage> | null> {
  const first = await adapter.turnsPage(id, { ...query, events: true });
  if (signal?.aborted) return null;
  if (first.data === null) return failed(first, 'Couldn’t read the messages.');
  const page = first.data;
  if (page.next_cursor === undefined) return { data: page, error: null };
  // The stream carries on after the first read's last event. Each later read
  // is a read of its own and may go past that, and the turns it lists may not
  // be these, so what it has past that point is left to the stream.
  const until = page.last_seq ?? Number.POSITIVE_INFINITY;
  const events = [...(page.events ?? [])];
  let after = page.events_cursor ?? null;
  for (let reads = 0; after !== null && reads < EVENT_READS; reads++) {
    const more = await adapter.turnsPage(id, { ...query, events: true, eventsAfter: after });
    if (signal?.aborted) return null;
    if (more.data === null) return failed(more, 'Couldn’t read the messages.');
    events.push(...(more.data.events ?? []).filter((event) => event.seq <= until));
    const next = more.data.events_cursor ?? null;
    after = next !== null && next > after && next < until ? next : null;
  }
  return { data: { ...page, events, events_cursor: null }, error: null };
}

/**
 * The whole history, for a service that sends every turn at once and pages
 * none of them: read from the first event, as every chat was read before.
 */
async function wholeHistory(
  id: string,
  transcript: Transcript,
  ended: Map<string, TurnStatus>,
  signal?: AbortSignal,
): Promise<{ transcript: Transcript; cursor: number } | null> {
  let cursor = 0;
  for (;;) {
    const next = await adapter.eventsSince(id, cursor);
    if (signal?.aborted) return null;
    if (!next.data || next.data.next_cursor <= cursor) break;
    endedIn(next.data.events, ended);
    transcript = applyHistory(transcript, next.data.events);
    cursor = next.data.next_cursor;
    if (!next.data.has_more) break;
  }
  return { transcript, cursor: Math.max(transcript.lastSeq, cursor) };
}

/** A chat's newest turns, their events and its drafts: what the screen draws first. */
export async function openConversation(
  id: string,
  signal?: AbortSignal,
): Promise<Read<Opened> | null> {
  const [head, read, drafts] = await Promise.all([
    adapter.conversation(id),
    pageWithEvents(id, { limit: FIRST_PAGE }, signal),
    adapter.drafts(id),
  ]);
  if (signal?.aborted || read === null) return null;
  // A chat that is not there any more, deleted on another device, is never drawn from a copy.
  const refused = head.data === null ? failed(head, 'Couldn’t read this chat.') : read;
  if (refused.data === null) {
    if (refused.gone) forgetConversation(id);
    // Messages that could not be read are not an empty chat.
    return refused;
  }
  if (head.data === null || read.data === null) return null;
  const page = read.data;
  const conversation = head.data.conversation;
  let transcript = fromTurns(page.turns, conversation.composer, conversation.status);
  transcript = setDrafts(transcript, drafts.data?.drafts ?? []);
  const ended = new Map<string, TurnStatus>();
  let cursor: number;
  if (page.next_cursor === undefined) {
    const whole = await wholeHistory(id, transcript, ended, signal);
    if (!whole) return null;
    transcript = whole.transcript;
    cursor = whole.cursor;
  } else {
    // The saved turns and the conversation say where things stand; the
    // history only fills in what happened. A status it passes through is
    // not shown, so an old turn never reads as working while it replays.
    const events = page.events ?? [];
    endedIn(events, ended);
    transcript = applyHistory(transcript, events);
    cursor = Math.max(transcript.lastSeq, page.last_seq ?? 0);
  }
  return {
    data: {
      conversation,
      transcript: quiet(transcript),
      turns: page.turns,
      ended,
      older: page.next_cursor ?? null,
      total: page.total ?? null,
      cursor,
      messagesAfter: page.messages_after ?? 0,
    },
    error: null,
  };
}

export type OlderPage = {
  turns: TranscriptTurn[];
  messages: Transcript['messages'];
  approvals: Transcript['approvals'];
  older: string | null;
  total: number | null;
};

/**
 * The turns before `before`, drawn on their own from their own events: the
 * transcript already shown has seen newer events, and would take these for
 * ones it has applied.
 */
export async function readOlder(
  id: string,
  before: string,
  shown: Pick<Transcript, 'composer' | 'status'>,
): Promise<Read<OlderPage>> {
  const read = await pageWithEvents(id, { limit: OLDER_PAGE, before });
  if (read === null) return { data: null, error: 'Couldn’t read the earlier messages.' };
  if (read.data === null) return read;
  const page = read.data;
  const ids = new Set(page.turns.map((turn) => turn.id));
  const own = (page.events ?? []).filter(
    (event) => event.turn_id !== null && ids.has(event.turn_id),
  );
  const drawn = quiet(applyHistory(fromTurns(page.turns, shown.composer, shown.status), own));
  return {
    data: {
      turns: drawn.turns.filter((turn) => ids.has(turn.id)),
      messages: drawn.messages,
      approvals: drawn.approvals,
      older: page.next_cursor ?? null,
      total: page.total ?? null,
    },
    error: null,
  };
}

/** Older turns put before the ones shown. A turn already shown keeps its place. */
export function prependOlder(transcript: Transcript, older: OlderPage): Transcript {
  const shown = new Set(transcript.turns.map((turn) => turn.id));
  return {
    ...transcript,
    turns: [...older.turns.filter((turn) => !shown.has(turn.id)), ...transcript.turns],
    messages: { ...older.messages, ...transcript.messages },
    approvals: { ...older.approvals, ...transcript.approvals },
  };
}

/**
 * What is kept of a chat: from the oldest turn it opened on, with where the
 * turns before that continue. Going back to the chat reads its newest turns
 * again and draws those, so turns read further back would only take room; a
 * copy is the size of an open however far back the person read.
 */
export function keptFrom(
  transcript: Transcript,
  opened: { oldest: string | null; older: string | null },
  older: string | null,
): { transcript: Transcript; older: string | null } {
  const from = opened.oldest ? transcript.turns.findIndex((turn) => turn.id === opened.oldest) : -1;
  if (from <= 0) return { transcript, older };
  const turns = transcript.turns.slice(from);
  const ids = new Set(turns.map((turn) => turn.id));
  const messages = Object.fromEntries(
    Object.entries(transcript.messages).filter(
      ([, message]) => message.turnId === null || ids.has(message.turnId),
    ),
  );
  return { transcript: { ...transcript, turns, messages }, older: opened.older };
}

/* ---------- what was read, kept for going back ---------- */

export type Kept = {
  conversation: Conversation;
  transcript: Transcript;
  older: string | null;
  total: number | null;
  /** When it was read or last changed, in ms. */
  at: number;
};

/** The chats kept: enough for the ones a person goes between, never every chat. */
const KEEP = 12;
/** A copy this fresh is not read again just because the pointer passed over its chat. */
const FRESH_MS = 30_000;
const kept = new Map<string, Kept>();
const reading = new Map<string, Promise<void>>();
/** Bumped on signing out, so a read begun before it is not kept after it. */
let signIn = 0;

export function keptConversation(id: string): Kept | undefined {
  return kept.get(id);
}

export function keepConversation(id: string, copy: Kept): void {
  kept.delete(id);
  kept.set(id, copy);
  while (kept.size > KEEP) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    kept.delete(oldest);
  }
}

export function forgetConversation(id: string): void {
  kept.delete(id);
}

/** On signing out: nothing read under one sign-in is drawn under another. */
export function forgetEveryConversation(): void {
  kept.clear();
  signIn += 1;
}

/**
 * Read a chat ahead of being opened, when the pointer rests on it or it takes
 * the focus in a list. One read at a time per chat; a fresh copy is enough.
 */
export function prefetchConversation(id: string): void {
  const copy = kept.get(id);
  if ((copy && Date.now() - copy.at < FRESH_MS) || reading.has(id)) return;
  const began = signIn;
  const read = openConversation(id).then((opened) => {
    if (!opened?.data || began !== signIn || kept.get(id)?.at !== copy?.at) return;
    const { conversation, transcript, older, total } = opened.data;
    keepConversation(id, { conversation, transcript, older, total, at: Date.now() });
  });
  reading.set(
    id,
    read.finally(() => reading.delete(id)),
  );
}

/** Pointer and focus handlers for a link to a chat, which read it ahead. */
export const prefetchOn = (id: string) => ({
  onPointerEnter: () => prefetchConversation(id),
  onFocus: () => prefetchConversation(id),
});
