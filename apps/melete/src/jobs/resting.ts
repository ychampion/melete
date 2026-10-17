/**
 * Standing work for people who stopped coming, and how much of it one person
 * may keep. Both are settings of the person who runs the installation, and
 * both are off unless set:
 *
 * - `MELETE_REST_ROUTINES_AFTER_DAYS`: a person unseen for that many days has
 *   their routines, watches and other standing work rest. Nothing is turned
 *   off: a wake that comes while they rest is let pass, so the times they miss
 *   are never run late. The next time they are seen, each trigger counts from
 *   then, and they are told in one line that their routines are back on.
 * - `MELETE_ROUTINES_PER_PERSON_MAX`: a routine past the limit is refused with
 *   a sentence the assistant can pass on.
 */
import { sql } from 'drizzle-orm';
import { ServiceError } from '../api/errors.ts';
import type { Database } from '../db/client.ts';
import { serviceTransaction, type Transaction } from '../db/transaction.ts';
import { PROCESS_WATCH_SQL } from './triggers.ts';

export type StandingWorkSettings = {
  /** Days unseen before a person's standing work rests. Unset: it never rests. */
  restAfterDays?: number;
  /** Routines and repeating work one person may keep. Unset: no limit. */
  routinesPerPerson?: number;
};

/** What the person reads once their routines are back on. */
export const ROUTINES_BACK_LINE =
  'Your routines rested while you were away and are back on. They pick up from their next time; the times you missed were not run.';

/** How long the line stays where the person looks first. */
export const ROUTINES_BACK_SHOWN_MS = 2 * 24 * 60 * 60_000;

/** A person is seen again at most this often, so a busy session writes nothing more. */
export const SEEN_EVERY_MS = 5 * 60_000;

const TERMINAL = sql.raw(`('completed', 'failed', 'cancelled')`);

/**
 * Whether a job's standing work rests now: the setting is on and the person
 * the job works for has not been seen for that many days. A room's own
 * principal never signs in, so a room's work never rests on its account.
 */
export async function personResting(
  tx: Transaction,
  principalId: string | null,
  restAfterDays: number | undefined,
): Promise<boolean> {
  if (!restAfterDays || !principalId) return false;
  const [row] = await tx.execute(sql`select 1 as away from principal
    where id = ${principalId} and kind in ('person', 'guest')
      and last_seen_at < now() - make_interval(days => ${restAfterDays})`);
  return Boolean(row);
}

/**
 * What one person keeps standing: work not yet ended that wakes on a schedule
 * or a watch, paused or not. Routines always have their schedule. A watch on a
 * process belongs to work under way and is not counted. `except` is a job
 * being set up in this transaction, counted by the caller. Read from the
 * trigger table, which holds only standing work, never by scanning all jobs.
 */
export async function routinesKept(
  tx: Pick<Transaction, 'execute'>,
  principalId: string,
  except?: string,
): Promise<number> {
  const [row] = await tx.execute(sql`select count(distinct t.job_id)::int as n
    from trigger t join job j on j.id = t.job_id
    where j.principal_id = ${principalId}
      and j.state not in ${TERMINAL}
      and (${except ?? null}::text is null or j.id <> ${except ?? null})
      and not (${sql.raw(PROCESS_WATCH_SQL('t'))})`);
  return Number((row as { n?: unknown } | undefined)?.n ?? 0);
}

/** Whether the job already stands on something other than a process watch, and so is already counted. */
export async function alreadyStanding(
  tx: Pick<Transaction, 'execute'>,
  jobId: string,
): Promise<boolean> {
  const [row] = await tx.execute(sql`select 1 as standing from trigger t
    where t.job_id = ${jobId} and not (${sql.raw(PROCESS_WATCH_SQL('t'))}) limit 1`);
  return Boolean(row);
}

/**
 * Refuses one more routine for a person who already keeps as many as the
 * installation allows. Called in the transaction that would add it, which
 * holds the event order, so two at once are counted one after the other.
 */
