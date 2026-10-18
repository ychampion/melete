/**
 * A reply that has started saying the same thing over and over.
 *
 * A model can fall into writing the same block again and again in one reply:
 * a whole letter, then the same letter, until the output limit stops it. This
 * finds that from the text alone, cheaply enough to run as the reply streams,
 * so the turn can be stopped after the first copy instead of the tenth.
 *
 * It is a safety bound on a reply going round in a loop, not a limit on use.
 * What counts is the same long run of paragraphs, word for word, three times:
 * at least `MIN_BLOCK_CHARS` of prose that repeats as a whole. Repetition a
 * person asks for or that belongs in a reply is left alone: code (inside a
 * fence), tables, list items and short paragraphs never count, so a refrain
 * between different verses or a list with repeated items does not trip it.
 */

/** How many copies of the same block make a loop: the first and two more. */
export const RUNAWAY_COPIES = 3;
/** How long the repeating block must be, in characters of prose. */
export const MIN_BLOCK_CHARS = 600;
/** The shortest paragraph that can anchor a block. */
const MIN_ANCHOR_CHARS = 120;

/** The line a stopped reply ends on, after its first copy. */
export const RUNAWAY_NOTE =
  'I stopped writing here because I had started repeating the same text. Everything is in the first copy above.';

type Paragraph = { start: number; key: string; counted: boolean };

const FENCE = /^\s*(?:```|~~~)/;
const LIST_OR_TABLE = /^\s*(?:[-*+•]\s|\d+[.)]\s|\|)/;

/** The complete paragraphs of `text`, each with where it starts and a comparison key. */
function paragraphs(text: string, complete: boolean): Paragraph[] {
  const found: Paragraph[] = [];
  let fenced = false;
  let current: { start: number; lines: string[]; exempt: boolean } | null = null;
  let offset = 0;
  const close = () => {
    if (!current) return;
    const key = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    found.push({ start: current.start, key, counted: !current.exempt });
    current = null;
  };
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const fence = FENCE.test(line);
    if (fence) fenced = !fenced;
    if (!line.trim() && !fenced && !fence) close();
    else {
      current ??= { start: offset, lines: [], exempt: false };
      current.lines.push(line);
      if (fence || fenced || LIST_OR_TABLE.test(line)) current.exempt = true;
    }
    offset += line.length + (index < lines.length - 1 ? 1 : 0);
  }
  // The paragraph still being written is not compared until it ends.
  if (complete) close();
  return found;
}

/**
 * Whether the text repeats one long block `RUNAWAY_COPIES` times. When it
 * does, `kept` is the text up to where the second copy begins: everything
 * before the loop and its first copy. `complete` says the reply has ended, so
 * its last paragraph is whole.
 */
export function repeatedBlock(
  text: string,
  complete = false,
): { kept: string; copies: number } | null {
  const all = paragraphs(text, complete);
  const keys = all.map((paragraph, index) =>
    // A paragraph that never counts never matches another, so no block runs through it.
    paragraph.counted ? paragraph.key : `\u0000${index}`,
  );
  const seen = new Map<string, number[]>();
  for (const [index, key] of keys.entries()) {
    if (!all[index]?.counted || key.length < MIN_ANCHOR_CHARS) continue;
    const at = seen.get(key) ?? [];
    at.push(index);
    seen.set(key, at);
  }
  for (const positions of seen.values()) {
    if (positions.length < RUNAWAY_COPIES) continue;
    const [first, second] = positions as [number, number];
    const period = second - first;
    // The whole repeating block around the anchor: back while the paragraphs
    // before both copies agree, forward while those after agree, never more
    // than the distance between the copies.
    let back = 0;
    while (
      back + 1 < period &&
      first - back - 1 >= 0 &&
      keys[first - back - 1] === keys[second - back - 1]
    )
      back++;
    let ahead = 1;
    while (back + ahead < period && keys[first + ahead] === keys[second + ahead]) ahead++;
    const block = keys.slice(first - back, first + ahead);
    const chars = block.reduce((sum, key) => sum + (key.startsWith('\u0000') ? 0 : key.length), 0);
    if (chars < MIN_BLOCK_CHARS) continue;
    // Count the copies of the whole block, at each place the anchor recurs,
    // never letting two copies share a paragraph.
    let copies = 0;
    let free = 0;
    for (const position of positions) {
      const from = position - back;
      if (from < free) continue;
      if (block.every((key, offset) => keys[from + offset] === key)) {
        copies++;
        free = from + block.length;
      }
    }
    if (copies < RUNAWAY_COPIES) continue;
    // A line just before the second copy that only introduces it ("Here's the
    // letter again:") goes with what was cut.
    let end = second - back;
    const firstEnds = first - back + block.length;
    while (end - 1 >= firstEnds && all[end - 1]?.key.endsWith(':')) end--;
    const cut = all[end]?.start ?? text.length;
    return { kept: text.slice(0, cut).trimEnd(), copies };
  }
  return null;
}

/**
 * Follows one reply as it streams. `see` takes each piece of text and returns
 * the loop once one shows; it only looks again when a paragraph has ended.
 */
export function runawayWatch() {
  let text = '';
  let found: { kept: string; copies: number } | null = null;
  return {
    see(piece: string): { kept: string; copies: number } | null {
      text += piece;
      if (!found && piece.includes('\n')) found = repeatedBlock(text);
      return found;
    },
  };
}

/** The reason a turn was stopped for repeating itself, carrying what it keeps. */
export class RunawayReply extends Error {
  constructor(
    readonly kept: string,
    readonly copies: number,
  ) {
    super('The reply kept repeating the same text.');
    this.name = 'RunawayReply';
  }
}
