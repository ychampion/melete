import { createHash } from 'node:crypto';
import {
  type AttemptOutcome,
  attemptOutcome,
  attentionHandle,
  notification as notificationContract,
  replyObligation as obligationContract,
  type ReplyContent,
  replyContent,
  type SubmissionReceipt,
  waitSpec,
} from '@melete/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { attempt, event, notification, replyObligation } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import { newId } from '../ids.ts';
import { requestPrincipal, requireJobAccess, visibleJob } from '../principals/authority.ts';
import { type AttemptResult, attemptResult } from './attention.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobRow, JobService } from './service.ts';
import { canonicalSubmissionInput, type SubmissionService } from './submissions.ts';

type ObligationRow = typeof replyObligation.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;
/** How many unserved obligations one recovery scan repairs. */
const RECOVERY_BATCH = 100;
export const DELIVERY_LEASE_MS = 5 * 60_000;
/** Outcome kinds an ended attempt can carry a reply for; lost, cancelled and superseded carry none. */
const OUTCOME_KINDS = [
  'completed',
  'waiting_for_input',
  'waiting_for_approval',
  'waiting_for_event_or_time',
  'budget_exhausted',
  'unknown_check',
  'failed',
];
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
    because: row.because,
    if_ignored: row.ifIgnored,
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
    case 'unknown_check':
      text = outcome.message;
      break;
    case 'failed':
      if (row.state !== 'failed') return null;
      text = outcome.reason;
      break;
  }
  if (!text.trim()) return null;
  return { job_id: row.id, attempt_id: attemptId, kind, text };
}

/**
 * What happens if nobody reads this, in plain language, carrying a real date
 * whenever the service knows one. Nothing here is invented: every branch reads a
 * fact already on the job row.
 */
function consequence(row: JobRow, content: ReplyContent): string {
  const unread = `The result stays unread, and after ${row.unreadThreshold} unread results this responsibility checks less often.`;
  if (row.state === 'needs_reconciliation')
    return 'The external action stays unconfirmed, and nothing checks it again until you say what you found.';
  if (content.kind === 'question' || row.state === 'waiting_for_input')
    return 'This responsibility stays waiting for your answer and makes no further progress until you reply.';
  switch (row.state) {
    case 'waiting_for_approval':
      return 'Nothing is sent until you decide.';
    case 'waiting_for_event_or_time':
      return row.nextWakeAt
        ? `Nothing happens until ${row.nextWakeAt.toISOString()}, when this checks again.`
        : 'Nothing happens until the event this responsibility is waiting for arrives.';
    case 'failed':
      return 'This responsibility has stopped, and it stays stopped until you look at it.';
    default:
      return unread;
  }
}

export type NotificationDraft = {
  jobId: string | null;
  coalesceKey: string;
  deliveryKey: string;
  obligationIds: string[];
  content: ReplyContent | null;
  contentHash: string;
  /** Non-empty, or the outbox refuses the row. */
  because: readonly string[];
  ifIgnored: string;
  deliveryAttempt: number;
};

/** Acceptance, response content, attempted delivery and confirmed delivery are separate facts. */
export class ReplyService {
  constructor(
    readonly jobs: JobService,
    submissions: SubmissionService,
    runner?: AttemptRunner,
    /** How long a client may hold an attempted delivery before a fresh copy is offered. */
    readonly deliveryLeaseMs = DELIVERY_LEASE_MS,
  ) {
    const accepted = submissions.onAccepted;
    submissions.onAccepted = async (tx, receipt, row, kind) => {
      await accepted?.(tx, receipt, row, kind);
      await this.register(tx, receipt, row, kind);
    };
    if (runner) {
      runner.onFinished.push((tx, row, outcome, attemptId, context) =>
        this.publish(tx, row, outcome, attemptId, context?.result),
      );
      const previous = runner.afterRecovery;
      runner.afterRecovery = async () => {
        await previous?.();
        await this.recover();
      };
    }
  }

