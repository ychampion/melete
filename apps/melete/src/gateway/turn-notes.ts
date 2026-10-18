/**
 * Short notes the service adds to a conversation turn's model requests, after
 * a tool result, so the agent keeps the person told while it works.
 *
 * - When the service already wrote the person a first line for this turn (an
 *   acknowledgement, `experience/ack.ts`), the agent is told what it said, so
 *   it never says it again.
 * - When a turn has gone `PROGRESS_AFTER_MS` with nothing said to the person,
 *   and a step has just come back, the agent is asked for one line on what it
 *   has found and what is next. Once for each quiet stretch: words to the
 *   person start a new one.
 *
 * A note goes beside the tool result it follows, never into it: tool output
 * is data, and a note inside it would read as a page talking. Each note stays
 * pinned to the result it first followed, and is added there again on every
 * later request of the attempt, so the prompt the provider caches does not
 * change under it.
 *
 * The runner says when an attempt starts, speaks and ends. All of it is held
 * in memory for attempts that are running; nothing is written anywhere.
 */
import type { GatewayProtocol } from './types.ts';

/** How long a turn may go with nothing said to the person before it is asked for a line. */
export const PROGRESS_AFTER_MS = 20_000;

/** How many attempts' notes are kept at most; far more than run at once. */
const KEPT = 1_000;

type Turn = {
  /** When the person was last told anything: the attempt's start, until then. */
  quietSince: number;
  /** A note waiting for the next tool result to follow. */
  pending: string[];
  /** Each tool result's id, with the note that follows it. */
  pinned: Map<string, string>;
  /** The quiet stretch the agent was last asked about, by its start. */
  asked: number | null;
};

const turns = new Map<string, Turn>();

/** The note that keeps an acknowledgement from being said twice. */
export const acknowledgedNote = (said: string): string =>
  // The line is quoted as data: a quote mark in it cannot close the quotation
  // and leave the rest reading as Melete's own instruction.
  `Melete already told the person, in your voice: "${said.replace(/["“”\r\n]+/g, "'")}" Do not say that again or open with a line about what you are doing; carry on with the work and give the answer.`;

/** The note that asks for a line after a quiet stretch. */
export const progressNote = (quietMs: number): string =>
  `About ${Math.round(quietMs / 1000)} seconds have passed with nothing said to the person. Before your next step, tell them in one short, plain sentence what you have found so far and what you will do next. Do not repeat a line you already wrote.`;

/** A conversation turn's attempt has started: the quiet starts now. */
export function turnStarted(attemptId: string, now = Date.now()): void {
  turns.set(attemptId, { quietSince: now, pending: [], pinned: new Map(), asked: null });
  if (turns.size > KEPT) {
    const [oldest] = turns.keys();
    if (oldest) turns.delete(oldest);
  }
}

/** The person was just told something in this turn: the quiet starts again. */
export function turnSpoke(attemptId: string, now = Date.now()): void {
  const turn = turns.get(attemptId);
  if (turn) turn.quietSince = now;
}

/** The service wrote the person a first line for this turn. */
export function turnAcknowledged(attemptId: string, said: string, now = Date.now()): void {
  const turn = turns.get(attemptId);
  if (!turn) return;
  turn.quietSince = now;
  turn.pending.push(acknowledgedNote(said));
}

export function turnEnded(attemptId: string): void {
  turns.delete(attemptId);
}

/** Whether notes are kept for this attempt; for the tests. */
export const followsTurn = (attemptId: string): boolean => turns.has(attemptId);

type Located = { id: string; index: number };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Each tool result in the request, by its call id, with the index of the
 * message a note after it goes before: past the last result in its group,
 * since a provider wants a step's results together.
 */
function toolResults(body: Record<string, unknown>, protocol: GatewayProtocol): Located[] {
  const found: Located[] = [];
  if (protocol === 'chat/completions' || protocol === 'responses') {
    const list = protocol === 'responses' ? body.input : body.messages;
    if (!Array.isArray(list)) return found;
    const isResult = (item: unknown) => {
      const entry = record(item);
      return protocol === 'responses'
        ? entry?.type === 'function_call_output'
        : entry?.role === 'tool';
    };
    for (let index = 0; index < list.length; index++) {
      if (!isResult(list[index])) continue;
      let end = index;
      while (end + 1 < list.length && isResult(list[end + 1])) end++;
      for (let at = index; at <= end; at++) {
        const entry = record(list[at]);
        const id = protocol === 'responses' ? entry?.call_id : entry?.tool_call_id;
        if (typeof id === 'string') found.push({ id, index: end + 1 });
      }
      index = end;
    }
    return found;
  }
  if (protocol === 'messages') {
    const list = body.messages;
    if (!Array.isArray(list)) return found;
    list.forEach((item, index) => {
      const entry = record(item);
      if (entry?.role !== 'user' || !Array.isArray(entry.content)) return;
      for (const part of entry.content) {
        const block = record(part);
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string')
          found.push({ id: block.tool_use_id, index });
      }
    });
  }
  return found;
}

