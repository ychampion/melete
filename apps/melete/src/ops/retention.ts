/**
 * How long the record of each model call, and what connected accounts
 * reported that nothing used, is kept when the operator sets
 * `MELETE_RETENTION_DAYS`. Unset, nothing here runs and both are kept.
 *
 * - `model_usage`: one row per model call. A day's calls are summed into
 *   `usage_day` first (written here when that day has no roll-up yet), so the
 *   usage chart, background cost and every per-day figure keep their history.
 *   This month's spending, the spending alerts (a week back) and the roll-up
 *   (five weeks back) read the rows themselves, which is why the setting is
 *   35 days or more.
 * - `event`: only connector events no job owns: what a connected account,
 *   a process or a hand-off reported. A job's events are its conversation and
 *   what its agent reads next time, so they stay as long as the job does. An
 *   event a job or a situation cites, one a listening trigger has not read
 *   yet, one an open "needs you" item points at, and mail an open wait on a
 *   reply may still be checked against are kept; each removed one leaves its
 *   delivery key, so it is not delivered twice.
 *
 * Rows go a small batch at a time, oldest first, each batch its own short
 * transaction that never takes the event order lock and skips rows another
 * transaction holds. A pass stops after a set number of batches, so a large
 * backlog goes over several passes.
 */
import type { Sql } from 'postgres';
import { rollupFinishedDays, utcDay } from '../gateway/usage-day.ts';
import { pruneObservations } from '../signals/retention.ts';

const DAY_MS = 86_400_000;
/** The shortest setting: a calendar month of spending and the roll-up's five weeks. */
export const RETENTION_MIN_DAYS = 35;
/** Most rows one batch removes. */
export const RETENTION_BATCH = 2_000;
/** Most batches one pass runs for each table. */
export const RETENTION_MAX_BATCHES = 100;
/** How long a batch waits for a lock before it gives up until the next pass. */
const LOCK_TIMEOUT = '5s';

export type RetentionOptions = { batch?: number; maxBatches?: number };
export type RetentionResult = { modelUsage: number; events: number; rolledUp: string[] };

/** The start of the UTC day `days` days before `now`'s; rows before it go. */
export function retentionCutoff(days: number, now = new Date()): Date {
  if (!Number.isInteger(days) || days < RETENTION_MIN_DAYS)
    throw new Error(`retention must be at least ${RETENTION_MIN_DAYS} days`);
  return new Date(Date.parse(`${utcDay(now)}T00:00:00.000Z`) - days * DAY_MS);
}

/**
 * Removes model calls made before `cutoff`, once each of their days has a
 * roll-up. Answers how many went and which days were rolled up first.
 */
export async function pruneModelUsage(
  sql: Sql,
  cutoff: Date,
  now = new Date(),
  options: RetentionOptions = {},
): Promise<{ removed: number; rolledUp: string[] }> {
  const [oldest] = await sql`select min(created_at) as at from model_usage
    where created_at < ${cutoff.toISOString()}::timestamptz`;
  if (!oldest?.at) return { removed: 0, rolledUp: [] };
  // A day that has calls and no roll-up gets one before its calls go; a day
  // already rolled up is not written again, since its calls may be going.
  const rolledUp = await rollupFinishedDays(sql, now, utcDay(new Date(oldest.at)));
  const batch = options.batch ?? RETENTION_BATCH;
  const maxBatches = options.maxBatches ?? RETENTION_MAX_BATCHES;
  let removed = 0;
  for (let index = 0; index < maxBatches; index++) {
    const count = await sql.begin(async (tx) => {
      await tx`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      const gone = await tx`delete from model_usage where id in (
          select id from model_usage
          where created_at < ${cutoff.toISOString()}::timestamptz
          order by created_at
          limit ${batch}
          for update skip locked)`;
      return gone.count;
    });
    removed += count;
    if (count < batch) break;
  }
  return { removed, rolledUp };
}

/** Removes connector events before `cutoff` that no job owns and nothing holds. */
export async function pruneConnectorEvents(
  sql: Sql,
  cutoff: Date,
  options: RetentionOptions = {},
): Promise<number> {
  const batch = options.batch ?? RETENTION_BATCH;
  const maxBatches = options.maxBatches ?? RETENTION_MAX_BATCHES;
  let removed = 0;
  for (let index = 0; index < maxBatches; index++) {
    const count = await sql.begin(async (tx) => {
      await tx`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
      return pruneObservations(tx, {
        before: cutoff,
        keepTriaged: true,
        anyName: true,
        limit: batch,
      });
    });
    removed += count;
    if (count < batch) break;
  }
  return removed;
}

/** One pass over both tables. */
export async function applyRetention(
  sql: Sql,
  days: number,
  now = new Date(),
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const cutoff = retentionCutoff(days, now);
  const usage = await pruneModelUsage(sql, cutoff, now, options);
  const events = await pruneConnectorEvents(sql, cutoff, options);
  return { modelUsage: usage.removed, events, rolledUp: usage.rolledUp };
}

/**
 * Runs a pass now and every hour after, on the instance that leads it; the
 * others skip the pass. Without `days` nothing runs. Answers how to stop it.
 */
export function startRetention(
  sql: Sql,
  days: number | undefined,
  leads: () => boolean | Promise<boolean> = () => true,
  say: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): () => void {
  if (days === undefined) return () => {};
  let running = false;
  const pass = () => {
    if (running) return;
    running = true;
    void Promise.resolve(leads())
      .then((leading) => (leading ? applyRetention(sql, days) : undefined))
      .catch((error: unknown) =>
        say(`retention failed: ${String((error as Error)?.message ?? error)}`),
      )
      .finally(() => {
        running = false;
      });
  };
  pass();
  const timer = setInterval(pass, 60 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