  /**
   * Creating a quiet monitor owes no reply: the owner asked to be left alone
   * until something changes. Sending it a message still does, because that is a
   * person asking a question.
   */
  async register(
    tx: Transaction,
    receipt: SubmissionReceipt,
    row: JobRow,
    submission: 'create' | 'input' = 'input',
  ): Promise<void> {
    const kind: 'direct' | 'quiet' =
      submission === 'create' && row.schedulingClass === 'quiet' ? 'quiet' : 'direct';
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

  /** Every handle that made this necessary, so the outbox never sends unexplained mail. */
  private async reasons(
    tx: Transaction,
    attemptId: string,
    obligationIds: readonly string[],
  ): Promise<string[]> {
    const handles = obligationIds.map((id) => `obligation:${id}`);
    const [ended] = await tx
      .select({ seq: event.seq })
      .from(event)
      .where(eq(event.dedupKey, `${attemptId}:ended`))
      .limit(1);
    if (ended) handles.push(`event:${ended.seq}`);
    else if (!handles.length) handles.push(`attempt:${attemptId}`);
    return handles;
  }

  /** The one way a row reaches the outbox. A notification citing nothing is refused. */
  async enqueue(tx: Transaction, draft: NotificationDraft): Promise<NotificationRow> {
    const because = attentionHandle.array().min(1).safeParse(draft.because);
    if (!because.success)
      throw new ServiceError(
        'notification_without_because',
        'A notification must cite the event or claim handles that made it necessary.',
        422,
      );
    if (!draft.ifIgnored.trim())
      throw new ServiceError(
        'notification_without_consequence',
        'A notification must say plainly what happens if it is ignored.',
        422,
      );
    const [pending] = await tx
      .insert(notification)
      .values({ ...draft, id: newId('ntf'), because: because.data })
      .returning();
    if (!pending) throw new Error('Notification insert returned no row');
    return pending;
  }

  async publish(
    tx: Transaction,
    row: JobRow,
    outcome: AttemptOutcome,
    attemptId: string,
    result?: AttemptResult | null,
  ): Promise<void> {
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
    const delta = result === undefined ? await attemptResult(tx, row, outcome, attemptId) : result;
    // Nothing owed and nothing new: a quiet check with no delta has no handle to
    // cite, so it sends nothing rather than sending an empty reassurance.
    if (!owed.length && !delta?.changed) return;
    const content = owed.length
      ? responseContent(row, outcome, attemptId)
      : { job_id: row.id, attempt_id: attemptId, kind: 'status' as const, text: delta?.text ?? '' };
    if (!content?.text.trim()) return;
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
    const pending = await this.enqueue(tx, {
      jobId: row.id,
      coalesceKey: row.id,
      deliveryKey,
      obligationIds: ids,
      content,
      contentHash,
      because: await this.reasons(tx, attemptId, ids),
      ifIgnored: consequence(row, content),
      deliveryAttempt: (existing?.deliveryAttempt ?? 0) + 1,
    });
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
      .where(and(ne(replyObligation.state, 'fulfilled'), visibleJob(replyObligation.jobId)))
      .orderBy(replyObligation.createdAt);
  }
  outbox() {
    return this.jobs.db
      .select()
      .from(notification)
      .where(
        and(inArray(notification.state, ['pending', 'attempted']), visibleJob(notification.jobId)),
      )
      .orderBy(notification.createdAt);
  }

  acknowledge(id: string) {
    return this.jobs.transaction(async (tx) => {
      const [row] = await tx.select().from(replyObligation).where(eq(replyObligation.id, id));
      if (!row) throw new ServiceError('not_found', 'Reply obligation not found.', 404);
      if (requestPrincipal() && row.jobId) await requireJobAccess(tx, row.jobId);
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
      if (requestPrincipal() && row.jobId) await requireJobAccess(tx, row.jobId);
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
      if (requestPrincipal() && row.jobId) await requireJobAccess(tx, row.jobId);
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

  /**
   * Repairs replies that lost their outbox copy, flags the ones that cannot be
   * rebuilt, and offers a delivery again once its client's lease has passed.
   *
   * Repair reads a bounded batch, and only obligations that could be rebuilt:
   * no live notification carries them and their job has an ended attempt with
   * an outcome. The most recently ended jobs come first, so obligations whose
   * content can never return (no job, or only lost and cancelled attempts)
   * cannot hold a newer one back.
   */
  async recover(): Promise<void> {
    await this.jobs.transaction(async (tx) => {
      const unserved = sql`not exists (select 1 from notification n where n.state in ('pending', 'attempted')
        and n.content is not null and n.obligation_ids @> jsonb_build_array(${replyObligation.id}))`;
      const owed = await tx
        .select()
        .from(replyObligation)
        .where(
          and(
            ne(replyObligation.state, 'fulfilled'),
            unserved,
            // publish answers only obligations the attempt had read, so one that
            // arrived after its job's last attempt waits for the next attempt.
            sql`exists (select 1 from attempt a where a.job_id = ${replyObligation.jobId}
              and a.input_cursor >= ${replyObligation.eventCursor}
              and a.ended_at is not null and a.outcome_detail->>'kind' in (${sql.join(
                OUTCOME_KINDS.map((kind) => sql`${kind}`),
                sql`, `,
              )}))`,
          ),
        )
        .orderBy(
          sql`(select max(a.ended_at) from attempt a where a.job_id = ${replyObligation.jobId}) desc`,
          replyObligation.createdAt,
          replyObligation.id,
        )
        .limit(RECOVERY_BATCH);
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
      // Anything still owed with no live copy says so; one statement, whatever the history.
      await tx
        .update(replyObligation)
        .set({ state: 'needs_retransmission', message: missingContent })
        .where(and(inArray(replyObligation.state, ['owed', 'acknowledged']), unserved));
      // The client delivers, not this process: an attempt is offered again only
      // once its lease has run out, whether or not the service restarted since.
      const expired = await tx
        .select()
        .from(notification)
        .where(
          and(
            eq(notification.state, 'attempted'),
            sql`${notification.attemptedAt} < now() - ${this.deliveryLeaseMs} * interval '1 millisecond'`,
          ),
        );
      for (const delivery of expired) {
        if (!replyContent.safeParse(delivery.content).success) continue;
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
        await this.enqueue(tx, {
          jobId: delivery.jobId,
          coalesceKey: delivery.coalesceKey,
          deliveryKey: delivery.deliveryKey,
          obligationIds: idsFor(delivery),
          content: replyContent.parse(delivery.content),
          contentHash: delivery.contentHash,
          because: delivery.because,
          ifIgnored: delivery.ifIgnored,
          deliveryAttempt: (last?.deliveryAttempt ?? 0) + 1,
        });
      }
    });
  }
}
