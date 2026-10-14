import { ItemFailures } from '../ops/item-failures.ts';
import { type Commits, quietLoop } from '../ops/quiet-loop.ts';
import type { MemorySql } from './db.ts';

/**
 * Delivers the jobs memory invalidated to the job service. Whichever runtime
 * carries attempts, an invalidation writes a `job_recompute` outbox row; this is
 * what turns that row into a wake and marks it done. It looks every quarter
 * second while rows keep arriving, when a change is committed, and otherwise
 * at most every `idleMs`.
 */
export function startJobRecompute(
  sql: MemorySql,
  onJobRecompute: (jobId: string) => Promise<void>,
  {
    intervalMs = 250,
    idleMs = 5_000,
    wakeOn,
  }: { intervalMs?: number; idleMs?: number; wakeOn?: Commits } = {},
) {
  // A wake that fails waits from five seconds, doubling up to half an hour,
  // and is left out of the query meanwhile, so it never holds up the others.
  const failures = new ItemFailures('memory job wakes', { firstMs: 5_000, maxMs: 30 * 60_000 });
  const loop = quietLoop(
    async () => {
      const rows = await sql`select id, target_id, space_id from memory_outbox
        where kind = 'job_recompute' and completed_at is null
          and id <> all(${failures.waiting()}::text[])
        order by created_at, id limit 20`;
      for (const row of rows) {
        const id = row.id as string;
        try {
          // Enqueue commits before acknowledging the outbox. A crash can repeat
          // a wake, which the job's epoch/version gate already deduplicates.
          await onJobRecompute(row.target_id as string);
          await sql`update memory_outbox set completed_at = clock_timestamp() where id = ${id}`;
          failures.succeeded(id);
        } catch (error) {
          failures.failed(id, error, `job ${row.target_id} in ${row.space_id}`);
        }
      }
      return rows.length > 0;
    },
    {
      busyMs: intervalMs,
      idleMs,
      wakeOn,
      onError: () => {
        process.stderr.write('memory: job_recompute_delivery_failed\n');
      },
    },
  );
  return { stop: () => loop.stop() };
}
