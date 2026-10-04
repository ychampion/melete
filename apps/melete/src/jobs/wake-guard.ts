/**
 * Why an attempt is starting, and the guard on work that keeps waking for
 * nothing.
 *
 * An attempt is interactive when a person is waiting on it: their message (or
 * their answer) is among its new inputs, they decided one of its approvals,
 * or it carries on the turn an interactive attempt began. Otherwise a
 * trigger, a schedule or a timer woke it, and it is background work. The
 * class is written on the attempt and every model call it makes is counted
 * under it (`gateway/usage-class.ts`).
 *
 * The wake guard is always on. Work woken `WAKE_GUARD_LIMIT` times in a row
 * within an hour, each time going back to rest with nothing to show for it
 * (no report, no question, no action, no draft), is stopped before the next
 * wake does anything, and the person is told once, in plain words. A run or
 * a routine is paused, the way the person pauses it; anything else (a
 * conversation an agent left watching, say) asks the person instead, so
 * their next message carries on from it. It is a guard against a loop, not a
 * budget: one wake that shows something resets it, and so does resuming.
 */
import { isRunKind } from '@melete/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { attempt, event, job, pushIntent, trigger } from '../db/schema.ts';
import type { Transaction } from '../db/transaction.ts';
import { appendEvent } from '../events/store.ts';
import type { UsageClass } from '../gateway/usage-class.ts';
import { newId } from '../ids.ts';
import type { JobRow } from './service.ts';

/** Wakes in a row with nothing to show, within `WAKE_GUARD_WINDOW_MS`, that pause the work. */
export const WAKE_GUARD_LIMIT = 30;
export const WAKE_GUARD_WINDOW_MS = 60 * 60_000;

/** What the person reads when the guard pauses their work. */
export const WAKE_GUARD_MESSAGE = `It woke ${WAKE_GUARD_LIMIT} times in the last hour with nothing new to show, so it is paused. Resume it when you want it to keep going.`;

/** What the person is asked when the guard stops work it does not pause. */
export const WAKE_GUARD_QUESTION = `This woke ${WAKE_GUARD_LIMIT} times in the last hour with nothing new to show, so it has stopped for now. Should it keep going?`;

/** Work the guard pauses, which the person resumes; anything else asks them. */
export const guardPauses = (kind: string) => isRunKind(kind) || kind === 'routine';

/** Kinds of run entry a person sees as a result. */
const SHOWN_RUN_ENTRIES = ['report', 'proposed', 'finished'];

export type AttemptCause = { usageClass: UsageClass; triggerId: string | null };

/**
 * Why the attempt about to start on `row` is starting. `afterSeq` is the
 * previous attempt's input cursor: what came after it is this attempt's input.
 */
export async function attemptCause(
  tx: Transaction,
  row: Pick<JobRow, 'id' | 'currentTurnId'>,
  previous: { turnId: string | null; usageClass: string } | undefined,
  afterSeq: number,
): Promise<AttemptCause> {
  const [inputs] = await tx.execute<{ said: boolean; decided: boolean; trigger_id: string | null }>(
    sql`select
      coalesce(bool_or(e.type = 'notice' and e.payload->>'kind' = 'user_message'), false) as said,
      coalesce(bool_or(e.type = 'approval_decided' and exists (
        select 1 from approval a join principal p on p.id = a.decided_by
        where a.id = e.payload->>'approval_id')), false) as decided,
      (array_agg(e.payload->>'trigger_id' order by e.seq desc)
        filter (where e.type = 'notice' and e.payload->>'kind' = 'trigger_event'))[1] as trigger_id
    from ${event} e where e.job_id = ${row.id} and e.seq > ${afterSeq}`,
  );
  const continuing =
    previous?.usageClass === 'interactive' &&
    previous.turnId !== null &&
    previous.turnId === row.currentTurnId;
  return {
    usageClass: inputs?.said || inputs?.decided || continuing ? 'interactive' : 'background',
    triggerId: inputs?.trigger_id ?? null,
  };
}

