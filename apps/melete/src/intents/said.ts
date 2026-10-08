/**
 * What in a message the person said themselves, and whether they said a value
 * as something they want.
 *
 * A person's message can carry someone else's words: a quoted line, a
 * forwarded email, a reply chain, pasted headers, or a copied email or long
 * passage with no marker at all. Those are outside content, whoever pasted
 * them, so only the person's own lines count. The markers are memory
 * capture's (`QUOTED`, `FORWARDED`): a message that opens as a paste has no
 * words of the person's at all, and everything from a forward or reply marker
 * onward is left out. Without a marker, a paste is told by its shape
 * (`pastedLines`), and text the composer saw pasted is left out as it is.
 * Where the shape is unsure, the text counts as pasted: that only costs a
 * warning on the card. A value the person states again in their own lines is
 * theirs.
 *
 * A value said is a value wanted only when it is not ruled out where it is said:
 * "not Haidilao this time" names Haidilao, and does not ask for it.
 */
import { saysVerbatim } from '../memory/broker-trust.ts';
import { FORWARDED, QUOTED } from '../memory/capture.ts';

/** A stretch of a message, by UTF-16 offsets into its text, that the composer saw pasted. */
export type Span = { start: number; end: number };

/** Header lines a pasted email carries. */
const HEADER = /^\s*(?:from|to|cc|bcc|sent|date|subject|reply-to):\s/i;
/** Header lines of an email copied from a mail app's view: "Dana <dana@acme.test>", "to me", its date. */
const VIEW_HEADER = [
  /^[^<>\n]{0,80}<[^<>\s@]+@[^<>\s]+>\s*$/,
  /^\s*(?:to|cc|bcc)\s+me\b/i,
  /\(\s*\d+\s+(?:minutes?|hours?|days?|weeks?)\s+ago\s*\)\s*$/i,
  /^\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+[a-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}(?:,|\s+at)\s+\d{1,2}:\d{2}/i,
];
/** A forward, a reply chain, or a pasted separator, from which nothing is the person's. */
const PASTE_STARTS = /^\s*(?:-{3,}|_{3,}|begin forwarded|forwarded message|original message)/i;
/** A letter's greeting: "Hi Dana,", "Hello all,", "Dear Ms Lee". One to Melete is the person's. */
const GREETING =
  /^\s*(?:(?:hi|hello|hey|greetings|good (?:morning|afternoon|evening))(?:\s+[\p{L}'.-]+){0,3}\s*[,:!]|dear(?:\s+[\p{L}'.-]+){1,4}\s*[,:!]?)\s*$/iu;
/** A letter's sign-off, alone on its line. */
const SIGN_OFF =
  /^\s*(?:thanks|thank you|many thanks|thanks again|thx|best|best wishes|best regards|kind regards|warm regards|regards|cheers|sincerely|yours(?: truly| sincerely)?|warmly|all the best|talk soon)\s*[,!.]?\s*$/i;
/** A name under a sign-off. */
const NAME = /^[\s~–—-]*\p{L}[\p{L}'.\s-]{0,40}$/u;
/** Something in a signature: an address, a phone number, a link. */
const CONTACT = /@|\+?\d[\d\s().-]{6,}\d|https?:\/\/|www\.|\.(?:com|org|net|io)\b/i;
/** Words that point at what was pasted: a person's lead-in to it. */
const REFERS = /\b(?:this|these|it|that|below|above|following|attached|forwarded|pasted)\b/i;
/** A paragraph this long, by lines or by characters, reads as pasted rather than said. */
const LONG_LINES = 6;
const LONG_CHARS = 400;

const blank = (line: string | undefined) => !line?.trim();
const wordCount = (line: string) => line.trim().split(/\s+/).filter(Boolean).length;
const toMelete = (line: string) => /\bmelete\b/i.test(line);
const nameLine = (line: string | undefined) =>
  line !== undefined && NAME.test(line) && wordCount(line) <= 4 && !toMelete(line);
const signatureLine = (line: string | undefined) =>
  line !== undefined && !blank(line) && line.trim().length <= 60 && !/\?\s*$/.test(line);
/** A line of a set-apart signature: a way to reach someone, or a name, title or company. */
const cardLine = (line: string) =>
  (CONTACT.test(line) && wordCount(line) <= 3) ||
  (wordCount(line) <= 5 && !/[\d$£€¥?!]|[.]\s*$/.test(line));
const opensLetter = (line: string) =>
  HEADER.test(line) ||
  VIEW_HEADER.some((pattern) => pattern.test(line)) ||
  (GREETING.test(line) && !toMelete(line));
/** A line that ends asking or introducing: "Can you deal with this?", "Handle this:". */
const asks = (line: string | undefined) =>
  line !== undefined && line.trim().length <= 200 && /[:?]\s*$/.test(line);
/** A short paragraph that introduces a paste rather than being part of it. */
const leadIn = (lines: string[]) => {
  const text = lines.join(' ').trim();
  return lines.length <= 2 && text.length <= 200 && (/[:?]$/.test(text) || REFERS.test(text));
};

/** The paragraphs of lines[from, to), as [first, end) line ranges. */
function paragraphs(lines: string[], from = 0, to = lines.length): [number, number][] {
  const found: [number, number][] = [];
  for (let at = from; at < to; ) {
    if (blank(lines[at])) {
      at++;
      continue;
    }
    let end = at;
    while (end < to && !blank(lines[end])) end++;
    found.push([at, end]);
    at = end;
  }
  return found;
}

/** Where a letter that signs off on line `at` ends: past its name and signature. */
function signatureEnd(lines: string[], at: number): number {
  let end = at + 1;
  while (end < lines.length && signatureLine(lines[end])) end++;
  // A signature set apart by a blank line: a few short lines with a way to reach someone.
  let next = end;
  while (next < lines.length && blank(lines[next])) next++;
  let after = next;
  while (after < lines.length && signatureLine(lines[after]) && cardLine(lines[after] ?? ''))
    after++;
  const block = lines.slice(next, after);
  const closes = after >= lines.length || blank(lines[after]);
  if (block.length && block.length <= 6 && closes && block.some((line) => CONTACT.test(line)))
    return after;
  return end;
}

/**
 * Which lines of a message were pasted rather than said, told by shape alone:
 * - a letter, from a greeting or email headers (written out, or as a mail app
 *   shows them) to its sign-off and signature, or to the end when it never
 *   signs off;
 * - a sign-off over a name with no greeting before it: the letter runs from
 *   the top, after a short lead-in of the person's ("Can you deal with this?");
 * - a long paragraph, by lines or by characters, after a lead-in line.
 * The person's lines before and after a paste stay theirs.
 */
export function pastedLines(lines: string[]): boolean[] {
  const pasted = lines.map(() => false);
  const mark = (from: number, to: number) => {
    for (let at = from; at < to; at++) pasted[at] = true;
  };
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    if (opensLetter(line)) {
      let close = at + 1;
      while (close < lines.length && !SIGN_OFF.test(lines[close] ?? '')) close++;
      const end = close < lines.length ? signatureEnd(lines, close) : lines.length;
      mark(at, end);
      at = end - 1;
    } else if (SIGN_OFF.test(line) && nameLine(lines[at + 1])) {
      // A letter with no greeting runs from the top, or from the last paste before it.
      let base = at;
      while (base > 0 && !pasted[base - 1]) base--;
      const blocks = paragraphs(lines, base, at);
      const first = blocks[0];
      let from = base;
      if (first && blocks.length > 1 && leadIn(lines.slice(first[0], first[1]))) from = first[1];
      else if (first && asks(lines[first[0]])) from = first[0] + 1;
      const end = signatureEnd(lines, at);
      mark(from, end);
      at = end - 1;
    }
  }
  for (const [first, end] of paragraphs(lines)) {
    const block = lines.slice(first, end);
    if (block.length < LONG_LINES && block.join('\n').length < LONG_CHARS) continue;
    mark(block.length > 1 && asks(block[0]) ? first + 1 : first, end);
  }
  return pasted;
}

