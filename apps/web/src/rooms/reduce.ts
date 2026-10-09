/**
 * How a room's thread is drawn from what the service returns: every person's
 * message in order, each answer of the room's agent placed straight after the
 * message that asked for it, and the live stream folded in. Pure functions, so
 * the same view comes out of a reload and of a stream.
 */
import type { RoomFrame, RoomMessage, RoomRequest, ThreadView } from './api.ts';

/**
 * A person in a room is labelled `Name <handle>` by the service, always. The
 * handle is the room's own code for them: nobody chooses it, so it is what
 * tells two people with the same name apart, and it is shown, never dropped.
 * No label carries an email. This only splits the label so the two parts can
 * be set apart.
 */
export function splitLabel(label: string): { name: string; handle: string | null } {
  const match = /^(.*\S)\s+<([^<>\s@]+)>$/.exec(label.trim());
  if (!match?.[1] || !match[2]) return { name: label.trim(), handle: null };
  return { name: match[1], handle: match[2] };
}

/** One or two letters for an avatar, from the name part of a label. */
export function initialsOf(label: string): string {
  const { name, handle } = splitLabel(label);
  const words = (name || handle || '?').split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  return letters
    .map((word) => Array.from(word ?? '')[0] ?? '')
    .join('')
    .toUpperCase();
}

const byTime = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) =>
  a.created_at === b.created_at
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : Date.parse(a.created_at) - Date.parse(b.created_at);

/** Add a message the stream or a post returned, or replace the copy already held. */
export function upsertMessage(view: ThreadView, message: RoomMessage): ThreadView {
  if (message.thread_id !== view.thread.id) return view;
  const others = view.messages.filter((held) => held.id !== message.id);
  return { ...view, messages: [...others, message].sort(byTime) };
}

export type Turn = RoomRequest['turns'][number];

export type ThreadEntry =
  | { type: 'message'; message: RoomMessage }
  /** One answer of a request; `last` carries the request's cards and receipts under it. */
  | { type: 'answer'; request: RoomRequest; turn: Turn; last: boolean };

/**
 * The thread in reading order. Each message that reached a request is
 * followed by that request's answer to it: the first asking message by the
 * request's first turn, a follow-up by the next. Turns no message accounts for
 * follow the request's last message, so nothing the agent said is left out.
 */
export function timeline(view: ThreadView): ThreadEntry[] {
  const messages = [...view.messages].sort(byTime);
  const requests = new Map(view.requests.map((request) => [request.job_id, request]));
  const asked = new Map<string, RoomMessage[]>();
  for (const message of messages) {
    if (!message.request_job_id || !requests.has(message.request_job_id)) continue;
    const list = asked.get(message.request_job_id) ?? [];
    list.push(message);
    asked.set(message.request_job_id, list);
  }
  const answers = (request: RoomRequest, from: number, to: number): ThreadEntry[] => {
    const turns = [...request.turns].sort(byTime);
    return turns.slice(from, to).map((turn, offset) => ({
      type: 'answer',
      request,
      turn,
      last: from + offset === turns.length - 1,
    }));
  };
  const entries: ThreadEntry[] = [];
  for (const message of messages) {
    entries.push({ type: 'message', message });
    const request = message.request_job_id ? requests.get(message.request_job_id) : undefined;
    if (!request) continue;
    const list = asked.get(request.job_id) ?? [];
    const index = list.indexOf(message);
    const isLast = index === list.length - 1;
    entries.push(...answers(request, index, isLast ? request.turns.length : index + 1));
  }
  // A request no message in this view points at still shows, at the end.
  for (const request of view.requests)
    if (!asked.has(request.job_id)) entries.push(...answers(request, 0, request.turns.length));
  return entries;
}

/** The part of a request's stream event the thread folds in by itself. */
type StreamItem =
  | { type: 'text_delta'; text: string }
  | { type: 'status'; status: Turn['status'] }
  | { type: 'card'; card: RoomRequest['cards'][number] }
  | { type: 'receipt'; receipt: RoomRequest['receipts'][number] }
  | { type: string };
