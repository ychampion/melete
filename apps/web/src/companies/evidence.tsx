/**
 * The sentence behind a figure, shown inside the message it came from.
 *
 * The highlight is not decoration and it is not trusted. A span is drawn only
 * when the characters at that span are exactly the quote the item carries —
 * the same arithmetic the service used to admit the item. A span that does not
 * hold is shown as plain text: the message is still the message, and a person
 * reading it is never shown the wrong words under a highlight.
 */

import { messageDate } from './format.ts';
import type { LedgerEvidence, LedgerMessage } from './types.ts';

/** Does the text at this span read exactly as the quote claims? */
export function holds(
  text: string,
  span: Pick<LedgerEvidence, 'quote' | 'start' | 'end'>,
): boolean {
  const { quote, start, end } = span;
  if (quote.length === 0) return false;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return false;
  if (start < 0 || end > text.length) return false;
  if (end - start !== quote.length) return false;
  return text.slice(start, end) === quote;
}

export type Piece = { text: string; quoted: boolean };

/**
 * Cut the message into pieces, marking the spans that hold. Overlapping and
 * out-of-order spans are handled by walking them sorted and skipping any that
 * starts before the last one ended, so no character is ever drawn twice.
 */
export function segment(text: string, spans: LedgerEvidence[]): Piece[] {
  const kept = spans
    .filter((span) => holds(text, span))
    .sort((a, b) => a.start - b.start)
    .filter((span, index, list) => index === 0 || span.start >= (list[index - 1]?.end ?? 0));
  const pieces: Piece[] = [];
  let at = 0;
  for (const span of kept) {
    if (span.start > at) pieces.push({ text: text.slice(at, span.start), quoted: false });
    pieces.push({ text: text.slice(span.start, span.end), quoted: true });
    at = span.end;
  }
  if (at < text.length) pieces.push({ text: text.slice(at), quoted: false });
  return pieces.length > 0 ? pieces : [{ text, quoted: false }];
}

export function EvidenceText({ text, spans }: { text: string; spans: LedgerEvidence[] }) {
  const pieces = segment(text, spans);
  return (
    <p className="evidence-text">
      {pieces.map((piece, index) =>
        piece.quoted ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are a cut of one string, in order
          <mark key={index} className="evidence-mark">
            {piece.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are a cut of one string, in order
          <span key={index}>{piece.text}</span>
        ),
      )}
    </p>
  );
}

/** The message as it arrived: who sent it, what it was called, and when. */
export function MessageCard({
  message,
  spans,
}: {
  message: LedgerMessage;
  spans: LedgerEvidence[];
}) {
  return (
    <div className="evidence-mail">
      <div className="evidence-head">
        <span className="evidence-subject">{message.subject}</span>
        <span className="evidence-meta">
          {message.from} · {messageDate(message.received_at)}
        </span>
      </div>
      <EvidenceText text={message.text} spans={spans} />
    </div>
  );
}
