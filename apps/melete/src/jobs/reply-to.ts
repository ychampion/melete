/**
 * The earlier message a new one replies to (`replies_to`).
 *
 * A message id is a global event seq, so the target is looked up inside the
 * job the reply is sent to and nowhere else: a seq from another job, one that
 * names no message, or one not written yet all read as the same refusal, which
 * tells the caller nothing about what exists elsewhere.
 *
 * What the reply keeps is the quote (`ReplyQuote`), taken now and stored on the
 * reply's own event, so every later read of the conversation shows the agent
 * the same words.
 */
import { jsonObject, messageId, quoteOf, type ReplyQuote } from '@melete/contracts';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { isAssistantMessage } from './reactions.ts';

/** How many of an answer's streamed pieces are read for its quote; the quote is short. */
const PIECES_READ = 400;

const refused = () =>
  new ServiceError(
    'reply_target_invalid',
    'A reply has to name an earlier message in this conversation.',
    400,
  );

/** The text of a message's event, when it has one. */
const textOf = (payload: unknown): string => {
  const parsed = jsonObject.safeParse(payload);
  const text = parsed.success ? parsed.data.text : undefined;
  return typeof text === 'string' ? text : '';
};

/**
 * The quote of the message `id` names in job `jobId`, read under the caller's
 * transaction. Refused (400) unless it is an earlier message of this job: one
 * the person sent, or a streamed answer of one of its attempts.
 */
export async function replyTarget(
  tx: Pick<Transaction, 'select'>,
  jobId: string,
  id: string,
): Promise<ReplyQuote> {
  const parsed = messageId.safeParse(id);
  if (!parsed.success) throw refused();
  const seq = Number(parsed.data);
  const [target] = await tx
    .select({ type: event.type, attemptId: event.attemptId, payload: event.payload })
    .from(event)
    .where(and(eq(event.seq, seq), eq(event.jobId, jobId)))
    .limit(1);
  if (!target) throw refused();
  const payload = jsonObject.safeParse(target.payload);
  if (
    target.type === 'notice' &&
    payload.success &&
    payload.data.kind === 'user_message' &&
    typeof payload.data.text === 'string'
  ) {
    // A message of files alone is still one the person can point back at.
    const text = quoteOf(payload.data.text) || '(files, no words)';
    return { message_id: parsed.data, by: 'person', text };
  }
  if (target.type !== 'text_delta' || !isAssistantMessage(target) || !target.attemptId)
    throw refused();
  // The answer is the text streamed from this piece on, until the attempt
  // stopped to call a tool: the message that piece starts.
  const pieces = await tx
    .select({ type: event.type, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, jobId),
        eq(event.attemptId, target.attemptId),
        gte(event.seq, seq),
        inArray(event.type, ['text_delta', 'tool_call_proposed']),
      ),
    )
    .orderBy(asc(event.seq))
    .limit(PIECES_READ);
  let said = '';
  for (const piece of pieces) {
    if (piece.type !== 'text_delta') break;
    said += textOf(piece.payload);
  }
  const text = quoteOf(said);
  if (!text) throw refused();
  return { message_id: parsed.data, by: 'assistant', text };
}
