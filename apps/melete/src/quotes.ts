/**
 * Where a quoted passage sits in the text it was quoted from. Models are good
 * at copying words and poor at counting characters, so a side call returns the
 * quote and the service finds its offsets here. Everything after this still
 * checks a verbatim quote: a loose match answers with the text's own
 * characters, never with the model's copy.
 */

const SMART_SINGLE = /[‘’‚‛′]/g;
const SMART_DOUBLE = /[“”„‟″]/g;

/**
 * Where a quote occurs in a text, nearest to `hint`: exactly first, then
 * ignoring differences of whitespace, typographic quotes, case and trailing
 * punctuation. Null when it is not there at all.
 */
export function findQuote(
  text: string,
  quote: string,
  hint = 0,
): { start: number; end: number } | null {
  const nearest = (haystack: string, needle: string) => {
    let best = -1;
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1))
      if (best < 0 || Math.abs(at - hint) < Math.abs(best - hint)) best = at;
    return best;
  };
  if (!quote) return null;
  const exact = nearest(text, quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  // A loose copy of the text, one character at a time, with a map back to it.
  const loose = (value: string) =>
    value.replace(SMART_SINGLE, "'").replace(SMART_DOUBLE, '"').toLowerCase();
  const map: number[] = [];
  let normalized = '';
  for (let i = 0; i < text.length; i++) {
    const char = loose(text[i] ?? '');
    if (/\s/.test(char)) {
      if (normalized.endsWith(' ')) continue;
      normalized += ' ';
      map.push(i);
      continue;
    }
    // Lower case can be longer than the letter ("İ" is two units); each unit maps back to it.
    for (const unit of char.split('')) {
      normalized += unit;
      map.push(i);
    }
  }
  const wanted = loose(quote).replace(/\s+/g, ' ').trim();
  // The hint in the loose copy's own positions.
  const looseHint = Math.max(
    0,
    map.findIndex((position) => position >= hint),
  );
  for (const candidate of [wanted, wanted.replace(/[.!?,;:]+$/, '')]) {
    if (!candidate) continue;
    let best: { start: number; end: number } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (
      let at = normalized.indexOf(candidate);
      at >= 0;
      at = normalized.indexOf(candidate, at + 1)
    ) {
      const start = map[at] ?? 0;
      const end = (map[at + candidate.length - 1] ?? start) + 1;
      // A long run of spaces is where forgotten words were blanked out; a
      // loose match never bridges one, so two separate phrases are never
      // joined into words the person did not write.
      if (BLANKED.test(text.slice(start, end))) continue;
      const distance = Math.abs(at - looseHint);
      if (distance < bestDistance) {
        best = { start, end };
        bestDistance = distance;
      }
    }
    if (best) return best;
  }
  return null;
}

/** Four or more spaces in a row: a blanked-out span, not a typed gap. */
const BLANKED = / {4,}/;

/**
 * A quote placed in its source: the offsets the model gave when they hold
 * the quote exactly, else where the quote is found. `offset` is where `text`
 * begins in the whole source, so the span is in whole-source offsets. Null
 * when the quote is not in the text.
 */
export function placeQuote(
  text: string,
  offset: number,
  span: { quote: string; start?: unknown; end?: unknown },
): { start: number; end: number; quote: string } | null {
  const start = typeof span.start === 'number' ? span.start : undefined;
  const end = typeof span.end === 'number' ? span.end : undefined;
  // Offsets a model gave are used only when they are whole numbers inside the
  // text and span exactly the quote; anything else is found from the quote.
  const usable =
    start !== undefined &&
    end !== undefined &&
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= offset &&
    end - start === span.quote.length &&
    end - offset <= text.length;
  if (usable && span.quote && text.slice(start - offset, end - offset) === span.quote)
    return { start, end, quote: span.quote };
  const hint =
    start !== undefined && Number.isInteger(start) && start >= offset ? start - offset : 0;
  const found = findQuote(text, span.quote, hint);

  if (!found) return null;
  return {
    start: offset + found.start,
    end: offset + found.end,
    quote: text.slice(found.start, found.end),
  };
}
