/**
 * Reactions on messages.
 *
 * A message is an event, so a reaction is an event about an event: the same
 * durable row, the same stream, the same replay. Nothing new is stored that the
 * transcript could not already replay, which is why a reaction survives a
 * reconnect without any bookkeeping of its own.
 *
 * Two things here are authorization rather than behaviour. A message id is a
 * global event seq, so every lookup is scoped to the caller's space before
 * anything is read or written, and a seq outside it reads as absent rather than
 * forbidden, because "you may not touch that" tells the caller it exists. And
 * who reacted is decided by which door the request came through, never by the
 * request: this service is told `by`, it never reads it out of a payload.
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
import { event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { AttentionService } from './attention.ts';
import type { JobService } from './service.ts';

type EventRow = typeof event.$inferSelect;

/** Who is asking. In v0.1 one owner holds one personal space. */
export type ReactionScope = { spaceId: string };

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

/** One sentence for every miss, so absence and refusal are indistinguishable. */
const notFound = (what = 'message') => new ServiceError('not_found', `No such ${what}.`, 404);

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

  /**
   * The message that seq names, if it is one and if it is the caller's.
   *
   * An event outside every job is not a message: a connector observation or a
   * service notice belonging to no responsibility is not something anybody
   * said, and the row carries no space to check it against. Those read as
   * absent too, which is the honest answer and also the safe one.
   */
  private async message(tx: Transaction, scope: ReactionScope, id: string): Promise<EventRow> {
    const parsed = messageIdContract.safeParse(id);
    if (!parsed.success) throw notFound();
    const [row] = await tx
      .select({ message: event, spaceId: job.spaceId })
      .from(event)
      .innerJoin(job, eq(job.id, event.jobId))
      .where(and(eq(event.seq, Number(parsed.data)), eq(job.spaceId, scope.spaceId)))
      .limit(1);
    if (!row || row.spaceId !== scope.spaceId) throw notFound();
    if (row.message.type === 'reaction')
      throw new ServiceError('not_reactable', 'A reaction is not a message.', 409);
    return row.message;
  }

  /**
   * Record one reaction within the authenticated space. Attention moves only
   * for a newly written event, so retries cannot count the same reaction twice.
   */
  async add(scope: ReactionScope, id: string, input: CreateReactionRequest): Promise<Reaction> {
    const value = createReactionRequest.parse(input);
    const by = value.by;
    return this.jobs.transaction(async (tx) => {
      const target = await this.message(tx, scope, id);
      const written = await appendEvent(tx, {
        jobId: target.jobId,
        type: 'reaction',
        payload: { message_id: id, emoji: value.emoji, by },
        dedupKey: reactionDedupKey(id, by, value.emoji),
      });
      const weight = attentionWeightOfReaction(value.emoji, by);
      if (written && weight && target.jobId && isAssistantMessage(target) && this.attention) {
        const row = await this.jobs.lock(tx, target.jobId);
        if (row) await this.attention.reacted(tx, row, weight);
      }
      if (written) return reactionView(written);
      const [existing] = await tx
        .select()
        .from(event)
        .where(eq(event.dedupKey, reactionDedupKey(id, by, value.emoji)))
        .limit(1);
      if (!existing) throw new Error('reaction row disappeared');
      return reactionView(existing);
    });
  }

  /** Everything drawn on one bubble, oldest first. The bubble has to be the caller's. */
  async list(scope: ReactionScope, id: string): Promise<Reaction[]> {
    const target = await this.jobs.transaction((tx) => this.message(tx, scope, id));
    if (!target.jobId) return [];
    const rows = await this.jobs.db
      .select()
      .from(event)
      .where(and(eq(event.type, 'reaction'), eq(event.jobId, target.jobId)))
      .orderBy(asc(event.seq));
    return rows.filter((row) => jsonObject.parse(row.payload).message_id === id).map(reactionView);
  }

  /** Reactions across one job's stream, for a client rendering a whole transcript. */
  async listForJob(scope: ReactionScope, jobId: string): Promise<Reaction[]> {
    const [owner] = await this.jobs.db
      .select({ spaceId: job.spaceId })
      .from(job)
      .where(and(eq(job.id, jobId), eq(job.spaceId, scope.spaceId)))
      .limit(1);
    if (!owner || owner.spaceId !== scope.spaceId) throw notFound('job');
    const rows = await this.jobs.db
      .select()
      .from(event)
      .where(and(eq(event.type, 'reaction'), eq(event.jobId, jobId)))
      .orderBy(asc(event.seq));
    return rows.map(reactionView);
  }
}
