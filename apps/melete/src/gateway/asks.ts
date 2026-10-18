/**
 * What the person asked for, said again where the agent works out its answer.
 *
 * The person's message is written once, at the top of a turn, under its own
 * heading. After a few steps it sits behind every page, file and result the
 * agent read since, and the answer drifts from it: a reply asked for in under
 * 120 words came back at 150 once the agent had added a note of its own, and a
 * draft meant to be 200 to 250 words came back at 280. Agent harnesses keep the
 * goal in recent view for this reason. Here the message's words are repeated
 * after the first step's results, and again every few steps, with one line
 * asking that the answer be checked against them before it is given. Once the
 * agent has said more than a one-line plan to the person, no further note is
 * added, so an answer already given is not given again.
 *
 * Read from the request alone, like `long-turn.ts`, and placed like
 * `turn-notes.ts`: beside a step's results and never inside them, at places
 * worked out from the request itself, so every later request of the turn
 * carries the same notes at the same places and the prompt a provider caches
 * does not change under them. Only the words under the message's own heading
 * are repeated, and a request without the agent's tools (the engine's summary
 * of a long conversation) is left alone.
 */
import type { GatewayProtocol } from './types.ts';

/** Every how many rounds of steps the person's words are repeated: after the 1st, 4th, 7th... */
export const ASKS_EVERY = 3;

/** The most of the person's words repeated; a longer message is cut to its sentences that ask for something. */
export const ASKS_MAX_CHARS = 600;

/** The heading the engine writes a new message under: "## From the person", or a room member's quoted name. */
const MESSAGE_HEADING = /^## From (?:the person|"(?:[^"\\]|\\.)*")[ \t]*$/;

/** A limit on length, which then covers the whole reply. */
const LENGTH_LIMIT =
  /\b\d[\d,]*\s*(?:(?:-|–|to)\s*\d[\d,]*\s*)?(?:words?|characters?)\b|\b\d+-word\b/i;

/** A sentence that asks for something checkable: a number, a limit, a format, a name, a must or a must-not. */
const ASKING =
  /\d|\b(?:under|at most|no more than|fewer than|less than|only|exactly|don'?t|do not|never|without|must|sign|cite|source|label|include|format|bullet|table|list|short|brief|sentence|paragraph|words?)\b|\.[a-z]{2,4}\b/i;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The text of a message's content, block by block. */
function texts(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = record(part);
    return block &&
      (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') &&
      typeof block.text === 'string'
      ? [block.text]
      : [];
  });
}

/** The words written under each new-message heading in the text, joined; null when there is none. */
export function messageWords(text: string): string | null {
  const lines = text.split('\n');
  const found: string[] = [];
  let open: string[] | null = null;
  for (const line of lines) {
    if (MESSAGE_HEADING.test(line)) {
      if (open) found.push(open.join('\n'));
      open = [];
    } else if (open) open.push(line);
  }
  if (open) found.push(open.join('\n'));
  const words = found
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return words || null;
}

/** The person's words as repeated: whole when short, else the sentences that ask for something. */
export function askedWords(words: string): string | null {
  const flat = words.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= ASKS_MAX_CHARS) return flat;
  const kept: string[] = [];
  let length = 0;
  for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
    if (!ASKING.test(sentence)) continue;
    if (length + sentence.length + 1 > ASKS_MAX_CHARS) break;
    kept.push(sentence);
    length += sentence.length + 1;
  }
  return kept.length ? kept.join(' … ') : null;
}

/** The note: the person's words, quoted as data, and what to check them for. */
export const asksNote = (asked: string): string =>
  // The words are quoted with their own quote marks softened, so nothing in
  // them can close the quotation and read as the service's instruction.
  `Repeated from the start of this turn, so your answer meets it (not a new message): "${asked.replace(/["“”\r\n]+/g, "'")}" Before you give your answer, check it against each thing asked here, and keep to any length, number or format it sets.${
    LENGTH_LIMIT.test(asked)
      ? ' A length set here covers your whole reply, so keep anything you add around it to one short line.'
      : ''
  }`;

