import { createHash } from 'node:crypto';
import {
  type AttemptOutcome,
  attemptOutcome,
  notification as notificationContract,
  replyObligation as obligationContract,
  type ReplyContent,
  replyContent,
  type SubmissionReceipt,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { attempt, notification, replyObligation } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobRow, JobService } from './service.ts';
import { canonicalSubmissionInput, type SubmissionService } from './submissions.ts';

type ObligationRow = typeof replyObligation.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;
const missingContent = 'The response content is unavailable. This reply needs retransmission.';
const digest = (value: Parameters<typeof canonicalSubmissionInput>[0]) =>
  createHash('sha256').update(canonicalSubmissionInput(value)).digest('hex');
const idsFor = (row: NotificationRow): string[] =>
  Array.isArray(row.obligationIds)
    ? row.obligationIds.filter((id): id is string => typeof id === 'string')
    : [];

export function obligationView(row: ObligationRow) {
  return obligationContract.parse({
    id: row.id,
    submission_id: row.submissionId,
    job_id: row.jobId,
    kind: row.kind,
    state: row.state,
    coalesce_key: row.coalesceKey,
    acknowledged_at: row.acknowledgedAt?.toISOString() ?? null,
    fulfilled_at: row.fulfilledAt?.toISOString() ?? null,
    message: row.message,
    created_at: row.createdAt.toISOString(),
  });
}
export function notificationView(row: NotificationRow) {
  return notificationContract.parse({
    id: row.id,
    coalesce_key: row.coalesceKey,
    delivery_key: row.deliveryKey,
    obligation_ids: row.obligationIds,
    content: row.content,
    content_hash: row.contentHash,
    delivery_attempt: row.deliveryAttempt,
    state: row.state,
    attempted_at: row.attemptedAt?.toISOString() ?? null,
    delivered_at: row.deliveredAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  });
}

function responseContent(
  row: JobRow,
  outcome: AttemptOutcome,
  attemptId: string,
): ReplyContent | null {
  if (row.state === 'needs_reconciliation')
    return {
      job_id: row.id,
      attempt_id: attemptId,
      kind: 'status',
      text: 'Melete cannot confirm the outcome of an external action. This responsibility needs reconciliation.',
    };
  let text: string;
  let kind: ReplyContent['kind'] = 'status';
  switch (outcome.kind) {
    case 'completed': {
      text = outcome.summary;
      kind = row.state === 'waiting_for_input' ? 'question' : 'answer';
      const wait = waitSpec.parse(row.wait);
      if (wait.kind === 'user_input') text += `\n\n${wait.question}`;
      break;
    }
    case 'waiting_for_input':
      text = outcome.draft ? `${outcome.draft}\n\n${outcome.question}` : outcome.question;
      kind = 'question';
      break;
    case 'waiting_for_approval':
      if (row.state !== 'waiting_for_approval') return null;
      text = 'This responsibility is waiting for an approval decision.';
      break;
    case 'waiting_for_event_or_time':
      text = 'This responsibility is waiting for its next event or scheduled time.';
      break;
    case 'budget_exhausted':
      text = outcome.summary;
      break;
    case 'failed':
      if (row.state !== 'failed') return null;
      text = outcome.reason;
      break;
  }
  if (!text.trim()) return null;
  return { job_id: row.id, attempt_id: attemptId, kind, text };
}

/** Acceptance, response content, attempted delivery and confirmed delivery are separate facts. */
export class ReplyService {
  constructor(
    readonly jobs: JobService,
    submissions: SubmissionService,
    runner?: AttemptRunner,
  ) {
    submissions.onAccepted = (tx, receipt, row) => this.register(tx, receipt, row);
    if (runner) {
      runner.onFinished.push((tx, row, outcome, attemptId) =>
        this.publish(tx, row, outcome, attemptId),
      );
      const previous = runner.afterRecovery;
      runner.afterRecovery = async () => {
        await previous?.();
        await this.recover();
      };
    }
  }

  async register(
    tx: Transaction,
    receipt: SubmissionReceipt,
    row: JobRow,
    kind: 'direct' | 'quiet' = 'direct',
  ): Promise<void> {
    if (kind === 'quiet') return;
    if (receipt.state !== 'accepted' || receipt.event_cursor === null)
      throw new Error('A reply obligation requires a durable acceptance receipt');
    const [created] = await tx
      .insert(replyObligation)
      .values({
        id: newId('obl'),
        submissionId: receipt.submission_id,
        jobId: row.id,
        kind,
        state: 'owed',
        coalesceKey: row.id,
        eventCursor: receipt.event_cursor,
      })
      .onConflictDoNothing({ target: replyObligation.submissionId })
      .returning();
    if (created)
      await appendEvent(tx, {
        jobId: row.id,
        type: 'notice',
        payload: {
          kind: 'reply_owed',
          obligation_id: created.id,
          submission_id: receipt.submission_id,
        },
        dedupKey: `${created.id}:owed`,
      });
  }

