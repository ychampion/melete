/**
 * Memory extraction asks the model for exact offsets into the evidence text.
 * The model reads that text redacted, so its offsets count placeholders, not
 * the values behind them; its quotes come back rehydrated. Each span is moved
 * to where its quote really is in the original text, the occurrence nearest
 * the offset the model gave. Nothing is trusted that was not already checked:
 * the quote must still appear verbatim, and validation still compares it.
 */
type Span = { start: number; end: number; quote: string };

export function reanchorSpans<T extends { sources?: Span[] }>(
  proposals: T[],
  text: string,
  segmentStart: number,
): T[] {
  for (const proposal of proposals) {
    for (const span of proposal.sources ?? []) {
      if (!span.quote) continue;
      const at = span.start - segmentStart;
      if (
        text.slice(at, at + span.quote.length) === span.quote &&
        span.end - span.start === span.quote.length
      )
        continue;
      let best = -1;
      for (
        let found = text.indexOf(span.quote);
        found >= 0;
        found = text.indexOf(span.quote, found + 1)
      )
        if (best < 0 || Math.abs(found - at) < Math.abs(best - at)) best = found;
      if (best < 0) continue;
      span.start = segmentStart + best;
      span.end = span.start + span.quote.length;
    }
  }
  return proposals;
}