/**
 * The person's own lines of a message: quotes, forwards, pasted headers,
 * letters and long passages left out, by the message's own shape. With
 * `pasted`, the stretches the composer saw pasted are cut from those lines as
 * well, each leaving a break. They are cut after the shape is read, from the
 * message as sent, so they can only take words away: a stretch that covers a
 * greeting, a sign-off or a forward line leaves the paste it opens or closes
 * found all the same.
 */
export function ownWords(text: string, pasted: readonly Span[] = []): string {
  if (!text.trim() || QUOTED.test(text.trim())) return '';
  const spans = pasted.filter(
    (span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start,
  );
  const lines: { text: string; at: number }[] = [];
  let at = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (FORWARDED.test(line) || PASTE_STARTS.test(line)) break;
    // A quoted line keeps its place as a break between paragraphs.
    lines.push({ text: /^\s*>/.test(line) ? '' : line, at });
    at += raw.length + 1;
  }
  const pastedLine = pastedLines(lines.map((line) => line.text));
  const kept = lines
    .filter((_, index) => !pastedLine[index])
    .map((line) => {
      if (!spans.length) return line.text;
      let out = '';
      for (let index = 0; index < line.text.length; index++) {
        const offset = line.at + index;
        out += spans.some((span) => offset >= span.start && offset < span.end)
          ? '\n'
          : line.text[index];
      }
      return out;
    });
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Words that rule out what follows them, up to two words on. */
const RULED_OUT =
  /\b(?:not|no|never|without|except|avoid|avoiding|instead of|rather than|anything but|other than|isn't|aren't|don't|doesn't|won't|can't)\s+(?:[^\s.,;:!?]+\s+){0,2}$/i;

/**
 * Whether `value` appears in `text` as itself, at least once where nothing in
 * the same clause just before it rules it out.
 */
export function saysWanted(text: string, value: string): boolean {
  const haystack = text.toLowerCase();
  const needle = value.trim().toLowerCase();
  if (!needle) return false;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    // The same boundary rule as everywhere else: not inside a longer word or address.
    const window = text.slice(Math.max(0, at - 1), at + needle.length + 2);
    if (!saysVerbatim(window, value)) continue;
    const clause =
      text
        .slice(0, at)
        .split(/[.!?;\n]/)
        .at(-1) ?? '';
    if (!RULED_OUT.test(clause)) return true;
  }
  return false;
}

/**
 * Whether a number appears as a number of its own: never a piece of a time
 * ("6:30"), a grouped or decimal amount ("4,800", "1.5") or a longer number.
 */
export function saysNumber(text: string, n: number): boolean {
  if (!Number.isFinite(n)) return false;
  const digits = String(n).replace('.', '\\.');
  const own = new RegExp(`(?<![\\d.,:$£€¥])${digits}(?![\\d]|[.,:]\\d)`, 'g');
  for (const match of text.matchAll(own)) {
    const clause =
      text
        .slice(0, match.index)
        .split(/[.!?;\n]/)
        .at(-1) ?? '';
    if (!RULED_OUT.test(clause)) return true;
  }
  return false;
}
