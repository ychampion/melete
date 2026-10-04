/**
 * Why an attempt is starting, and the guard on work that keeps waking for
 * nothing.
 *
 * An attempt is interactive when a person is waiting on it, judged from what
 * caused this attempt alone: their message (or their answer) is among its new
 * inputs, they decided one of its approvals, they started the work or its
 * test themselves, or it picks up an interactive attempt that was cut off
 * before it finished. Otherwise a trigger, a schedule or a timer woke it, and
 * it is background work, in a conversation the person has spoken in as much
 * as anywhere. The class is written on the attempt and every model call it
 * makes is counted under it (`gateway/usage-class.ts`).
 *
 * The wake guard is always on. Work woken `WAKE_GUARD_LIMIT` times in a row
 * within an hour, each time running the model and going back to rest with
 * nothing to show for it, is stopped before the next wake does anything, and
 * the person is told once, in plain words. Something to show is a finding or
 * an effect: a run entry other than its plan, notes and handoffs, or an
 * action that is more than a read. A wake the matching dropped never starts
 * an attempt, and a wake that ran no model (one refused at a spending limit,
 * say) is not counted, so only work that really spends and finds nothing is
 * stopped.
 *
 * Stopping never loses input. A run or a routine is paused, except that its
 * watches and connection triggers stay on with their cursors where they were:
 * what arrives while it is paused waits, and reaches it once it is resumed.
 * Only a schedule is turned off, since a missed time is not something that
 * happened. Anything else (a conversation an agent left watching, say) asks
 * the person instead, so their next message carries on from it. One wake
 * that shows something resets the count, and so does resuming.
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

/** Kinds of run entry that are findings or results, as opposed to plans, notes and handoffs. */
const PROGRESS_RUN_ENTRIES = [
  'finding',
  'decision',
  'experiment',
  'report',
  'proposed',
  'check',
  'finished',
  'step_started',
];

/** The notice a person's own start of work leaves, read as its next attempt's cause. */
export const PERSON_STARTED = 'person_started';

export type AttemptCause = {
  usageClass: UsageClass;
  triggerId: string | null;
  /** The situation that woke it, when a situation handed it the wake. */
  situationId: string | null;
};

/**
 * Why the attempt about to start on `row` is starting. `afterSeq` is the
 * previous attempt's input cursor: what came after it is this attempt's input.
 */
export async function attemptCause(
  tx: Transaction,
  row: Pick<JobRow, 'id' | 'currentTurnId'>,
  previous:
    | {
        turnId: string | null;
        usageClass: string;
        outcome: string | null;
        outcomeDetail: unknown;
        endedAt: Date | null;
        leaseStatus: string;
      }
    | undefined,
  afterSeq: number,
): Promise<AttemptCause> {
  const [inputs] = await tx.execute<{
    said: boolean;
    decided: boolean;
    started: boolean;
    trigger_id: string | null;
    situation_id: string | null;
  }>(
    sql`select
      coalesce(bool_or(e.type = 'notice' and e.payload->>'kind' = 'user_message'), false) as said,
      coalesce(bool_or(e.type = 'approval_decided' and exists (
        select 1 from approval a join principal p on p.id = a.decided_by
        where a.id = e.payload->>'approval_id')), false) as decided,
      coalesce(bool_or(e.type = 'notice' and e.payload->>'kind' = ${PERSON_STARTED}), false) as started,
      (array_agg(e.payload->>'trigger_id' order by e.seq desc)
        filter (where e.type = 'notice' and e.payload->>'kind' = 'trigger_event'))[1] as trigger_id,
      (array_agg(e.payload->'event'->>'situation_id' order by e.seq desc)
        filter (where e.type = 'notice' and e.payload->>'kind' = 'trigger_event'
          and e.payload->'event' ? 'situation_id'))[1] as situation_id
    from ${event} e where e.job_id = ${row.id} and e.seq > ${afterSeq}`,
  );
  // Picking up the same turn counts only when the interactive attempt before
  // was cut off (still open, lost, superseded, or failed in a way to be tried
  // again). One that went back to rest, asked, finished, failed for good or
  // stopped at a limit leaves the next wake to its own cause.
  const cutOff =
    previous !== undefined &&
    (previous.endedAt === null ||
      previous.leaseStatus === 'lost' ||
      previous.outcome === 'fenced' ||
      (previous.outcome === 'failed' &&
        (previous.outcomeDetail as { retryable?: unknown } | null)?.retryable === true));
  const continuing =
    cutOff &&
    previous?.usageClass === 'interactive' &&
    previous.turnId !== null &&
    previous.turnId === row.currentTurnId;
  return {
    usageClass:
      inputs?.said || inputs?.decided || inputs?.started || continuing
        ? 'interactive'
        : 'background',
    triggerId: inputs?.trigger_id ?? null,
    situationId: inputs?.situation_id ?? null,
  };
}