  async publish(
    tx: Transaction,
    row: JobRow,
    outcome: AttemptOutcome,
    attemptId: string,
  ): Promise<void> {
    const content = responseContent(row, outcome, attemptId);
    if (!content) return;
    const [execution] = await tx.select().from(attempt).where(eq(attempt.id, attemptId));
    if (!execution) return;
    const owed = await tx
      .select()
      .from(replyObligation)
      .where(
        and(
          eq(replyObligation.jobId, row.id),
          ne(replyObligation.state, 'fulfilled'),
          lte(replyObligation.eventCursor, execution.inputCursor),
        ),
      );
    if (!owed.length) return;
    const ids = owed.map((item) => item.id).sort();
    const contentHash = digest(content);
    const deliveryKey = digest({
      coalesce_key: row.id,
      content_hash: contentHash,
      obligation_ids: ids,
    });
    const [existing] = await tx
      .select()
      .from(notification)
      .where(eq(notification.deliveryKey, deliveryKey))
      .orderBy(desc(notification.deliveryAttempt))
      .limit(1);
    if (existing && (existing.deliveredAt || existing.state !== 'superseded')) {
      if (
        !existing.deliveredAt &&
        digest(
          replyContent.safeParse(existing.content).success
            ? replyContent.parse(existing.content)
            : null,
        ) !== contentHash
      )
        await tx.update(notification).set({ content }).where(eq(notification.id, existing.id));
      return;
    }
    // A newer reply may coalesce outstanding messages, but no obligation is fulfilled here.
    await tx
      .update(notification)
      .set({ state: 'superseded' })
      .where(
        and(
          eq(notification.coalesceKey, row.id),
          isNull(notification.deliveredAt),
          ne(notification.state, 'superseded'),
        ),
      );
    const [pending] = await tx
      .insert(notification)
      .values({
        id: newId('ntf'),
        jobId: row.id,
        coalesceKey: row.id,
        deliveryKey,
        obligationIds: ids,
        content,
        contentHash,
        deliveryAttempt: (existing?.deliveryAttempt ?? 0) + 1,
      })
      .returning();
    if (!pending) throw new Error('Notification insert returned no row');
    for (const item of owed)
      await tx
        .update(replyObligation)
        .set({
          content,
          contentHash,
          state: item.acknowledgedAt ? 'acknowledged' : 'owed',
          message: null,
        })
        .where(eq(replyObligation.id, item.id));
    await appendEvent(tx, {
      jobId: row.id,
      attemptId,
      type: 'notice',
      payload: { kind: 'notification_pending', notification_id: pending.id, obligation_ids: ids },
      dedupKey: `${pending.id}:pending`,
    });
  }

  list() {
    return this.jobs.db
      .select()
      .from(replyObligation)
      .where(ne(replyObligation.state, 'fulfilled'))
      .orderBy(replyObligation.createdAt);
  }
  outbox() {
    return this.jobs.db
      .select()
      .from(notification)
      .where(inArray(notification.state, ['pending', 'attempted']))
      .orderBy(notification.createdAt);
  }

  acknowledge(id: string) {
    return this.jobs.transaction(async (tx) => {
      const [row] = await tx.select().from(replyObligation).where(eq(replyObligation.id, id));
      if (!row) throw new ServiceError('not_found', 'Reply obligation not found.', 404);
      if (row.acknowledgedAt || row.state === 'fulfilled') return row;
      const [updated] = await tx
        .update(replyObligation)
        .set({
          acknowledgedAt: new Date(),
          state: row.state === 'needs_retransmission' ? row.state : 'acknowledged',
        })
        .where(eq(replyObligation.id, id))
        .returning();
      if (!updated) throw new Error('Reply obligation disappeared');
      return updated;
    });
  }

