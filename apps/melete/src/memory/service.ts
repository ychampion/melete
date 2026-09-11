import type { PgBoss } from 'pg-boss';
import { commitExtraction } from './commit.ts';
import { lockSpace, MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { type ExtractionGateway, proposeExtraction } from './extract.ts';
import { cleanupMemory, type DerivedCleanup } from './forget.ts';
import type { MarkdownViews } from './markdown.ts';
import { type RestrictionJournal, restoreMemory } from './restore.ts';
import { type EmbeddingProvider, runViewWork } from './views.ts';
import {
  checkLease,
  claimWork,
  finishWork,
  MEMORY_EXTRACT_QUEUE,
  repairQueue,
  retryWork,
  startRecoveryScan,
} from './work.ts';

export type MemoryServiceOptions = {
  sql: MemorySql;
  boss: PgBoss;
  journal: RestrictionJournal;
  gateway?: ExtractionGateway;
  embedding?: EmbeddingProvider;
  cleanupFiles?: DerivedCleanup;
  markdown?: MarkdownViews;
  onError?: (code: string) => void;
};
/** Derive a worker's scope from durable state, never from the queue message's claimed space. */
export async function workerScope(sql: MemorySql, workId: string): Promise<MemoryScope | null> {
  const [row] =
    await sql`select p.owner_id, p.space_id, s.audience from memory_work w join memory_spaces p on p.space_id = w.space_id
    join memory_sources s on s.id = w.source_id where w.id = ${workId} and p.restore_ready and not p.revoked`;
  return row
    ? {
        ownerId: row.owner_id,
        spaceId: row.space_id,
        publisher: 'memory-worker',
        role: 'owner',
        audience: row.audience,
      }
    : null;
}
export async function runExtractionWork(options: MemoryServiceOptions, workId: string) {
  const scope = await workerScope(options.sql, workId);
  if (!scope || !options.gateway) return;
  const batch = await claimWork(options.sql, scope, { workId });
  if (!batch) return;
  try {
    const proposals = await proposeExtraction(options.sql, scope, batch, options.gateway);
    await commitExtraction(options.sql, scope, batch, { proposals });
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : 'extraction_failed';
    if (code === 'extraction_budget') {
      await options.sql.begin(async (tx) => {
        await lockSpace(tx, scope);
        await checkLease(tx, scope, batch);
        await finishWork(tx, batch, 'rejected', code);
      });
    } else await retryWork(options.sql, scope, batch, code);
    options.onError?.(code);
  }
}
export async function runDerivedWork(options: MemoryServiceOptions) {
  const markdown = options.markdown;
  const spaces =
    await options.sql`select distinct p.* from memory_spaces p join memory_outbox o on o.space_id = p.space_id
    where o.completed_at is null and o.kind in ('index','cleanup','markdown','proposal') order by p.space_id limit 100`;
  for (const space of spaces) {
    await cleanupMemory(
      options.sql,
      space.space_id,
      options.cleanupFiles ??
        (markdown ? (spaceId, claimIds) => markdown.cleanup(spaceId, claimIds) : undefined),
    );
    if (!space.restore_ready || space.revoked) continue;
    const scope: MemoryScope = {
      ownerId: space.owner_id,
      spaceId: space.space_id,
      publisher: 'view-builder',
      audience: 'private',
      role: 'owner',
    };
    await runViewWork(options.sql, scope, options.embedding);
    await options.markdown?.build(scope);
    await options.markdown?.proposals(scope);
  }
}
/** The restore check precedes queue delivery, inference, derived work, and accepting memory traffic. */
export async function startMemoryService(options: MemoryServiceOptions) {
  await restoreMemory(options.sql, options.journal);
  await options.boss.createQueue(MEMORY_EXTRACT_QUEUE);
  if (options.gateway)
    await options.boss.work<{ work_id: string }>(
      MEMORY_EXTRACT_QUEUE,
      { localConcurrency: 2, batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) await runExtractionWork(options, job.data.work_id);
      },
    );
  await repairQueue(options.sql, options.boss);
  const onError = options.onError ?? (() => {});
  const stopRecovery = startRecoveryScan(options.sql, options.boss, onError);
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDerivedWork(options);
    } catch {
      onError('memory_derived_work_failed');
    } finally {
      running = false;
    }
  }, 2000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      stopRecovery();
      if (options.gateway) await options.boss.offWork(MEMORY_EXTRACT_QUEUE);
    },
  };
}
