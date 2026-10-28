/**
 * Replying to one earlier message in the chat, the person's or the agent's.
 *
 * Choosing Reply on a message holds it above the composer as a short quote;
 * sending names it as `replies_to`. A sent reply shows the quote the service
 * kept on its event, or, until that arrives, the words of the message it
 * points at as this transcript has them.
 */
import type { ReplyQuote } from '@melete/contracts';
import {
  answerOf,
  reactionMessageSeq,
  type Transcript,
  type TranscriptTurn,
} from '../experience/reduce.ts';

/** How many characters of the earlier message the chip and a sent reply show. */
export const REPLY_SHOWN_CHARS = 140;

/** The start of `text` on one line, cut where a word ends, with an ellipsis when cut. */
export function shortQuote(text: string, max = REPLY_SHOWN_CHARS): string {
  const whole = text.trim().replace(/\s+/g, ' ');
  if (whole.length <= max) return whole;
  const head = whole.slice(0, max);
  const space = head.lastIndexOf(' ');
  const cut = space > max / 2 ? head.slice(0, space) : head.slice(0, max - 1);
  return `${cut.trimEnd()}…`;
}

/**
 * The id of the person's message that opened `turn`, once the job stream has
 * named it. Words added while the turn ran carry its id too; they come later,
 * so the earliest is the opening message.
 */
export function personMessageId(transcript: Transcript, turn: TranscriptTurn): string | null {
  let found: number | null = null;
  for (const [key, message] of Object.entries(transcript.messages)) {
    if (message.author !== 'person' || message.conversationId !== turn.turn.conversation_id)
      continue;
    const mine =
      message.turnId !== null
        ? message.turnId === turn.id
        : message.text === turn.turn.text && message.createdAt === turn.turn.created_at;
    const seq = Number(key);
    if (mine && (found === null || seq < found)) found = seq;
  }
  return found === null ? null : String(found);
}

/** What the person's message says, or that it was files alone. */
const personWords = (turn: TranscriptTurn): string => turn.turn.text.trim() || '(files, no words)';

/**
 * The message a Reply on `turn` points at: the person's message (`person`) or
 * the agent's finished answer (`assistant`). Null while it has no id yet.
 */
export function replyTarget(
  transcript: Transcript,
  turn: TranscriptTurn,
  by: ReplyQuote['by'],
): ReplyQuote | null {
  if (by === 'person') {
    const id = personMessageId(transcript, turn);
    return id ? { message_id: id, by, text: shortQuote(personWords(turn)) } : null;
  }
  const seq = reactionMessageSeq(turn);
  return seq === null ? null : { message_id: String(seq), by, text: shortQuote(answerOf(turn)) };
}

/** The words of message `id` as this transcript has them, when it has them. */
export function messageWords(transcript: Transcript, id: string): string | null {
  const message = transcript.messages[id];
  if (!message) return null;
  const turn = transcript.turns.find((entry) =>
    message.turnId !== null
      ? entry.id === message.turnId
      : entry.turn.text === message.text && entry.turn.created_at === message.createdAt,
  );
  if (!turn) return message.text;
  return message.author === 'person' ? personWords(turn) : answerOf(turn) || message.text;
}

/**
 * The quote drawn above `turn`'s message when it replied to an earlier one:
 * the service's quote when its event carries one, else the earlier message's
 * words from this transcript, else what was drawn when it was sent here.
 */
export function shownReply(transcript: Transcript, turn: TranscriptTurn): ReplyQuote | null {
  const id = personMessageId(transcript, turn);
  const message = id ? transcript.messages[id] : undefined;
  if (message?.replyQuote)
    return { ...message.replyQuote, text: shortQuote(message.replyQuote.text) };
  const target = message?.repliesTo ?? turn.reply?.message_id;
  if (!target) return null;
  const words = messageWords(transcript, target) ?? turn.reply?.text;
  if (!words) return null;
  const by = transcript.messages[target]?.author ?? turn.reply?.by ?? 'assistant';
  return { message_id: target, by, text: shortQuote(words) };
}

/** Draws the reply's quote on a message sent here, before the service has it. */
export function withLocalReply(
  transcript: Transcript,
  turnId: string,
  reply: ReplyQuote,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => (turn.id === turnId ? { ...turn, reply } : turn)),
  };
}

/** Escape in the composer lets go of the message being replied to. */
export const cancelsReply = (key: string, replying: boolean): boolean =>
  replying && key === 'Escape';
