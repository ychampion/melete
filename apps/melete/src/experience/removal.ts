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
 * approvals, which the schema cascades from the job. Its workspace goes too,
 * into its trash, restorable for the trash period (see `workspace-trash.ts`).
 * What stays is what was never only the job's: files it saved to the person's
 * Files or the space stay (their `job_id` is cleared), a computer it used
 * stays, and memory stays. Memory is the person's,
 * so it is forgotten only when they ask, through the same source deletion that
 * "forget that" uses; see `memorySourcesOf`.
 */
import { isTerminal, type JobState } from '@melete/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Sql, TransactionSql } from 'postgres';
import { ServiceError } from '../api/errors.ts';
import { purgeUnreferenced, releaseJobAttachments } from '../attachments/store.ts';
import { loadAction } from '../broker/records.ts';
import { planReversal, UNDO_WINDOW_MS } from '../broker/reversals.ts';
import { action, attempt, job, trigger } from '../db/schema.ts';
import { newId } from '../ids.ts';
import type { AttemptRunner } from '../jobs/runner.ts';
import type { JobRow, JobService } from '../jobs/service.ts';
import { ENDED_NOTE, withdrawPermissions } from '../jobs/withdraw.ts';
import { roomAuthorityOf } from '../rooms/approvals.ts';
import type { BlobKey, BlobStore } from '../storage/blob.ts';
import { trashWorkspace, type WorkspaceTrash } from './workspace-trash.ts';

export type JobRemovalDeps = {
  jobs: JobService;
  sql: Sql;
  runner?: AttemptRunner;
  /** Where the files sent in the chats are kept; their bytes go with them. */
  blobs?: BlobStore;
  /** Where the jobs' workspaces are; each goes to its trash with the job. */
  workspaces?: WorkspaceTrash;
  /** Told when a workspace could not go yet; the next start tries again. */
  log?: (line: string) => void;
};

export type JobRemoval = {
  /** A conversation turn was under way and was stopped first. */
  stopped: boolean;
  /** Permissions that were still waiting and were withdrawn. */
  withdrawn: number;
  /** Saved details forgotten with it, when the person asked. */
  forgotten: number;
};

/**
 * Forget what these memory sources taught. Answers how many saved details went.
 * Left out, memory is kept.
 */
export type ForgetSources = (sourceIds: readonly string[]) => Promise<number>;

/**
 * Effects that may still go out, or whose outcome is still being worked out.
 * A read from a built-in connector is never one: it changed nothing outside,
 * so it never holds up a deletion, whatever state it is in. A tool of an
 * installed MCP server is held to the rule for effects even when its policy
 * calls it a read, since only its server can say it changes nothing.
 */
const IN_FLIGHT = ['admitted', 'dispatched', 'unknown', 'unresolved'];
/** Effects that changed something outside Melete. */
const OUTWARD = ['write_external', 'write_reversible', 'spend'];

/** Commands, which run rather than send. */
const COMMANDS = ['terminal.run', 'device.run'];

/**
 * Why a deletion has to wait, worded by what is in flight: a command still
 * running, a step on a computer, or something on its way out.
 */
function inFlightRefusal(rows: readonly { status: string; kind: string }[]): ServiceError | null {
  const going = rows.filter((row) => row.status === 'admitted' || row.status === 'dispatched');
  if (going.some((row) => COMMANDS.includes(row.kind)))
    return new ServiceError(
      'still_sending',
      'A command is still running. Try again when it finishes.',
      409,
    );
  if (going.some((row) => row.kind.startsWith('computer.') || row.kind.startsWith('device.')))
    return new ServiceError(
      'still_sending',
      'A step on a computer is still under way. Try again when it finishes.',
      409,
    );
  if (going.length)
    return new ServiceError(
      'still_sending',
      'Something is still being sent. Try again in a moment.',
      409,
    );
  if (rows.length)
    return new ServiceError(
      'outcome_unclear',
      'Melete is not sure whether something from here went through. Settle it first, then delete.',
      409,
    );
  return null;
}