  beginDelivery(id: string) {
    return this.jobs.transaction(async (tx) => {
      const [row] = await tx.select().from(notification).where(eq(notification.id, id));
      if (!row) throw new ServiceError('not_found', 'Notification not found.', 404);
      const parsed = replyContent.safeParse(row.content);
      if (!parsed.success || digest(parsed.data) !== row.contentHash)
        throw new ServiceError('notification_content_unavailable', missingContent);
      if (row.state === 'superseded')
        throw new ServiceError(
          'notification_superseded',
          'A newer notification replaces this one.',
        );
      if (row.attemptedAt || row.deliveredAt) return row;
      const [updated] = await tx
        .update(notification)
        .set({ attemptedAt: new Date(), state: 'attempted' })
        .where(eq(notification.id, id))
        .returning();
      if (!updated) throw new Error('Notification disappeared');
      return updated;
    });
  }

  delivered(id: string, contentHash: string) {
    return this.jobs.transaction(async (tx) => {
      const [row] = await tx.select().from(notification).where(eq(notification.id, id));
      if (!row) throw new ServiceError('not_found', 'Notification not found.', 404);
      const parsed = replyContent.safeParse(row.content);
      if (
        !parsed.success ||
        digest(parsed.data) !== row.contentHash ||
        row.contentHash !== contentHash
      )
        throw new ServiceError(
          'notification_hash_mismatch',
          'The acknowledgement names different content.',
        );
      if (row.deliveredAt) return row;
      const at = new Date();
      const [updated] = await tx
        .update(notification)
        .set({ state: 'delivered', attemptedAt: row.attemptedAt ?? at, deliveredAt: at })
        .where(eq(notification.id, id))
        .returning();
      if (!updated) throw new Error('Notification disappeared');
      const ids = idsFor(row);
      if (ids.length)
        await tx
          .update(replyObligation)
          .set({ state: 'fulfilled', fulfilledAt: at, message: null })
          .where(inArray(replyObligation.id, ids));
      await tx
        .update(notification)
        .set({ state: 'superseded' })
        .where(
          and(
            eq(notification.deliveryKey, row.deliveryKey),
            ne(notification.id, row.id),
            isNull(notification.deliveredAt),
          ),
        );
      await appendEvent(tx, {
        jobId: row.jobId,
        type: 'notice',
        payload: { kind: 'notification_delivered', notification_id: row.id, obligation_ids: ids },
        dedupKey: `${row.id}:delivered`,
      });
      return updated;
    });
  }

  async recover(): Promise<void> {
    await this.jobs.transaction(async (tx) => {
      const owed = await tx
        .select()
        .from(replyObligation)
        .where(ne(replyObligation.state, 'fulfilled'));
      for (const jobId of new Set(owed.flatMap((item) => (item.jobId ? [item.jobId] : [])))) {
        const row = await this.jobs.lock(tx, jobId);
        if (!row) continue;
        const executions = await tx
          .select()
          .from(attempt)
          .where(and(eq(attempt.jobId, jobId), isNotNull(attempt.endedAt)))
          .orderBy(desc(attempt.epoch));
        for (const execution of executions) {
          const outcome = attemptOutcome.safeParse(execution.outcomeDetail);
          if (!outcome.success || !responseContent(row, outcome.data, execution.id)) continue;
          await this.publish(tx, row, outcome.data, execution.id);
          break;
        }
      }
      const pending = await tx
        .select()
        .from(notification)
        .where(inArray(notification.state, ['pending', 'attempted']));
      for (const item of owed) {
        const available = pending.some(
          (message) =>
            idsFor(message).includes(item.id) && replyContent.safeParse(message.content).success,
        );
        if (!available)
          await tx
            .update(replyObligation)
            .set({ state: 'needs_retransmission', message: missingContent })
            .where(eq(replyObligation.id, item.id));
      }
      for (const delivery of pending) {
        if (delivery.state !== 'attempted' || !replyContent.safeParse(delivery.content).success)
          continue;
        await tx
          .update(notification)
          .set({ state: 'superseded' })
          .where(eq(notification.id, delivery.id));
        const [last] = await tx
          .select()
          .from(notification)
          .where(eq(notification.deliveryKey, delivery.deliveryKey))
          .orderBy(desc(notification.deliveryAttempt))
          .limit(1);
        await tx.insert(notification).values({
          id: newId('ntf'),
          jobId: delivery.jobId,
          coalesceKey: delivery.coalesceKey,
          deliveryKey: delivery.deliveryKey,
          obligationIds: delivery.obligationIds,
          content: delivery.content,
          contentHash: delivery.contentHash,
          deliveryAttempt: (last?.deliveryAttempt ?? 0) + 1,
        });
      }
    });
  }
}
