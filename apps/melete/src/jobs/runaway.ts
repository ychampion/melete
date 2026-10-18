/**
 * A reply that has started saying the same thing over and over.
 *
 * A model can fall into writing the same block again and again in one reply:
 * a whole letter, then the same letter, until the output limit stops it. This
 * finds that from the text alone, cheaply enough to run as the reply streams,
 * so the turn can be stopped after a few copies instead of the tenth.
 *
 * It is a safety bound on a reply going round in a loop, not a limit on use.
 * What counts is the same long run of paragraphs `RUNAWAY_COPIES` times: at
 * least `MIN_BLOCK_CHARS` of prose that repeats as a whole. Copies are
 * compared by their words, so spacing, line wrapping, punctuation and case do
 * not make two copies different. Repetition a person asks for or that belongs
 * in a reply is left alone: code (inside a fence), tables, list items and short
 * paragraphs never count, so a refrain between different verses or a list
 * with repeated items does not trip it, and the same letter written out for
 * three people is three copies, one short of a loop.
 *
 * Each piece of the reply is read once as it arrives, and paragraphs are only
 * compared when one has ended, so the work grows with the reply's length.
 */

/** How many copies of the same block make a loop: the first and three more. */
export const RUNAWAY_COPIES = 4;
/** How long the repeating block must be, in characters of prose. */
export const MIN_BLOCK_CHARS = 600;
/** The shortest paragraph that can anchor a block. */
const MIN_ANCHOR_CHARS = 120;

/** The line a stopped reply ends on, after its first copy. */
export const RUNAWAY_NOTE =
  'I stopped writing here because I had started repeating the same text. Everything is in the first copy above.';

type Loop = { kept: string; copies: number };
type Paragraph = { start: number; text: string; counted: boolean };

const FENCE = /^\s*(?:```|~~~)/;
const LIST_OR_TABLE = /^\s*(?:[-*+•]\s|\d+[.)]\s|\|)/;

/** A paragraph's words, for comparing copies: no spacing, punctuation or case. */
function words(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A reply's paragraphs, read one ended line at a time as the reply grows. */
class Paragraphs {
  text = '';
  readonly all: Paragraph[] = [];
  /** Each paragraph's comparison key; one that never counts has a key no other has. */
  readonly keys: string[] = [];
  /** The anchors seen `RUNAWAY_COPIES` times or more: the only places a loop can be. */
  readonly candidates: number[][] = [];
  /** Where each paragraph long enough to anchor a block appears, by key. */
  private readonly anchors = new Map<string, number[]>();
  /** The line still being written, and where in the reply it starts. */
  private tail = '';
  private tailStart = 0;
  private fenced = false;
  private current: { start: number; lines: string[]; exempt: boolean } | null = null;

  /**
   * Takes more of the reply; true when a paragraph ended in it. Only the new
   * piece is searched: the reply so far is never read again here.
   */
  add(piece: string): boolean {
    const before = this.all.length;
    this.text += piece;
    let from = 0;
    for (let end = piece.indexOf('\n'); end >= 0; end = piece.indexOf('\n', from)) {
      const line = this.tail + piece.slice(from, end);
      this.line(line, this.tailStart);
      this.tailStart += line.length + 1;
      this.tail = '';
      from = end + 1;
    }
    this.tail += piece.slice(from);
    return this.all.length > before;
  }

  /** The reply has ended: its last line and paragraph are whole. */
  finish(): void {
    if (this.tail) this.line(this.tail, this.tailStart);
    this.tailStart += this.tail.length;
    this.tail = '';
    this.close();
  }

  private line(line: string, start: number): void {
    const fence = FENCE.test(line);
    if (fence) this.fenced = !this.fenced;
    if (!line.trim() && !this.fenced && !fence) {
      this.close();
      return;
    }
    this.current ??= { start, lines: [], exempt: false };
    this.current.lines.push(line);
    if (fence || this.fenced || LIST_OR_TABLE.test(line)) this.current.exempt = true;
  }

  private close(): void {
    const current = this.current;
    if (!current) return;
    this.current = null;
    const text = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const index = this.all.length;
    const counted = !current.exempt;
    this.all.push({ start: current.start, text, counted });
    // A paragraph that never counts never matches another, so no block runs through it.
    const key = counted ? words(text) : `\u0000${index}`;
    this.keys.push(key);
    if (!counted || text.length < MIN_ANCHOR_CHARS) return;
    const at = this.anchors.get(key);
    if (!at) {
      this.anchors.set(key, [index]);
      return;
    }
    at.push(index);
    if (at.length === RUNAWAY_COPIES) this.candidates.push(at);
  }
}

/** The loop in what has been read so far, if there is one. */
function loopIn(read: Paragraphs): Loop | null {
  const { all, keys, text } = read;
  for (const positions of read.candidates) {
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
    let chars = 0;
    for (let at = first - back; at < first + ahead; at++)
      if (all[at]?.counted) chars += all[at]?.text.length ?? 0;
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
    while (end - 1 >= firstEnds && all[end - 1]?.text.endsWith(':')) end--;
    const cut = all[end]?.start ?? text.length;
    return { kept: text.slice(0, cut).trimEnd(), copies };
  }
  return null;
}

/**
 * Whether the text repeats one long block `RUNAWAY_COPIES` times. When it
 * does, `kept` is the text up to where the second copy begins: everything
 * before the loop and its first copy. `complete` says the reply has ended, so
 * its last line and paragraph are whole; before that, only paragraphs a blank
 * line has ended are compared.
 */
export function repeatedBlock(text: string, complete = false): Loop | null {
  const read = new Paragraphs();
  read.add(text);
  if (complete) read.finish();
  return loopIn(read);
}

/**
 * Follows one reply as it streams. `see` takes each piece of text and returns
 * the loop once one shows; it only looks again when a paragraph has ended.
 */
export function runawayWatch() {
  const read = new Paragraphs();
  let found: Loop | null = null;
  return {
    see(piece: string): Loop | null {
      if (!found && read.add(piece)) found = loopIn(read);
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
