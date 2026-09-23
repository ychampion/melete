import type { PgBoss } from 'pg-boss';
import { CHAT_PUBLISHER, traceChatExtraction } from './capture.ts';
import { type CommitResult, commitExtraction } from './commit.ts';
import { lockSpace, MemoryError, type MemoryScope, type MemorySql } from './db.ts';
import { type ExtractionGateway, proposeExtraction } from './extract.ts';
import { cleanupMemory, type DerivedCleanup } from './forget.ts';
import type { MarkdownViews } from './markdown.ts';
import { type RestrictionJournal, restoreMemory } from './restore.ts';
import { observationProposals } from './tier0.ts';
import { type EmbeddingProvider, runViewWork } from './views.ts';
import {
  checkLease,
  claimWork,
  deferWork,
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
export const NO_GATEWAY_ATTEMPT_LIMIT = 3;
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
  if (!scope) return;
  const batch = await claimWork(options.sql, scope, { workId });
  if (!batch) return;
  // A chat message's conversation hears what memory kept from it. The entry is
  // a courtesy: failing to write it never undoes or retries the extraction.
  const traced = async (result: CommitResult) => {
    if (result.status !== 'committed' || batch.source.publisher !== CHAT_PUBLISHER) return;
    await traceChatExtraction(options.sql, batch.source.source_id).catch(() =>
      options.onError?.('memory_trace_failed'),
    );
  };
  try {
    // E3 Tier 0 runs first and, for a structured connector observation, runs
    // alone: a calendar entry, a contact record or a receipt becomes a checked
    // fact with no model in the path at all.
    const tier0 = observationProposals(batch.source, batch.text, {
      timeZone: batch.time_zone ?? undefined,
      offset: batch.work.segment_start,
    });
    if (tier0.length) {
      await traced(await commitExtraction(options.sql, scope, batch, { proposals: tier0 }));
      return;
    }
    // The durable fence counts claims, including recovery after a crashed worker.
    // Missing configuration gets bounded retries rather than an endless queue cycle.
    if (!options.gateway) {
      if (batch.work.fence >= NO_GATEWAY_ATTEMPT_LIMIT) {
        await options.sql.begin(async (tx) => {
          await lockSpace(tx, scope);
          await checkLease(tx, scope, batch);
          await finishWork(tx, batch, 'rejected', 'no_extraction_gateway');
        });
      } else await retryWork(options.sql, scope, batch, 'no_extraction_gateway');
      return;
    }
    const proposals = await proposeExtraction(options.sql, scope, batch, options.gateway);
    await traced(await commitExtraction(options.sql, scope, batch, { proposals }));
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : 'extraction_failed';
    // The provider did not answer, or today's reads are spent: the message stays
    // unread and is tried again later, with a growing gap.
    if (['extraction_provider_unavailable', 'memory_daily_budget'].includes(code))
      await deferWork(options.sql, scope, batch, code);
    // Out of answered calls for this one message: retrying would ask again.
    else if (code === 'extraction_budget') {
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
  // Structured observations use Tier 0 without a model. Other evidence has a
  // durable attempt cap when no extraction gateway is configured.
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
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (running) return;
    running = runDerivedWork(options)
      .catch(() => onError('memory_derived_work_failed'))
      .finally(() => {
        running = undefined;
      });
  }, 2000);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      stopRecovery();
      // Git projection and cleanup must settle before the caller closes SQL.
      await running;
      // The worker runs with or without a gateway; Tier 0 needs none.
      await options.boss.offWork(MEMORY_EXTRACT_QUEUE);
    },
  };
}
