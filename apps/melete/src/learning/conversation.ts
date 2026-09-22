/**
 * A correction made the way people actually make one.
 *
 * Until now the only way to teach anything was to call the intervention route
 * with a correction in hand. Nobody does that. What people do is read an answer
 * and either mark it wrong and say what they wanted, or reply to it as a
 * correction. Those two shapes, and only those, are read here as a correction
 * and handed to the same episode path the route uses:
 *
 * - a thumbs-down on the latest answer, then the next message the person sends;
 * - a message the person sent as a correction of the latest answer (`corrects`).
 *
 * Every rule below is decided from recorded events: which glyph was left on
 * which message, by whom, in what order, and what the person said their message
 * corrects. No model is asked whether something was a correction, because a
 * model that can decide what counts as teaching can be talked into it. A plain
 * message on its own is never a correction: "actually, make it two paragraphs"
 * and "thanks, now do the next one" are the same shape to a reader and mean
 * opposite things to learning.
 *
 * The answer corrected has to be the latest one on the job, because the output
 * the episode records as "what was wrong" is the latest ended attempt's.
 */
import { jsonObject, messageId, THUMBS_DOWN } from '@melete/contracts';
import { and, desc, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import { attempt, event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { isAssistantMessage } from '../jobs/reactions.ts';
import type { JobRow } from '../jobs/service.ts';
import type { SubmissionService } from '../jobs/submissions.ts';
import { requestPrincipal } from '../principals/authority.ts';
import type { EpisodeService } from './episodes.ts';
import { learningJob } from './schema.ts';

/** The longest correction the intervention contract will take. */
const MAX_CORRECTION_CHARS = 8000;

export type ConversationCorrection = {
  text: string;
  messageSeq: number;
  /** The answer the person marked, by its message id. */
  marked: string;
  signal: 'thumbs_down' | 'reply';
};

const field = (payload: unknown, key: string): string => {
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
};

/** True when `marked` is something the assistant said on this job, in its latest ended attempt. */
async function isLatestAnswer(tx: Transaction, row: JobRow, marked: string) {
  if (!messageId.safeParse(marked).success) return false;
  const [answer] = await tx
    .select({ attemptId: event.attemptId })
    .from(event)
    .where(and(eq(event.seq, Number(marked)), eq(event.jobId, row.id)));
  if (!answer || !isAssistantMessage(answer)) return false;
  const [latest] = await tx
    .select({ id: attempt.id })
    .from(attempt)
    .where(and(eq(attempt.jobId, row.id), isNotNull(attempt.endedAt)))
    .orderBy(desc(attempt.epoch))
    .limit(1);
  return !!latest && latest.id === answer.attemptId;
}

/**
 * The correction the person's newest message makes, or null when it is
 * anything else.
 */
export async function conversationCorrection(
  tx: Transaction,
  row: JobRow,
): Promise<ConversationCorrection | null> {
  // Learning follows a job at all only when it carries a scope: an automation or
  // a public compartment has none, and a correction on one teaches nothing.
  const [registration] = await tx.select().from(learningJob).where(eq(learningJob.jobId, row.id));
  if (!registration) return null;
  const [message] = await tx
    .select({ seq: event.seq, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, row.id),
        eq(event.type, 'notice'),
        sql`${event.payload}->>'kind' = 'user_message'`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  if (!message) return null;
  const payload = jsonObject.parse(message.payload);
  const said = field(payload, 'text').trim();
  if (!said || said.length > MAX_CORRECTION_CHARS) return null;
  // The person replied to an answer as a correction of it.
  const named = field(payload, 'corrects');
  if (named)
    return (await isLatestAnswer(tx, row, named))
      ? { text: said, messageSeq: message.seq, marked: named, signal: 'reply' }
      : null;
  // The newest thumbs-down the person left on this job, before that message.
  const [reaction] = await tx
    .select({ seq: event.seq, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.jobId, row.id),
        eq(event.type, 'reaction'),
        lt(event.seq, message.seq),
        sql`${event.payload}->>'by' = 'person'`,
        sql`${event.payload}->>'emoji' = ${THUMBS_DOWN}`,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(1);
  if (!reaction) return null;
  // "The message that follows it": another message in between means this one
  // answers that, not the thumbs-down, and the pair has already been spent.
  const [between] = await tx
    .select({ seq: event.seq })
    .from(event)
    .where(
      and(
        eq(event.jobId, row.id),
        eq(event.type, 'notice'),
        gt(event.seq, reaction.seq),
        lt(event.seq, message.seq),
        sql`${event.payload}->>'kind' = 'user_message'`,
      ),
    )
    .limit(1);
  if (between) return null;
  const marked = field(jsonObject.parse(reaction.payload), 'message_id');
  if (!(await isLatestAnswer(tx, row, marked))) return null;
  return { text: said, messageSeq: message.seq, marked, signal: 'thumbs_down' };
}

/**
 * Records the correction the newest message makes, if it makes one. The message
 * itself is already on the stream, so the episode does not write it again, and
 * the job is already awake with it, so nothing is interrupted.
 */
export async function captureConversationCorrection(
  tx: Transaction,
  episodes: EpisodeService,
  row: JobRow,
  principalId: string | null,
): Promise<string | null> {
  if (!principalId) return null;
  const found = await conversationCorrection(tx, row);
  if (!found) return null;
  const saved = await episodes.interveneInTransaction(
    tx,
    principalId,
    row.id,
    {
      idempotency_key: `conversation:${found.messageSeq}`,
      kind: 'correction',
      text: found.text,
    },
    { recordMessage: false },
  );
  return saved.id;
}

/**
 * Wires the capture onto accepted input, wherever that input came from: the
 * conversation, the responsibility API, or a queued answer. A capture that
 * cannot run rolls back to its savepoint and the message stands — a correction
 * that fails to teach must never cost the person the thing they said.
 */
export function attachConversationCorrections(
  submissions: SubmissionService,
  episodes: EpisodeService,
  onError?: (error: unknown) => void,
): void {
  const previous = submissions.onAccepted;
  submissions.onAccepted = async (tx, receipt, row, kind) => {
    await previous?.(tx, receipt, row, kind);
    if (kind !== 'input') return;
    try {
      // Whoever is speaking, not whoever owns the job: a member's message in a
      // shared space is refused by the learning space check rather than recorded
      // as though the owner had said it.
      const actor = requestPrincipal() ?? row.principalId;
      await tx.transaction((capture) =>
        captureConversationCorrection(capture, episodes, row, actor),
      );
    } catch (error) {
      onError?.(error);
    }
  };
}