/**
 * The person's message a request ends on, when no step has come back yet: its
 * index, and its words, so a later request finds the same message again.
 */
function endingMessage(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): { index: number; words: string } | null {
  const list = protocol === 'responses' ? body.input : body.messages;
  if (!Array.isArray(list) || !list.length) return null;
  const index = list.length - 1;
  const last = record(list[index]);
  if (last?.role !== 'user') return null;
  if (
    Array.isArray(last.content) &&
    last.content.some((part) => record(part)?.type === 'tool_result')
  )
    return null;
  return { index, words: JSON.stringify(last.content ?? '').slice(0, 400) };
}

/** A note pinned to the person's message, keyed by where it is and what it says. */
const userKey = (index: number, words: string) => `user:${index}:${words}`;

/** The request ends on a step that has just come back. */
function endsOnResult(body: Record<string, unknown>, protocol: GatewayProtocol): boolean {
  const list = protocol === 'responses' ? body.input : body.messages;
  if (!Array.isArray(list)) return false;
  const last = record(list.at(-1));
  if (protocol === 'responses') return last?.type === 'function_call_output';
  if (protocol === 'chat/completions') return last?.role === 'tool';
  return (
    last?.role === 'user' &&
    Array.isArray(last.content) &&
    last.content.some((part) => record(part)?.type === 'tool_result')
  );
}

/**
 * The request with this attempt's notes beside the tool results they follow,
 * and any new note pinned after the latest result. A request with no tool
 * result yet carries no note: the first one waits for a step.
 */
export function withTurnNotes(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
  attemptId: string,
  now = Date.now(),
): Record<string, unknown> {
  const turn = turns.get(attemptId);
  if (!turn) return body;
  const results = toolResults(body, protocol);
  const latest = results.at(-1);
  if (latest && endsOnResult(body, protocol)) {
    const quiet = now - turn.quietSince;
    if (quiet >= PROGRESS_AFTER_MS && turn.asked !== turn.quietSince) {
      turn.asked = turn.quietSince;
      turn.pending.push(progressNote(quiet));
    }
  }
  if (latest && turn.pending.length) {
    const before = turn.pinned.get(latest.id);
    turn.pinned.set(latest.id, [before, ...turn.pending.splice(0)].filter(Boolean).join('\n\n'));
  }
  // An acknowledgement shown before the first step: the note goes beside the
  // person's message, so the first request already knows what was said. Only
  // in the agent's own requests, which carry its tools: a side call of the
  // attempt, such as the engine's compaction summary, also ends on a "user"
  // message, and taking the note there would keep it from the agent.
  const ending =
    latest || !Array.isArray(body.tools) || !body.tools.length
      ? null
      : endingMessage(body, protocol);
  if (ending && turn.pending.length)
    turn.pinned.set(userKey(ending.index, ending.words), turn.pending.splice(0).join('\n\n'));
  if (!turn.pinned.size) return body;
  const sent = protocol === 'responses' ? body.input : body.messages;
  const beside: Located[] = [];
  if (Array.isArray(sent))
    for (const key of turn.pinned.keys()) {
      const [kind, at, ...words] = key.split(':');
      const index = Number(at);
      if (kind !== 'user' || !Number.isInteger(index)) continue;
      const message = record(sent[index]);
      // The same message, where it was: a request that no longer holds it gets no note.
      if (
        message?.role === 'user' &&
        JSON.stringify(message.content ?? '').slice(0, 400) === words.join(':')
      )
        beside.push({ id: key, index: protocol === 'messages' ? index : index + 1 });
    }
  // Where each note goes, latest position first, so earlier indexes hold.
  const placed = [...results.filter((result) => turn.pinned.has(result.id)), ...beside]
    .map((result) => ({ ...result, note: turn.pinned.get(result.id) as string }))
    .sort((a, b) => b.index - a.index);
  if (!placed.length) return body;
  if (protocol === 'messages') {
    const messages = [...(body.messages as unknown[])];
    for (const { index, note } of placed) {
      const message = record(messages[index]) as Record<string, unknown>;
      const content =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : (message.content as unknown[]);
      messages[index] = { ...message, content: [...content, { type: 'text', text: note }] };
    }
    return { ...body, messages };
  }
  const key = protocol === 'responses' ? 'input' : 'messages';
  // The Responses protocol carries the service's own words in the middle of a
  // conversation as a developer message: the ChatGPT plan refuses a system
  // message there, and OpenAI ranks the two the same.
  const role = protocol === 'responses' ? 'developer' : 'system';
  const list = [...(body[key] as unknown[])];
  for (const { index, note } of placed) list.splice(index, 0, { role, content: note });
  return { ...body, [key]: list };
}