/**
 * A deletion waits for what is on its way out. The broker settles a send and
 * reconciles a late receipt against its action row; deleting the row first
 * would leave an effect that happened with nothing to record it against.
 */
async function refuseInFlight(query: Sql | TransactionSql, list: readonly string[]) {
  const rows = await query`select status, kind from action
    where job_id = any(${[...list]}) and status = any(${IN_FLIGHT})
      and not (effect_class = 'read' and exists (select 1 from connection c
        where c.id = action.connection_id and c.provider <> 'mcp'))`;
  const refusal = inFlightRefusal(
    rows.map((row) => ({ status: String(row.status), kind: String(row.kind) })),
  );
  if (refusal) throw refusal;
}

/** Where an effect went, never what it said. */
function destinationOf(kind: string, payload: Record<string, unknown>): string | null {
  if (kind.startsWith('email.') || kind.endsWith('.send')) {
    const raw = payload.to ?? payload.recipient;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const text = list.filter((entry) => typeof entry === 'string').join(', ');
    return text ? text.slice(0, 500) : null;
  }
  if (kind.startsWith('files.') && typeof payload.path === 'string')
    return payload.path.slice(0, 500);
  return null;
}

/**
 * Copy what these jobs did outside Melete into the activity record, which
 * outlives them, so the person never loses track of what was done in their
 * name. Kind, connection, destination, the destination's own reference,
 * outcome and time; no subject, body or file contents.
 */
/**
 * Reversals that still work once the chat that made the change is gone: they
 * name the change by the calendar's or the app's own ids, never by a record
 * the deletion takes with it.
 */
const KEPT_REVERSALS = new Set([
  'calendar.delete',
  'calendar.update',
  'calendar.create',
  'apps.rollback',
]);

async function keepActivity(tx: TransactionSql, list: readonly string[]) {
  const rows =
    await tx`select a.id, a.job_id, a.kind, a.effect_class, a.canonical_payload, a.receipt,
      a.status, coalesce(a.resolved_at, a.created_at) as happened_at,
      c.id as connection_id, c.label, c.provider, j.space_id, j.principal_id, j.title
    from action a
    join job j on j.id = a.job_id
    left join connection c on c.id = a.connection_id
    where a.job_id = any(${[...list]}) and a.status = 'succeeded'
      and a.effect_class = any(${OUTWARD})`;
  for (const row of rows) {
    const payload = (row.canonical_payload ?? {}) as Record<string, unknown>;
    const receipt = (row.receipt ?? {}) as Record<string, unknown>;
    const ref =
      typeof receipt.external_ref === 'string' ? receipt.external_ref.slice(0, 500) : null;
    // Undo stays on offer after the chat is gone, for what can still be taken back.
    const [undone] = await tx`select 1 from experience_undo where action_id = ${row.id}
      and reversal_action_id is not null`;
    // A room's work is undone under the room's rule, never alone from one person's list.
    const room = await roomAuthorityOf(tx, String(row.job_id));
    const plan =
      row.connection_id && !undone && !room
        ? await planReversal(tx, String(row.space_id), await loadAction(tx, String(row.id)))
        : null;
    const kept = plan && KEPT_REVERSALS.has(plan.kind) && !plan.connectionId ? plan : null;
    const undoUntil = kept
      ? (kept.validUntil ??
        new Date(new Date(row.happened_at).getTime() + UNDO_WINDOW_MS).toISOString())
      : null;
    await tx`insert into activity_record (id, space_id, principal_id, action_id, kind,
        effect_class, connection_id, connection_label, provider, destination, external_ref,
        outcome, source, happened_at, reversal, undo_until)
      values (${newId('act')}, ${row.space_id}, ${row.principal_id}, ${row.id}, ${row.kind},
        ${row.effect_class}, ${row.connection_id}, ${String(row.label ?? 'A connection').slice(0, 200)},
        ${String(row.provider ?? 'unknown')}, ${destinationOf(String(row.kind), payload)}, ${ref},
        ${row.status}, ${String(row.title ?? '').slice(0, 200)}, ${row.happened_at},
        ${kept ? JSON.stringify({ mode: kept.mode, kind: kept.kind, payload: kept.payload }) : null}::jsonb,
        ${undoUntil})
      on conflict (action_id) do nothing`;
  }
}