export async function checkRoutineRoom(
  tx: Transaction,
  principalId: string | null,
  routinesPerPerson: number | undefined,
  except?: string,
): Promise<void> {
  if (!routinesPerPerson || !principalId) return;
  const kept = await routinesKept(tx, principalId, except);
  if (kept < routinesPerPerson) return;
  throw new ServiceError(
    'too_many_routines',
    `You already have ${kept} routines, the most this installation keeps for one person. Delete or end one you no longer need, then add this one.`,
    409,
  );
}

const lastMarked = new Map<string, number>();

/**
 * The person was seen: they signed in, used the app or reached their
 * assistant through a channel. Recorded at most every few minutes. When it
 * ends a rest, every trigger of theirs counts from now, so nothing that came
 * while they were away is acted on in a burst, and the person is told.
 * Returns true when it ended a rest.
 */
export async function markSeen(
  db: Database,
  principalId: string,
  restAfterDays: number | undefined,
  now = Date.now(),
): Promise<boolean> {
  const last = lastMarked.get(principalId);
  if (last !== undefined && now - last < SEEN_EVERY_MS) return false;
  lastMarked.set(principalId, now);
  // Not recorded: the next request tries again rather than a few minutes on.
  return record(db, principalId, restAfterDays).catch((error: unknown) => {
    if (lastMarked.get(principalId) === now) lastMarked.delete(principalId);
    throw error;
  });
}

async function record(
  db: Database,
  principalId: string,
  restAfterDays: number | undefined,
): Promise<boolean> {
  const [state] = await db.execute(sql`select
      last_seen_at < now() - make_interval(secs => ${SEEN_EVERY_MS / 1000}) as stale,
      (${restAfterDays ?? null}::int is not null
        and last_seen_at < now() - make_interval(days => ${restAfterDays ?? 0})) as away
    from principal where id = ${principalId}`);
  const seen = state as { stale?: unknown; away?: unknown } | undefined;
  if (!seen?.stale) return false;
  if (!seen.away) {
    await db.execute(sql`update principal set last_seen_at = now()
      where id = ${principalId}
        and last_seen_at < now() - make_interval(secs => ${SEEN_EVERY_MS / 1000})`);
    return false;
  }
  // The event order is held, so no event below the newest one is still to commit.
  return serviceTransaction(db, async (tx) => {
    const [prior] = await tx.execute(sql`select
        last_seen_at < now() - make_interval(days => ${restAfterDays ?? 0}) as away
      from principal where id = ${principalId} for update`);
    await tx.execute(sql`update principal set last_seen_at = now() where id = ${principalId}`);
    // Another request ended the rest first.
    if (!(prior as { away?: unknown } | undefined)?.away) return false;
    // A watch on a process belongs to work under way, not to standing work; it
    // never rested, and moving it on could lose the end it waits for. For the
    // same reason a trigger stops short of the result of an operation its work
    // started that it has not read yet.
    const moved = await tx.execute(sql`update trigger t
      set cursor = coalesce(
        (select min(e.seq) - 1 from event e
          where e.job_id = t.job_id and e.type = 'notice'
            and e.seq > (case when t.cursor ~ '^[0-9]{1,18}$' then t.cursor::bigint else 0 end)
            and e.payload->>'kind' = 'operation_event'
            and e.payload->>'trigger_id' = t.id and e.payload ? 'operation_id'),
        (select coalesce(max(seq), 0) from event))::text
      from job j
      where j.id = t.job_id and j.principal_id = ${principalId}
        and j.state not in ${TERMINAL} and t.enabled
        and not (${sql.raw(PROCESS_WATCH_SQL('t'))})
      returning t.id`);
    if (!moved.length) return false;
    await tx.execute(
      sql`update principal set routines_resumed_at = now() where id = ${principalId}`,
    );
    return true;
  });
}

/** The line the person sees where they look first, while their routines have just come back. */
export async function routinesBackLine(db: Database, principalId: string): Promise<string | null> {
  const [row] = await db.execute(sql`select 1 as back from principal
    where id = ${principalId}
      and routines_resumed_at > now() - make_interval(secs => ${ROUTINES_BACK_SHOWN_MS / 1000})`);
  return row ? ROUTINES_BACK_LINE : null;
}

/** For tests: forget when people were last marked seen in this process. */
export function forgetSeen(): void {
  lastMarked.clear();
}
