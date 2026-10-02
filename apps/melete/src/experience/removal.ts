/**
 * Deleting chats and plans.
 *
 * A chat or a plan is a job, and a job may be at work: a turn streaming, an
 * attempt holding a lease, a permission waiting on the person. So a deletion
 * runs in the order that leaves nothing half-done. First, under the job locks,
 * a turn in flight is stopped as Stop stops it, every permission still waiting
 * is withdrawn so it can never be allowed, and the work is cancelled, which
 * fences the attempt. Then the runtime is told and given time to let go. Only
 * then do the rows go, in one transaction.
 *
 * What goes is what the job owns: its turns, events, attempts, actions and
 * approvals, which the schema cascades from the job. What stays is what was
 * never only the job's: files it made stay in the space (their `job_id` is
 * cleared), a computer it used stays, and memory stays. Memory is the person's,
 * so it is forgotten only when they ask, through the same source deletion that
 * "forget that" uses; see `memorySourcesOf`.
 */
import { isTerminal, type JobState } from '@melete/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Sql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { action, attempt, job, trigger } from '../db/schema.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import { ENDED_NOTE, withdrawPermissions } from '../jobs/withdraw.ts';

export type JobRemovalDeps = {
  jobs: JobService;
  sql: Sql;
  runner?: AttemptRunner;
};

export type JobRemoval = {
  /** A conversation turn was under way and was stopped first. */
  stopped: boolean;
  /** Permissions that were still waiting and were withdrawn. */
  withdrawn: number;
};

/**
 * Stop, withdraw, cancel and then delete these jobs. `ids` are already checked
 * to be the caller's. The first is the job the person asked to delete; the rest
 * belong to it (a chat's command jobs, a plan's steps).
 */
export async function removeJobs(
  deps: JobRemovalDeps,
  ids: readonly string[],
): Promise<JobRemoval> {
  const { jobs } = deps;
  const list = [...new Set(ids)];
  if (!list.length) return { stopped: false, withdrawn: 0 };
  const ended = await jobs.transaction(async (tx) => {
    let stopped = false;
    const cancelled: string[] = [];
    // Locked in id order, the order every other multi-job lock takes.
    const rows: JobRow[] = [];
    for (const id of [...list].sort()) {
      const row = await jobs.lock(tx, id);
      if (row) rows.push(row);
    }
    // Nothing the person was asked here may be allowed once it is deleted.
    const withdrawn = await withdrawPermissions(tx, inArray(action.jobId, list), ENDED_NOTE);
    for (const row of rows) {
      // A turn in flight ends the way Stop ends it: parked actions are refused
      // and the attempt is fenced, so nothing it was doing goes ahead.
      if (row.kind === 'chat' && (await jobs.stopTurn?.(tx, row))) stopped = true;
      const [current] = await tx.select().from(job).where(eq(job.id, row.id));
      if (!current) continue;
      await tx.update(trigger).set({ enabled: false }).where(eq(trigger.jobId, row.id));
      if (!isTerminal(current.state as JobState)) {
        await jobs.move(tx, current, { kind: 'cancelled' }, { payload: { reason: 'deleted' } });
        cancelled.push(row.id);
      }
      await tx
        .update(attempt)
        .set({
          outcome: 'fenced',
          outcomeDetail: { kind: 'cancelled', reason: 'deleted' },
          endedAt: new Date(),
          leaseExpiresAt: null,
          leaseStatus: 'ended',
        })
        .where(and(eq(attempt.jobId, row.id), isNull(attempt.endedAt)));
    }
    return { stopped, withdrawn, cancelled };
  });
  // The fence is committed; now the runtime lets go before the rows go.
  for (const id of ended.cancelled) jobs.onCancelled?.(id);
  await deps.runner?.stopJobs(list);
  await deps.sql.begin(async (tx) => {
    // A chat started from a deleted plan stays, no longer linked to it.
    await tx`update job set plan_id = null where plan_id = any(${list}) and not (id = any(${list}))`;
    // Rows that name a job without a cascade, then the jobs themselves, which
    // take their turns, events, attempts, actions, approvals and triggers.
    await tx`delete from submission where job_id = any(${list})`;
    await tx`delete from acceptance_journal where job_id = any(${list})`;
    await tx`delete from reply_obligation where job_id = any(${list})`;
    await tx`delete from notification where job_id = any(${list})`;
    await tx`update plan_milestone set child_job_id = null where child_job_id = any(${list})`;
    // The privacy router's per-conversation records hold sealed private
    // values; they mean nothing without the conversation.
    await tx`delete from privacy_vault where conversation_id = any(${list})`;
    await tx`delete from privacy_conversation where conversation_id = any(${list})`;
    await tx`delete from privacy_request where job_id = any(${list}) or conversation_id = any(${list})`;
    // The record of what memory handed each action, kept to say why it was
    // taken. The actions go with the job, so their reasons go too. Memory
    // itself is untouched.
    await tx`delete from memory_action_basis where job_id = any(${list})`;
    const gone = await tx`delete from job where id = any(${list}) returning id`;
    if (!gone.some((row) => row.id === list[0]))
      throw new ServiceError('not_found', 'That item is not here.', 404);
  });
  return { stopped: ended.stopped, withdrawn: ended.withdrawn };
}

/**
 * The memory sources a chat's own messages became. These are what "also forget
 * what Melete learned from this chat" removes: each through source deletion,
 * which takes every detail resting only on it and keeps any that another
 * source also supports.
 */
export async function memorySourcesOf(sql: Sql, jobId: string): Promise<string[]> {
  const rows = await sql`select distinct c.source_id from memory_capture c
    join memory_sources s on s.id = c.source_id
    where c.job_id = ${jobId} and c.outcome = 'remembered' and s.state = 'active'`;
  return rows.map((row) => String(row.source_id));
}