/**
 * Stop, withdraw, cancel and then delete these jobs. `ids` are already checked
 * to be the caller's. The first is the job the person asked to delete; the rest
 * belong to it (a chat's command jobs, a plan's steps). Refused with 409 while
 * anything of theirs is still on its way out.
 */
export async function removeJobs(
  deps: JobRemovalDeps,
  ids: readonly string[],
  forget?: ForgetSources,
): Promise<JobRemoval> {
  const { jobs } = deps;
  const list = [...new Set(ids)];
  if (!list.length) return { stopped: false, withdrawn: 0, forgotten: 0 };
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
    // Checked after the stop, which refuses anything parked. What is left is
    // on its way out, and the whole deletion waits for it: this rolls back.
    const pending = await tx
      .select({ status: action.status, kind: action.kind })
      .from(action)
      .where(
        and(
          inArray(action.jobId, list),
          inArray(action.status, IN_FLIGHT),
          sql`not (${action.effectClass} = 'read' and exists (select 1 from connection c
            where c.id = ${action.connectionId} and c.provider <> 'mcp'))`,
        ),
      );
    const refusal = inFlightRefusal(pending);
    if (refusal) throw refusal;
    return { stopped, withdrawn, cancelled };
  });
  // The fence is committed; now the runtime lets go before the rows go.
  for (const id of ended.cancelled) jobs.onCancelled?.(id);
  await deps.runner?.stopJobs(list);
  let fileKeys: BlobKey[] = [];
  await deps.sql.begin(async (tx) => {
    await tx`select id from job where id = any(${list}) order by id for update`;
    await refuseInFlight(tx, list);
    await keepActivity(tx, list);
    // A chat started from a deleted plan stays, no longer linked to it.
    await tx`update job set plan_id = null where plan_id = any(${list}) and not (id = any(${list}))`;
    // Rows that name a job without a cascade, then the jobs themselves, which
    // take their turns, events, attempts, actions, approvals and triggers.
    await tx`delete from submission where job_id = any(${list})`;
    await tx`delete from acceptance_journal where job_id = any(${list})`;
    await tx`delete from reply_obligation where job_id = any(${list})`;
    await tx`delete from notification where job_id = any(${list})`;
    await tx`update plan_milestone set child_job_id = null where child_job_id = any(${list})`;
    // Pointers from other rows to these jobs' actions, which go with them.
    await tx`update experience_undo set reversal_action_id = null
      where reversal_action_id in (select id from action where job_id = any(${list}))`;
    await tx`update experience_draft_send set send_action_id = null
      where send_action_id in (select id from action where job_id = any(${list}))`;
    // Rows that name the job with no key behind them. A company item it was
    // handling stays with the company; files it made stay with the space.
    await tx`update awaited_reply set job_id = null where job_id = any(${list})`;
    await tx`update ledger_item set job_id = null where job_id = any(${list})`;
    await tx`update ledger_item set last_job_id = null where last_job_id = any(${list})`;
    // A file recorded in a job's own workspace goes with the workspace.
    if (deps.workspaces)
      await tx`delete from artifact where job_id = any(${list}) and area = 'work'
        and source_job_id = job_id`;
    await tx`update artifact set source_job_id = null where source_job_id = any(${list})`;
    // The privacy router's per-conversation records hold sealed private
    // values; they mean nothing without the conversation.
    await tx`delete from privacy_vault where conversation_id = any(${list})`;
    await tx`delete from privacy_conversation where conversation_id = any(${list})`;
    await tx`delete from privacy_request where job_id = any(${list}) or conversation_id = any(${list})`;
    // What memory handed these jobs and what their outputs used. Memory itself,
    // the details and their sources, is untouched here. An output's manifest
    // names the output row, so it goes before the output.
    await tx`delete from memory_output_uses
      where output_row_id in (select id from memory_outputs where job_id = any(${list}))`;
    await tx`delete from memory_action_basis where job_id = any(${list})`;
    await tx`delete from memory_contexts where job_id = any(${list})`;
    await tx`delete from memory_prepared where job_id = any(${list})`;
    await tx`delete from memory_outputs where job_id = any(${list})`;
    await tx`delete from memory_repair_briefs where job_id = any(${list})`;
    await tx`delete from memory_invalidations where job_id = any(${list})`;
    // The agent's own notes from these chats go with what Melete learned from
    // them; otherwise they stay, no longer naming the chat.
    if (forget) await tx`delete from memory_agent_notes where job_id = any(${list})`;
    else await tx`update memory_agent_notes set job_id = null where job_id = any(${list})`;
    // The files sent in these chats, and the store's record that they need
    // their bytes; the bytes themselves go once this commits.
    fileKeys = await releaseJobAttachments(tx, list);
    const gone = await tx`delete from job where id = any(${list}) returning id`;
    if (!gone.some((row) => row.id === list[0]))
      throw new ServiceError('not_found', 'That item is not here.', 404);
  });
  // Bytes nothing else refers to go now. Without the store here, the collector
  // takes them once their grace period passes.
  if (deps.blobs && fileKeys.length) await purgeUnreferenced(deps.sql, deps.blobs, fileKeys);
  // The workspaces go to the trash once nothing can run in them again. One
  // that cannot go now is moved at the next start.
  if (deps.workspaces) {
    const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
    for (const id of list)
      await trashWorkspace(deps.workspaces, id).catch((error: unknown) =>
        log(
          `the workspace of ${id} could not be moved to the trash yet: ${error instanceof Error ? error.message : 'unknown error'}`,
        ),
      );
  }
  // Forgotten only now, after the jobs are gone, so nothing captured from them
  // in between is left behind. Then the capture log stops naming them.
  let forgotten = 0;
  if (forget) {
    const sources = await memorySourcesOf(deps.sql, list);
    if (sources.length) forgotten = await forget(sources);
  }
  await deps.sql`update memory_capture set job_id = null where job_id = any(${list})`;
  return { stopped: ended.stopped, withdrawn: ended.withdrawn, forgotten };
}

