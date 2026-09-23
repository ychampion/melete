import type { MemorySql } from './db.ts';

/**
 * Delivers the jobs memory invalidated to the job service. Whichever runtime
 * carries attempts, an invalidation writes a `job_recompute` outbox row; this is
 * what turns that row into a wake and marks it done.
 */
export function startJobRecompute(
  sql: MemorySql,
  onJobRecompute: (jobId: string) => Promise<void>,
  intervalMs = 250,
) {
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending) return;
    pending = (async () => {
      const rows = await sql`select id, target_id from memory_outbox
        where kind = 'job_recompute' and completed_at is null order by created_at, id limit 20`;
      for (const row of rows) {
        // Enqueue commits before acknowledging the outbox. A crash can repeat
        // a wake, which the job's epoch/version gate already deduplicates.
        await onJobRecompute(row.target_id as string);
        await sql`update memory_outbox set completed_at = clock_timestamp() where id = ${row.id}`;
      }
    })()
      .catch(() => {
        process.stderr.write('memory: job_recompute_delivery_failed\n');
      })
      .finally(() => {
        pending = undefined;
      });
  }, intervalMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}
