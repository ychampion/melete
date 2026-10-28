/**
 * Replies to an earlier message.
 *
 * In a long chat the person points back: "book the second one", "make this
 * shorter". A message can name the earlier message it answers (`replies_to`,
 * by its message id), and the agent is shown a short quote of that message
 * with the new one, so it acts on what was pointed at rather than on whatever
 * was said last.
 *
 * The quote is taken once, when the message is accepted, and kept on the
 * message's event. Every later read renders the same words, so a reply in the
 * conversation's history never changes underneath a cached prompt.
 */
import { z } from 'zod';

/** The most characters of the earlier message a reply quotes. */
export const REPLY_QUOTE_MAX_CHARS = 400;

/** Who wrote the message a reply points at. */
export const replyAuthor = z.enum(['person', 'assistant']);
export type ReplyAuthor = z.infer<typeof replyAuthor>;

/** What a reply carries of the message it answers: whose it was, and a short quote of it. */
export const replyQuote = z.strictObject({
  /** The earlier message's id. */
  message_id: z.string().min(1).max(20),
  by: replyAuthor,
  text: z.string().max(REPLY_QUOTE_MAX_CHARS + 1),
});
export type ReplyQuote = z.infer<typeof replyQuote>;

/**
 * The start of `text`, at most `max` characters, cut where a word ends and
 * marked with an ellipsis when anything was left off. A single word longer
 * than the cap is cut where the cap falls.
 */
export function quoteOf(text: string, max = REPLY_QUOTE_MAX_CHARS): string {
  const whole = text.trim().replace(/\s+/g, ' ');
  if (whole.length <= max) return whole;
  const head = whole.slice(0, max);
  const space = head.lastIndexOf(' ');
  // A cut more than halfway back would drop most of the quote for one long word.
  const cut = space > max / 2 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${cut.trimEnd()}…`;
}

/** Whose message the quote is, as the agent reads it. */
const whose = (by: ReplyAuthor): string =>
  by === 'assistant' ? 'something you said earlier' : 'an earlier message of theirs';

/**
 * A reply as the agent reads it: what it answers, quoted, then the message.
 * A message that answers nothing is returned as it is.
 */
export function withReplyQuote(content: string, quote: ReplyQuote | undefined): string {
  if (!quote) return content;
  const quoted = quote.text.split('\n').map((line) => `> ${line}`);
  return [`[Replying to ${whose(quote.by)}:]`, ...quoted, '', content].join('\n');
}