/** Records that the person started this work themselves, so its next attempt is theirs. */
export async function personStarted(
  tx: Transaction,
  jobId: string,
  principalId: string | null,
): Promise<void> {
  await appendEvent(tx, {
    jobId,
    type: 'notice',
    payload: { kind: PERSON_STARTED, principal_id: principalId },
    dedupKey: `${jobId}:${PERSON_STARTED}:${newId('op')}`,
  });
}

/**
 * Background wakes of this job in a row, newest first, that started within
 * the window, ran the model, and rested again with nothing to show. Counting
 * stops at the first attempt that showed something, was interactive, is
 * older, or came before the guard last paused this work. An attempt that ran
 * no model (refused at a limit, or settled without an engine) is passed over:
 * it neither counts nor ends the count.
 */
export async function emptyWakes(tx: Transaction, jobId: string): Promise<number> {
  const rows = await tx.execute<{ empty: boolean }>(
    sql`select (a.class = 'background'
        and a.outcome = 'waiting_for_event_or_time'
        and a.started_at > now() - make_interval(secs => ${WAKE_GUARD_WINDOW_MS / 1000})
        and a.started_at > coalesce((select max(e.created_at) from event e
          where e.job_id = a.job_id and e.type = 'notice'
            and e.payload->>'reason' = 'wake_guard'), '-infinity'::timestamptz)
        and not exists (select 1 from action x where x.attempt_id = a.id
          and x.effect_class <> 'read')
        and not exists (select 1 from run_entry r where r.attempt_id = a.id
          and r.kind in ${PROGRESS_RUN_ENTRIES})
      ) as empty
    from attempt a where a.job_id = ${jobId} and a.ended_at is not null
      and a.outcome is distinct from 'fenced'
      and coalesce((a.usage->>'requests')::int, 0) > 0
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
 * Pauses work the guard stopped: it starts nothing until resumed. Its
 * schedule is turned off; its watches and connection triggers stay on with
 * their cursors where they were, so what arrives meanwhile waits for it. The
 * person is told once per pause, on the work itself and as a notification.
 */
export async function pauseForWakes(tx: Transaction, row: JobRow): Promise<void> {
  await tx.update(job).set({ paused: true, updatedAt: new Date() }).where(eq(job.id, row.id));
  await tx
    .update(trigger)
    .set({ enabled: false })
    .where(and(eq(trigger.jobId, row.id), eq(trigger.enabled, true), eq(trigger.kind, 'schedule')));
  await tellOnce(tx, row, WAKE_GUARD_MESSAGE, `wake-guard:${row.id}:${row.leaseEpoch}`);
}

/**
 * Tells the person why their work stopped, once per `key`: a notice on the
 * work and a notification. `reason` is the wake guard, or a spending limit
 * the work now rests until.
 */
export async function tellOnce(
  tx: Transaction,
  row: JobRow,
  message: string,
  key: string,
  reason: 'wake_guard' | 'spending_limit' = 'wake_guard',
): Promise<void> {
  const told = await appendEvent(tx, {
    jobId: row.id,
    type: 'notice',
    payload: {
      kind: isRunKind(row.kind) ? 'run_paused' : 'paused',
      reason,
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
      title: clip(`${row.title}: ${reason === 'wake_guard' ? 'paused' : 'waiting'}`, 120),
      body: message,
      because:
        reason === 'wake_guard'
          ? 'Because it kept waking with nothing to show.'
          : 'Because background work reached its spending limit.',
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
