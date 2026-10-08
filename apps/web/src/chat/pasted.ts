/**
 * Which stretches of a message the person pasted rather than typed. The box
 * keeps what each paste put in; on send, each one still in the message is
 * found there, and its place goes with the message, so what the person pasted
 * is read as someone else's words.
 */
export type PastedSpan = { start: number; end: number };

/** Where each pasted piece sits in `text`, each place used once, in order. */
export function pastedSpans(text: string, pieces: readonly string[]): PastedSpan[] {
  const spans: PastedSpan[] = [];
  const taken = (start: number, end: number) =>
    spans.some((span) => start < span.end && span.start < end);
  for (const piece of pieces) {
    const needle = piece.trim();
    if (!needle) continue;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      if (taken(at, at + needle.length)) continue;
      spans.push({ start: at, end: at + needle.length });
      break;
    }
  }
  return spans.sort((a, b) => a.start - b.start).slice(0, 50);
}