/**
 * The memory sources these jobs' own messages became. These are what "also
 * forget what Melete learned from this chat" removes: each through source
 * deletion, which takes every detail resting only on it and keeps any that
 * another source also supports.
 */
export async function memorySourcesOf(sql: Sql, jobIds: readonly string[]): Promise<string[]> {
  const rows = await sql`select distinct c.source_id from memory_capture c
    join memory_sources s on s.id = c.source_id
    where c.job_id = any(${[...jobIds]}) and c.outcome = 'remembered' and s.state = 'active'`;
  return rows.map((row) => String(row.source_id));
}

/**
 * Threads left by routines deleted before a deleted routine took its thread
 * with it. A migration listed them once (`orphaned_routine_thread`); each goes
 * the way a deleted chat goes, is logged, and comes off the list. One that
 * cannot go yet stays listed for the next start. Nothing else is scanned, so
 * once the list is empty a start costs one read of an empty table. Answers
 * how many went.
 */
export async function removeDeletedRoutineThreads(
  deps: JobRemovalDeps,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<number> {
  const rows = await deps.sql`select job_id from orphaned_routine_thread order by job_id`;
  let removed = 0;
  for (const row of rows) {
    const id = String(row.job_id);
    try {
      const [still] = await deps.sql`select kind from job where id = ${id}`;
      if (still?.kind === 'routine') {
        await removeJobs(deps, [id]);
        log(`removed the thread ${id} that a deleted routine left behind`);
        removed += 1;
      }
      await deps.sql`delete from orphaned_routine_thread where job_id = ${id}`;
    } catch (error) {
      log(
        `the thread ${id} that a deleted routine left behind could not be removed yet: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
  return removed;
}