type StreamEvent = { turn_id: string | null; item: StreamItem };

const SETTLED = new Set<Turn['status']>([
  'done',
  'failed',
  'stopped',
  'needs_you',
  'paused',
  'idle',
]);

/**
 * Whether the frame changes something only a fresh read of the thread can
 * show: a request or turn this view has not seen, an event it cannot fold in
 * by itself, or a request coming to rest (when the service's own copy of the
 * answer replaces the streamed one).
 */
export function needsRead(view: ThreadView, frame: RoomFrame): boolean {
  if (frame.kind === 'message') {
    const id = frame.message.request_job_id;
    return id !== null && !view.requests.some((request) => request.job_id === id);
  }
  const request = view.requests.find((held) => held.job_id === frame.request_job_id);
  if (!request) return true;
  const event = frame.event as StreamEvent;
  if (event.turn_id !== null && !request.turns.some((turn) => turn.id === event.turn_id))
    return true;
  const item = event.item;
  if (item.type === 'status') return SETTLED.has((item as { status: Turn['status'] }).status);
  return ![
    'text_delta',
    'card',
    'receipt',
    'say',
    'action',
    'note',
    'done',
    'reasoning',
    'tool',
  ].includes(item.type);
}

/**
 * The answer text each turn has streamed so far, built from the stream alone.
 * A full read can be ahead of the stream, so its text is never added to: the
 * two are compared instead (see `answerOf`), and a word is never shown twice.
 */
export type Streams = Map<string, string>;

const WRITING = new Set<Turn['status']>(['queued', 'working', 'streaming', 'stalled']);

/**
 * Add a frame's words to what its turn has streamed. Called once per frame,
 * before `applyFrame`, which only reads the streams.
 */
export function recordDelta(streams: Streams, view: ThreadView | null, frame: RoomFrame): void {
  if (frame.kind !== 'request') return;
  const event = frame.event as StreamEvent;
  if (event.item.type !== 'text_delta' || !('text' in event.item)) return;
  const turnId =
    event.turn_id ??
    view?.requests.find((request) => request.job_id === frame.request_job_id)?.turns.at(-1)?.id;
  if (!turnId) return;
  streams.set(turnId, (streams.get(turnId) ?? '') + event.item.text);
}

/** A turn's answer: the service's copy once it rests, else the further along of the two. */
export function answerOf(turn: Turn, streamed: string | undefined): string {
  if (streamed === undefined || !WRITING.has(turn.status)) return turn.answer;
  const live = streamed.trimStart();
  if (turn.answer.startsWith(live)) return turn.answer;
  return live;
}

/** A read of the thread, with each answer still being written brought up to what has streamed. */
export function withStreams(view: ThreadView, streams: Streams): ThreadView {
  if (streams.size === 0) return view;
  return {
    ...view,
    requests: view.requests.map((request) => ({
      ...request,
      turns: request.turns.map((turn) => ({
        ...turn,
        answer: answerOf(turn, streams.get(turn.id)),
      })),
    })),
  };
}

function applyRequestEvent(
  view: ThreadView,
  jobId: string,
  raw: unknown,
  streams: Streams,
): ThreadView {
  const event = raw as StreamEvent;
  const requests = view.requests.map((request) => {
    if (request.job_id !== jobId) return request;
    const item = event.item;
    const turnId = event.turn_id ?? request.turns.at(-1)?.id ?? null;
    const onTurn = (change: (turn: Turn) => Turn) =>
      request.turns.map((turn) => (turn.id === turnId ? change(turn) : turn));
    if (item.type === 'text_delta') {
      if (!turnId) return request;
      const streamed = streams.get(turnId);
      return {
        ...request,
        turns: onTurn((turn) => ({ ...turn, answer: answerOf(turn, streamed) })),
      };
    }
    if (item.type === 'status' && 'status' in item)
      return {
        ...request,
        status: item.status,
        turns: onTurn((turn) => ({ ...turn, status: item.status })),
      };
    if (item.type === 'card' && 'card' in item && !request.cards.some((c) => c.id === item.card.id))
      return { ...request, cards: [...request.cards, item.card] };
    if (
      item.type === 'receipt' &&
      'receipt' in item &&
      !request.receipts.some((r) => r.id === item.receipt.id)
    )
      return { ...request, receipts: [...request.receipts, item.receipt] };
    return request;
  });
  return { ...view, requests };
}

