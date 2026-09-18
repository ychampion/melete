/**
 * One canonical form for pasted text and for every quote checked against it.
 *
 * A quote is only ever shown when it is an exact substring of what the person
 * pasted. Email bodies arrive hard-wrapped, with non-breaking spaces and with
 * typographic quotes and dashes that a model retypes as the plain characters,
 * so comparing the raw strings would drop true quotes far more often than
 * false ones. Both sides are folded into the same canonical form first, and
 * the text that gets displayed is sliced out of the canonical haystack, never
 * taken from the model. So what the card shows is always text that is present
 * in the paste.
 *
 * The character classes are written as `new RegExp` sources rather than
 * literals so the code points stay readable as `\uXXXX` in the file instead of
 * becoming invisible characters nobody can see to edit.
 */

/** Every space that is not the space bar. */
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
/** Apostrophes and single quotes in their typographic forms. */
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/g;
/** Double quotes, likewise. */
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/g;
/** Hyphens, dashes and the minus sign. */
const DASHES = /[\u2010-\u2015\u2212]/g;
const ELLIPSIS = /\u2026/g;
/** Zero-width characters, soft hyphens and byte-order marks: present, unseen. */
const INVISIBLE = /[\u200b-\u200d\ufeff\u00ad]/g;
const WHITESPACE = /\s+/g;

/**
 * A break in the text that no sentence was ever written across: a blank line,
 * or the start of a quoted reply. The space either side is taken with it, so
 * the mark sits directly between the two pieces.
 *
 * A single newline is deliberately not one of these. An email wraps a sentence
 * across lines all the time, and refusing to quote across that would drop most
 * true quotes.
 */
const BLANK_LINE = /[^\S\n]*\n(?:[^\S\n]*\n)+[^\S\n]*/g;
const QUOTED_REPLY = /\n[^\S\n]*(?=>)/g;
/**
 * A line that ends where a sentence ends. Wrapping breaks a line in the middle
 * of a sentence, never tidily after the full stop, so this is a line someone
 * chose to end: a table row, a list item, the next question in a list of them.
 * It also means a shown quote is one sentence, which is what it was asked for.
 */
const SENTENCE_END = /(?<=[.!?:]["')\]]?)[^\S\n]*\n[^\S\n]*/g;

/**
 * Stands where a break was. It survives the whitespace collapse, so a span
 * that crosses one carries it and can be refused. The model cannot produce it
 * by accident, and `locate` refuses a quote containing it however it got there.
 */
export const SENTINEL = String.fromCharCode(0);

/** Fold a string into the form every substring check runs against. */
export function canonical(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(SPACES, ' ')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(ELLIPSIS, '...')
    .replace(BLANK_LINE, SENTINEL)
    .replace(QUOTED_REPLY, SENTINEL)
    .replace(SENTENCE_END, SENTINEL)
    .replace(WHITESPACE, ' ')
    .trim();
}

/** The shortest quote worth showing. Below this a match proves nothing. */
export const MIN_QUOTE = 12;
/** A quote longer than this is a paragraph, not a sentence someone can read. */
export const MAX_QUOTE = 400;

export type Located = { quote: string; start: number; end: number };

/**
 * Find `quote` inside `haystack`, both already canonical. Returns the slice of
 * the haystack rather than the caller's string, so the text that travels on is
 * the person's own. Null means the quote was not in the paste, or was too
 * short or too long to be worth showing.
 */
export function locate(haystack: string, quote: string): Located | null {
  const needle = canonical(quote);
  if (needle.length < MIN_QUOTE || needle.length > MAX_QUOTE) return null;
  // A quote that spans a blank line or reaches into a quoted reply was never
  // one sentence, whoever assembled it.
  if (needle.includes(SENTINEL)) return null;
  const start = haystack.indexOf(needle);
  if (start < 0) return null;
  const end = start + needle.length;
  return { quote: haystack.slice(start, end), start, end };
}
