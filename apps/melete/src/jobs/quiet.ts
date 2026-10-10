/**
 * Queues whose workers wait to be told about work instead of asking the
 * database for it twice a second.
 *
 * pg-boss sends a notice when a job that can run now is committed to a queue
 * with `notify` set, and wakes that queue's workers at once; while notices
 * arrive it asks the database only every 30 seconds. A job that can run only
 * later sends no notice: one sent with a start time, and a retry after a
 * failure. `startDueWaker` looks for the next such job every few seconds and
 * sends the queue its notice when the job is due: on time when the job was
 * sent more than one look ahead, and at most one look late otherwise.
 *
 * Without notices (the connection refuses LISTEN), pg-boss polls these queues
 * at their own rate again.
 */

import type { PgBoss, WorkHandler, WorkOptions } from 'pg-boss';
import { notifyChannelSql } from 'pg-boss/dist/plans.js';

/** How long the waker waits, at most, before looking for due jobs again. */
export const DUE_SCAN_MS = 5_000;
/** After it wakes a queue whose job is still waiting, it looks again this soon, then less often. */
const RECHECK_MS = 1_000;

/** Create `name` if needed and have its workers woken by notices. */
export async function quietQueue(boss: PgBoss, name: string): Promise<void> {
  await boss.createQueue(name);
  await boss.updateQueue(name, { notify: true });
}

/**
 * Work a queue whose workers are woken by notices. A notice wakes a worker
 * once, and otherwise it waits half a minute between looks; so after it handles
 * a job, it and the queue's other workers here look again at once. Work that
 * piled up, such as many jobs due at the same moment, is then done at the
 * handler's pace, and a look that finds nothing sends the workers back to
 * waiting.
 */
export async function workQuiet<ReqData>(
  boss: PgBoss,
  name: string,
  options: WorkOptions,
  handler: WorkHandler<ReqData>,
): Promise<string> {
  await quietQueue(boss, name);
  return boss.work<ReqData>(name, options, async (jobs) => {
    try {
      return await handler(jobs);
    } finally {
      for (const worker of boss.getWipData())
        if (worker.name === name) boss.notifyWorker(worker.id);
    }
  });
}

type DueRow = { name: string; wait_ms: number | string };

/**
 * Wakes notify-enabled queues when a job that sent no notice becomes due. One
 * query every few seconds, whatever the number of workers, replaces each
 * worker's own polling. Every instance runs one; a notice reaches the workers
 * of every instance.
 */
export function startDueWaker(
  boss: PgBoss,
  {
    schema = 'pgboss',
    scanMs = DUE_SCAN_MS,
    say = (line: string) => process.stderr.write(`${line}\n`),
  }: { schema?: string; scanMs?: number; say?: (line: string) => void } = {},
) {
  const channel = notifyChannelSql(schema);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let recheck = RECHECK_MS;
  let failing = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(scan, Math.max(0, Math.min(ms, scanMs)));
    timer.unref?.();
  };

  async function pass(): Promise<number> {
    const db = boss.getDb();
    // Jobs a worker could take but for their start time: the fetch index covers these.
    const { rows } = await db.executeSql(
      `select name, extract(epoch from min(start_after) - now()) * 1000 as wait_ms
       from ${schema}.job
       where name in (select name from ${schema}.queue where notify)
         and state < 'active' and not blocked
       group by name`,
    );
    const due: string[] = [];
    let next = scanMs;
    for (const row of rows as DueRow[]) {
      const wait = Number(row.wait_ms);
      if (wait <= 0) due.push(row.name);
      else next = Math.min(next, wait);
    }
    if (due.length) {
      await db.executeSql(`select pg_notify(${channel}, name) from unnest($1::text[]) as name`, [
        due,
      ]);
      // A job still waiting after its notice has busy workers, or none here: ask again
      // soon, and less often while it keeps waiting.
      next = Math.min(next, recheck);
      recheck = Math.min(recheck * 2, scanMs);
    } else recheck = RECHECK_MS;
    return next;
  }

  function scan() {
    if (stopped || running) return;
    running = pass()
      .then((next) => {
        if (failing) say('queue: due jobs are being found again');
        failing = false;
        schedule(next);
      })
      .catch((error: unknown) => {
        if (!failing)
          say(`queue: due jobs could not be looked for: ${(error as Error)?.message ?? error}`);
        failing = true;
        schedule(scanMs);
      })
      .finally(() => {
        running = undefined;
      });
  }

  scan();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
