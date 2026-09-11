import { createHash } from 'node:crypto';
import {
  type AttemptOutcome,
  type JobScheduling,
  jobScheduling,
  waitSpec,
} from '@melete/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import { event, job } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { AttemptRunner } from './runner.ts';
import type { JobRow, JobService } from './service.ts';

export const REDUCED_CADENCE_MULTIPLIER = 4;
function attention(
  row: Pick<JobRow, 'unreadResults' | 'unreadThreshold' | 'importance' | 'schedulingClass'>,
) {
  if (row.schedulingClass === 'interactive' || row.unreadResults < row.unreadThreshold)
    return { attentionStatus: 'normal', cadenceMultiplier: 1 };
  return row.importance === 'important'
    ? { attentionStatus: 'needs_attention', cadenceMultiplier: 1 }
    : { attentionStatus: 'frequency_reduced', cadenceMultiplier: REDUCED_CADENCE_MULTIPLIER };
}

/** Delivery and reading are distinct: only an explicit read clears the attention count. */
export class AttentionService {
  constructor(
    readonly jobs: JobService,
    runner?: AttemptRunner,
  ) {
    runner?.onFinished.push((tx, row, outcome, id) => this.record(tx, row, outcome, id));
  }
  private async update(
    tx: Transaction,
    row: JobRow,
    changes: Partial<typeof job.$inferInsert>,
    reason: string,
  ) {
    const combined = { ...row, ...changes };
    let wait = waitSpec.parse(row.wait);
    let nextWakeAt = row.nextWakeAt;
    if (
      row.state === 'waiting_for_event_or_time' &&
      wait.kind === 'timer' &&
      row.attentionBaseWakeAt
    ) {
      const remaining = Math.max(0, row.attentionBaseWakeAt.getTime() - Date.now());
      nextWakeAt = new Date(Date.now() + remaining * combined.cadenceMultiplier);
      wait = { ...wait, wake_at: nextWakeAt.toISOString() };
    }
    const [updated] = await tx
      .update(job)
      .set({
        ...changes,
        wait,
        nextWakeAt,
        stateVersion: row.stateVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(job.id, row.id))
      .returning();
    if (!updated) throw new Error('Locked responsibility disappeared');
    await appendEvent(tx, {
      jobId: row.id,
      type: 'notice',
      payload: {
        kind: 'attention_changed',
        reason,
        unread_results: updated.unreadResults,
        attention_status: updated.attentionStatus,
        scheduling_class: updated.schedulingClass,
        cadence_multiplier: updated.cadenceMultiplier,
        importance: updated.importance,
      },
      dedupKey: `${row.id}:attention:${updated.stateVersion}`,
    });
    await this.jobs.enqueue(tx, updated, 'recovery');
    return updated;
  }
  async record(
    tx: Transaction,
    row: JobRow,
    outcome: AttemptOutcome,
    attemptId: string,
  ): Promise<void> {
    if (row.schedulingClass === 'interactive' || row.lastAttentionAttemptId === attemptId) return;
    const deltas = await tx
      .select({ payload: event.payload })
      .from(event)
      .where(and(eq(event.attemptId, attemptId), eq(event.type, 'text_delta')))
      .orderBy(asc(event.seq));
    const text =
      'summary' in outcome
        ? outcome.summary
        : 'question' in outcome
          ? outcome.question
          : deltas.map((entry) => (entry.payload as { text?: string }).text ?? '').join('');
    if (!text.trim()) return;
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === row.lastResultHash) return;
    // A quiet monitor's first observation establishes its baseline; unchanged checks stay quiet.
    const unreadResults =
      row.unreadResults + (row.schedulingClass === 'quiet' && row.lastResultHash === null ? 0 : 1);
    const state = attention({ ...row, unreadResults });
    await this.update(
      tx,
      row,
      {
        unreadResults,
        ...state,
        lastResultHash: hash,
        lastAttentionAttemptId: attemptId,
        scheduleSkipRemaining: state.cadenceMultiplier - 1,
      },
      'new_result',
    );
  }
  async markRead(id: string) {
    return this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      if (row.unreadResults === 0 && row.attentionStatus === 'normal') return row;
      return this.update(
        tx,
        row,
        {
          unreadResults: 0,
          attentionStatus: 'normal',
          cadenceMultiplier: 1,
          scheduleSkipRemaining: 0,
        },
        'read',
      );
    });
  }
  async configure(id: string, input: JobScheduling) {
    const value = jobScheduling.parse(input);
    return this.jobs.transaction(async (tx) => {
      const row = await this.jobs.lock(tx, id);
      if (!row) throw new ServiceError('not_found', 'Job not found.', 404);
      const settings = {
        schedulingClass: value.scheduling_class ?? row.schedulingClass,
        importance: value.importance ?? row.importance,
        unreadThreshold: value.unread_threshold ?? row.unreadThreshold,
      };
      const state = attention({ ...row, ...settings });
      return this.update(
        tx,
        row,
        { ...settings, ...state, scheduleSkipRemaining: state.cadenceMultiplier - 1 },
        'preferences',
      );
    });
  }
}
