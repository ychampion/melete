/**
 * Reactions on messages.
 *
 * A message is an event, so a reaction is an event about an event: the same
 * durable row, the same stream, the same replay. Nothing new is stored that the
 * transcript could not already replay, which is why a reaction survives a
 * reconnect without any bookkeeping of its own.
 *
 * The only side effect is on attention, and only from a person reacting to
 * something an attempt said. A thumbs-down is a read result that missed; a
 * thumbs-up is a read receipt.
 */
import {
  attentionWeightOfReaction,
  type CreateReactionRequest,
  createReactionRequest,
  jsonObject,
  messageId as messageIdContract,
  type Reaction,
  type ReactionBy,
  reaction as reactionContract,
} from '@melete/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { event } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { AttentionService } from './attention.ts';
import type { JobService } from './service.ts';

type EventRow = typeof event.$inferSelect;

/** The dedup key, computed the same way by every writer. Reacting twice writes one row. */
export const reactionDedupKey = (messageId: string, by: ReactionBy, emoji: string): string =>
  `reaction:${messageId}:${by}:${emoji}`;

/**
 * An attempt produced it, so it is the assistant talking. A person's messages
 * arrive as submissions and carry no attempt; service notices carry none
 * either. This is a fact on the row, not a guess about the text.
 */
export const isAssistantMessage = (row: Pick<EventRow, 'attemptId'>): boolean =>
  row.attemptId !== null;

export function reactionView(row: EventRow): Reaction {
  const payload = jsonObject.parse(row.payload);
  return reactionContract.parse({
    message_id: payload.message_id,
    emoji: payload.emoji,
    by: payload.by,
    job_id: row.jobId,
    seq: row.seq,
    created_at: row.createdAt.toISOString(),
  });
}

export class ReactionService {
  constructor(
    readonly jobs: JobService,
    readonly attention?: AttentionService,
  ) {}

  private async message(tx: Transaction, id: string): Promise<EventRow> {
    const seq = Number(messageIdContract.parse(id));
    const [row] = await tx.select().from(event).where(eq(event.seq, seq)).limit(1);
    if (!row) throw new ServiceError('not_found', 'No such message.', 404);
    if (row.type === 'reaction')
      throw new ServiceError('not_reactable', 'A reaction is not a message.', 409);
    return row;
  }

  /**
   * Record one reaction. The attention counters move only when the row is new,
   * so a client retrying a dropped request does not push a job further into
   * frequency reduction than the person actually pushed it.
   */
  async add(id: string, input: CreateReactionRequest): Promise<Reaction> {
    const value = createReactionRequest.parse(input);
    return this.jobs.transaction(async (tx) => {
      const target = await this.message(tx, id);
      const written = await appendEvent(tx, {
        jobId: target.jobId,
        type: 'reaction',
        payload: { message_id: id, emoji: value.emoji, by: value.by },
        dedupKey: reactionDedupKey(id, value.by, value.emoji),
      });
      const weight = attentionWeightOfReaction(value.emoji, value.by);
      if (written && weight && target.jobId && isAssistantMessage(target) && this.attention) {
        const row = await this.jobs.lock(tx, target.jobId);
        if (row) await this.attention.reacted(tx, row, weight);
      }
      if (written) return reactionView(written);
      const [existing] = await tx
        .select()
        .from(event)
        .where(eq(event.dedupKey, reactionDedupKey(id, value.by, value.emoji)))
        .limit(1);
      if (!existing) throw new Error('reaction row disappeared');
      return reactionView(existing);
    });
  }

  /** Everything drawn on one bubble, oldest first. */
  async list(id: string): Promise<Reaction[]> {
    const messageId = messageIdContract.parse(id);
    const rows = await this.jobs.db
      .select()
      .from(event)
      .where(eq(event.type, 'reaction'))
      .orderBy(asc(event.seq));
    return rows
      .filter((row) => jsonObject.parse(row.payload).message_id === messageId)
      .map(reactionView);
  }

  /** Reactions across one job's stream, for a client rendering a whole transcript. */
  async listForJob(jobId: string): Promise<Reaction[]> {
    const rows = await this.jobs.db
      .select()
      .from(event)
      .where(and(eq(event.type, 'reaction'), eq(event.jobId, jobId)))
      .orderBy(asc(event.seq));
    return rows.map(reactionView);
  }
}