/**
 * Background wakes of this job in a row, newest first, that started within
 * the window and rested again with nothing to show. Counting stops at the
 * first attempt that showed something, was interactive, is older, or came
 * before the guard last paused this work.
 */
export async function emptyWakes(tx: Transaction, jobId: string): Promise<number> {
  const rows = await tx.execute<{ empty: boolean }>(
    sql`select (a.class = 'background'
        and a.outcome = 'waiting_for_event_or_time'
        and a.started_at > now() - make_interval(secs => ${WAKE_GUARD_WINDOW_MS / 1000})
        and a.started_at > coalesce((select max(e.created_at) from event e
          where e.job_id = a.job_id and e.type = 'notice'
            and e.payload->>'reason' = 'wake_guard'), '-infinity'::timestamptz)
        and not exists (select 1 from action x where x.attempt_id = a.id)
        and not exists (select 1 from run_entry r where r.attempt_id = a.id
          and r.kind in ${SHOWN_RUN_ENTRIES})
      ) as empty
    from attempt a where a.job_id = ${jobId} and a.ended_at is not null
      and a.outcome is distinct from 'fenced'
    order by a.epoch desc limit ${WAKE_GUARD_LIMIT}`,
  );
  let count = 0;
  for (const row of rows) {
    if (!row.empty) break;
    count++;
  }
  return count;
}

/**
 * Pauses work the guard stopped, the way the person pauses it: its triggers
 * are turned off and it starts nothing until resumed. The person is told once
 * per pause, on the work itself and as a notification.
 */
export async function pauseForWakes(tx: Transaction, row: JobRow): Promise<void> {
  await tx.update(job).set({ paused: true, updatedAt: new Date() }).where(eq(job.id, row.id));
  await tx
    .update(trigger)
    .set({ enabled: false })
    .where(and(eq(trigger.jobId, row.id), eq(trigger.enabled, true)));
  await tellOnce(tx, row, WAKE_GUARD_MESSAGE, `wake-guard:${row.id}:${row.leaseEpoch}`);
}

/**
 * Tells the person what the guard did, once per `key`: a notice on the work
 * and a notification.
 */
export async function tellOnce(
  tx: Transaction,
  row: JobRow,
  message: string,
  key: string,
): Promise<void> {
  const told = await appendEvent(tx, {
    jobId: row.id,
    type: 'notice',
    payload: {
      kind: isRunKind(row.kind) ? 'run_paused' : 'paused',
      reason: 'wake_guard',
      message,
    },
    dedupKey: key,
  });
  if (!told) return;
  const [person] = await tx.execute<{ id: string | null }>(
    sql`select coalesce(j.principal_id, s.owner_principal_id) as id
      from job j join space s on s.id = j.space_id where j.id = ${row.id}`,
  );
  if (!person?.id) return;
  await tx
    .insert(pushIntent)
    .values({
      id: newId('pint'),
      principalId: person.id,
      kind: 'progress',
      title: clip(`${row.title}: paused`, 120),
      body: message,
      because: 'Because it kept waking with nothing to show.',
      url: isRunKind(row.kind) ? `/#/runs/${row.id}` : `/#/chat/${row.id}`,
      dedupKey: key,
    })
    .onConflictDoNothing({ target: pushIntent.dedupKey });
}

const clip = (text: string, length: number) =>
  text.length > length ? `${text.slice(0, length - 1)}…` : text;

/** The class recorded on an attempt when it started; interactive when it is gone. */
export async function usageClassOf(tx: Transaction, attemptId: string): Promise<UsageClass> {
  const [row] = await tx
    .select({ usageClass: attempt.usageClass })
    .from(attempt)
    .where(eq(attempt.id, attemptId));
  return row?.usageClass === 'background' ? 'background' : 'interactive';
}
