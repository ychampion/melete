/**
 * One canonical form for pasted text and for every quote checked against it,
 * and a way back from it to the paste.
 *
 * A quote is only ever shown when it is an exact substring of what the person
 * pasted. Two things make that harder than it sounds. Email bodies arrive
 * hard-wrapped, with non-breaking spaces and with typographic quotes and
 * dashes that a model retypes as the plain characters, so comparing the raw
 * strings would drop true quotes far more often than false ones. And text on
 * either side of a blank line, or of a quoted reply, was never written as one
 * sentence, so a match that spans one proves nothing.
 *
 * So both sides are folded into the same form and compared there — but the
 * text that gets displayed is cut from the paste itself, using the offsets the
 * fold records. That is the difference between "word for word from what you
 * pasted", which the page says, and "word for word from our working", which is
 * what comparing in the fold alone would have earned. The fold is used to find
 * a quote; the paste is what is shown.
 */

/** Every space that is not the space bar. */
const SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/;
/** Apostrophes and single quotes in their typographic forms. */
const SINGLE_QUOTES = /[\u2018\u2019\u201a\u201b\u2032]/;
/** Double quotes, likewise. */
const DOUBLE_QUOTES = /[\u201c\u201d\u201e\u201f\u2033]/;
/** Hyphens, dashes and the minus sign. */
const DASHES = /[\u2010-\u2015\u2212]/;
/**
 * Characters that are present but never seen, and characters that change how
 * what is seen is ordered.
 *
 * The second kind matters as much as the first. A right-to-left override makes
 * a browser draw the rest of a quote backwards, so a sentence genuinely in the
 * paste can be made to read as its own opposite — and escaping cannot help,
 * because these are text rather than markup. Nothing in an email from a
 * company needs them, so they go.
 */
const UNSEEN = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g;
/** A base character with whatever combining marks belong to it. */
const CLUSTER = /[\s\S]\p{M}*/gu;
/** What a sentence ends with, allowing for a closing quote or bracket. */
const ENDING = /[.!?:]["')\]]?$/;

/**
 * Stands where a break was: a blank line, the start of a quoted reply, or a
 * line someone chose to end. It survives the whitespace collapse, so a span
 * that crosses one carries it and can be refused. The model cannot produce it
 * by accident, and `locate` refuses a quote containing it however it got there.
 */
export const SENTINEL = String.fromCharCode(0);

export type Folded = {
  /** What was pasted, untouched. Every shown quote is cut from this. */
  source: string;
  /** The form both sides are compared in. */
  text: string;
  /** Where in `source` each character of `text` began. */
  from: number[];
  /** Where in `source` whatever produced each character of `text` ended. */
  to: number[];
};

/**
 * Fold a string, keeping a way back to it.
 *
 * A run of whitespace becomes one character: a space normally, or the mark for
 * a break when the run is a blank line, runs into a quoted reply, or follows a
 * line that ended where a sentence ended. A single newline inside a sentence
 * is none of those — that is an email wrapping — so it folds to a space and
 * quotes across it still work.
 */
export function fold(source: string): Folded {
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];

  const emit = (chars: string, at: number, until: number) => {
    for (const char of chars) {
      out.push(char);
      from.push(at);
      to.push(until);
    }
  };

  /** The whitespace run waiting to be resolved, once we can see past it. */
  let run: { at: number; until: number; text: string } | null = null;

  /** `\r\n` is one line ending, not two, or every wrapped line looks blank. */
  const breaks = (text: string): number =>
    (text.replace(/\r\n/g, '\n').match(/[\n\r]/g) ?? []).length;

  const settle = (next: string) => {
    if (!run) return;
    const { at, until, text } = run;
    run = null;
    // Nothing before it, or nothing after it: it is the trim.
    if (out.length === 0 || next === '') return;
    const lines = breaks(text);
    const broken =
      lines >= 2 || (lines >= 1 && (next === '>' || ENDING.test(out.slice(-2).join(''))));
    emit(broken ? SENTINEL : ' ', at, until);
  };

  for (const match of source.matchAll(CLUSTER)) {
    const cluster = match[0];
    const at = match.index;
    const until = at + cluster.length;
    // Invisibles come out before composing, not after: a zero-width joiner
    // between a letter and its accent would otherwise take the accent with it
    // and the letter would never compose.
    const shaped = cluster.replace(UNSEEN, '').normalize('NFC');
    if (shaped === '') continue;
    const first = shaped[0] ?? '';

    if (/\s/.test(first) || SPACES.test(first)) {
      run = run ? { at: run.at, until, text: run.text + first } : { at, until, text: first };
      continue;
    }

    settle(first);

    if (SINGLE_QUOTES.test(first)) emit("'", at, until);
    else if (DOUBLE_QUOTES.test(first)) emit('"', at, until);
    else if (DASHES.test(first)) emit('-', at, until);
    else if (first === '\u2026') emit('...', at, until);
    else emit(shaped, at, until);
  }
  settle('');

  return { source, text: out.join(''), from, to };
}

/** The fold on its own, for the callers that only need to read the text. */
export const canonical = (text: string): string => fold(text).text;

/** The shortest quote worth showing. Below this a match proves nothing. */
export const MIN_QUOTE = 12;
/** A quote longer than this is a paragraph, not a sentence someone can read. */
export const MAX_QUOTE = 400;

export type Located = { quote: string; start: number; end: number };

/**
 * Find `quote` in a folded paste. What comes back is cut from the paste
 * itself, so it is literally text the person pasted, not a tidied copy of it.
 * Null means it was not there, or was too short or too long to be worth
 * showing, or spanned a break nobody wrote across.
 */
export function locate(folded: Folded, quote: string): Located | null {
  const needle = canonical(quote);
  if (needle.length < MIN_QUOTE || needle.length > MAX_QUOTE) return null;
  // A quote that spans a blank line or reaches into a quoted reply was never
  // one sentence, whoever assembled it.
  if (needle.includes(SENTINEL)) return null;
  const start = folded.text.indexOf(needle);
  if (start < 0) return null;
  const end = start + needle.length;
  const at = folded.from[start];
  const until = folded.to[end - 1];
  if (at === undefined || until === undefined) return null;
  return { quote: folded.source.slice(at, until), start, end };
}
