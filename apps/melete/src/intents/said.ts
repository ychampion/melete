/**
 * What in a message the person said themselves, and whether they said a value
 * as something they want.
 *
 * A person's message can carry someone else's words: a quoted line, a
 * forwarded email, a reply chain, pasted headers. Those are outside content,
 * whoever pasted them, so only the person's own lines count. The markers are
 * memory capture's (`QUOTED`, `FORWARDED`): a message that opens as a paste has
 * no words of the person's at all, and everything from a forward or reply
 * marker onward is left out. Text pasted with no marker at all cannot be told
 * apart from the person's own and counts as theirs.
 *
 * A value said is a value wanted only when it is not ruled out where it is said:
 * "not Haidilao this time" names Haidilao, and does not ask for it.
 */
import { saysVerbatim } from '../memory/broker-trust.ts';
import { FORWARDED, QUOTED } from '../memory/capture.ts';

/** Header lines a pasted email carries. */
const HEADER = /^\s*(?:from|to|cc|bcc|sent|date|subject|reply-to):\s/i;
/** A forward, a reply chain, or a pasted separator, from which nothing is the person's. */
const PASTE_STARTS = /^\s*(?:-{3,}|_{3,}|begin forwarded|forwarded message|original message)/i;

/** The person's own lines of a message: quotes, forwards and pasted headers left out. */
export function ownWords(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || QUOTED.test(trimmed)) return '';
  const kept: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (FORWARDED.test(line) || PASTE_STARTS.test(line) || HEADER.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
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