/**
 * Fold one live frame into the thread: messages directly, and the agent's
 * answer text, status, cards and receipts from its stream, so watching an
 * answer costs no reads of the thread.
 */
export function applyFrame(view: ThreadView, frame: RoomFrame, streams: Streams): ThreadView {
  return frame.kind === 'message'
    ? upsertMessage(view, frame.message)
    : applyRequestEvent(view, frame.request_job_id, frame.event, streams);
}

const ACTIVE = new Set<Turn['status']>([
  'queued',
  'working',
  'streaming',
  'stalled',
  'needs_you',
  'paused',
]);

/** A request under way can be stopped by the person who asked it, or by an owner of the room. */
export function canStop(request: RoomRequest, me: string | null, role: string | null): boolean {
  if (!ACTIVE.has(request.status)) return false;
  return role === 'owner' || (me !== null && request.requested_by.principal_id === me);
}

export const REQUEST_WORDS: Record<Turn['status'], string> = {
  idle: 'Ready',
  queued: 'Starting',
  working: 'Working',
  streaming: 'Answering',
  needs_you: 'Waiting for a decision',
  paused: 'Paused',
  done: 'Done',
  failed: 'Stopped without finishing',
  stopped: 'Stopped',
};

/**
 * The word that asks the room's agent: `@` and its name when the name is one
 * word, otherwise `@Melete`, which every room's agent answers to.
 */
export function mentionFor(agentName: string): string {
  const name = agentName.trim();
  return /^[\p{L}\p{N}_]+$/u.test(name) ? `@${name}` : '@Melete';
}

/** Whether a message already names the room's agent, the way the service reads it. */
export function namesAgent(text: string, agentName: string): boolean {
  const lower = text.toLowerCase();
  const names = [...new Set(['melete', agentName.trim().toLowerCase()])].filter(Boolean);
  const word = /[\p{L}\p{N}_]/u;
  return names.some((name) => {
    for (let at = lower.indexOf(`@${name}`); at >= 0; at = lower.indexOf(`@${name}`, at + 1)) {
      const before = lower[at - 1];
      const after = lower[at + name.length + 1];
      if (
        (before === undefined || !(word.test(before) || before === '@' || before === '.')) &&
        (after === undefined || !word.test(after))
      )
        return true;
    }
    return false;
  });
}

export type HeldSend = { text: string; ask: boolean; key: string };

/**
 * The submission key for a send: the one already used when the same message
 * is sent again after a failure, so the service takes it once; a new one when
 * the words or the ask changed.
 */
export function sendKey(held: HeldSend | null, text: string, ask: boolean, mint: () => string) {
  return held && held.text === text && held.ask === ask ? held.key : mint();
}

export type RoomDecisionView = NonNullable<RoomRequest['decisions']>[number];

/** How an answered permission reads in the thread, with who answered it. */
export function decisionWords(decision: RoomDecisionView): string {
  if (decision.decided_by)
    return `${decision.decision === 'approved' ? 'Allowed' : 'Denied'} by ${decision.decided_by.display_name}`;
  return decision.decision === 'approved'
    ? 'Allowed by the room’s settings'
    : 'Withdrawn by Melete';
}

type PermissionView = NonNullable<RoomRequest['permissions']>[number];

/**
 * Whether the signed-in person may answer this permission: the room's rule
 * names them among its approvers, and the card names the exact content an
 * answer is for. Everyone else in the room sees the card and who can answer it.
 */
export function canAnswer(permission: PermissionView, me: string | null): boolean {
  if (!me || !permission.payload_hash) return false;
  return (permission.eligible_approvers ?? []).some((person) => person.principal_id === me);
}

/** A date as people say it: "Oct 25", with the year only when it is not this one. */
export function dayOf(iso: string, now = new Date()): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
