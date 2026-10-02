/**
 * How a room's thread is drawn from what the service returns: every person's
 * message in order, each answer of the room's agent placed straight after the
 * message that asked for it, and the live stream folded in. Pure functions, so
 * the same view comes out of a reload and of a stream.
 */
import type { RoomFrame, RoomMessage, RoomRequest, ThreadView } from './api.ts';

/**
 * A person in a room is labelled `Name <email>` by the service, always. The
 * email is what tells two people with the same name apart, so it is shown,
 * never dropped; this only splits the label so the two parts can be set apart.
 */
export function splitLabel(label: string): { name: string; email: string | null } {
  const match = /^(.*\S)\s+<([^<>\s]+@[^<>\s]+)>$/.exec(label.trim());
  if (!match?.[1] || !match[2]) return { name: label.trim(), email: null };
  return { name: match[1], email: match[2] };
}

/** One or two letters for an avatar, from the name part of a label. */
export function initialsOf(label: string): string {
  const { name, email } = splitLabel(label);
  const words = (name || email || '?').split(/\s+/).filter(Boolean);
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

/** Whether the frame changes something only a fresh read of the thread can show. */
export function needsRead(view: ThreadView, frame: RoomFrame): boolean {
  if (frame.kind === 'request') return true;
  const id = frame.message.request_job_id;
  return id !== null && !view.requests.some((request) => request.job_id === id);
}

/** Fold one live frame into the thread: messages directly, the agent's work by a fresh read. */
export function applyFrame(view: ThreadView, frame: RoomFrame): ThreadView {
  return frame.kind === 'message' ? upsertMessage(view, frame.message) : view;
}

const ACTIVE = new Set<Turn['status']>(['queued', 'working', 'streaming', 'needs_you', 'paused']);

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