/**
 * Whether the agent's text says something to the person beyond a one-line
 * plan ("I'll run the numbers on the file."): two sentences or more, or a
 * long one. After that, a note asking it to check its answer "before you give
 * it" reads as asking for the answer again: on a bench, a cover letter that
 * had been written was written out a second time, and a reply that had asked
 * a question went on to answer it in a second message.
 */
const SPOKE_CHARS = 160;
function speaks(text: string): boolean {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length > SPOKE_CHARS) return true;
  return (
    flat.split(/(?<=[.!?])\s+(?=\S)/).filter((sentence) => /[\p{L}\p{N}]/u.test(sentence)).length >
    1
  );
}

/** Where in the list, from `from` on, the agent first said something to the person; the list's length when it has not. */
function spokeAt(list: unknown[], from: number): number {
  for (let index = from; index < list.length; index++) {
    const entry = record(list[index]);
    if (entry?.role !== 'assistant') continue;
    if (texts(entry.content).some(speaks)) return index;
  }
  return list.length;
}

type Round = { index: number; insert: number };

/**
 * The rounds of steps after the person's message, each with where a note
 * after its results goes: as a block of the message holding the results
 * (`messages`), or as a message of its own after them.
 */
function rounds(list: unknown[], protocol: GatewayProtocol, from: number): Round[] {
  const found: Round[] = [];
  const isResult = (item: unknown) => {
    const entry = record(item);
    if (protocol === 'responses') return entry?.type === 'function_call_output';
    if (protocol === 'chat/completions') return entry?.role === 'tool';
    return (
      entry?.role === 'user' &&
      Array.isArray(entry.content) &&
      entry.content.some((part) => record(part)?.type === 'tool_result')
    );
  };
  for (let index = from; index < list.length; index++) {
    if (!isResult(list[index])) continue;
    let end = index;
    if (protocol !== 'messages') while (end + 1 < list.length && isResult(list[end + 1])) end++;
    found.push({ index: end, insert: end + 1 });
    index = end;
  }
  return found;
}

/** The request with the person's words repeated after rounds 1, 4, 7... of this turn's steps. */
export function withAsks(
  body: Record<string, unknown>,
  protocol: GatewayProtocol,
): Record<string, unknown> {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return body;
  const key = protocol === 'responses' ? 'input' : 'messages';
  const list = body[key];
  if (!Array.isArray(list)) return body;
  // The latest message carrying a new-message heading starts this turn.
  let from = -1;
  let words: string | null = null;
  for (let index = list.length - 1; index >= 0 && from === -1; index--) {
    const entry = record(list[index]);
    if (entry?.role !== 'user') continue;
    for (const text of texts(entry.content)) {
      const found = messageWords(text);
      if (found) {
        from = index + 1;
        words = found;
      }
    }
  }
  const asked = words ? askedWords(words) : null;
  if (!asked) return body;
  // Once the agent has spoken to the person, no later note: its places are
  // fixed by the request, so the notes before then stay where they were.
  const spoke = spokeAt(list, from);
  const pinned = rounds(list, protocol, from).filter(
    ({ index }, round) => round % ASKS_EVERY === 0 && index < spoke,
  );
  if (!pinned.length) return body;
  const note = asksNote(asked);
  const next = [...list];
  // Latest place first, so the earlier places hold.
  for (const { index, insert } of [...pinned].reverse()) {
    if (protocol === 'messages') {
      const message = record(next[index]) as Record<string, unknown>;
      next[index] = {
        ...message,
        content: [...(message.content as unknown[]), { type: 'text', text: note }],
      };
    } else {
      // The Responses protocol carries the service's own words mid-conversation as a developer message.
      next.splice(insert, 0, {
        role: protocol === 'responses' ? 'developer' : 'system',
        content: note,
      });
    }
  }
  return { ...body, [key]: next };
}
