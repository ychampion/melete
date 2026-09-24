import {
  type MemoryWork,
  memoryWork,
  type SourceEvent,
  type SpaceGeneration,
} from '@melete/contracts';
import type { PgBoss } from 'pg-boss';
import { type ClaimHead, eligibleRevision, getHead } from './claims.ts';
import {
  generation,
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
} from './db.ts';
import { stageSegment, toSource, visibleSourceText } from './evidence.ts';
import { lexicalQuery } from './recall.ts';

export const EXTRACTION_LIMITS = {
  messages: 1,
  source_characters: 16000,
  context_characters: 24000,
  claims: 32,
  proposals: 32,
  calls: 4,
  usd: 0.04,
  call_usd: 0.01,
  output_tokens: 4000,
  timeout_ms: 15000,
} as const;
export const MEMORY_EXTRACT_QUEUE = 'melete.memory.extract';
export type ExtractionBatch = {
  work: MemoryWork;
  source: SourceEvent;
  text: string;
  claims: ClaimHead[];
  snapshot: SpaceGeneration;
  /** The zone Tier 0 resolves this source's relative dates against. */
  time_zone: string | null;
};
function toWork(row: Record<string, unknown>): MemoryWork {
  return memoryWork.parse({
    id: row.id,
    source_id: row.source_id,
    policy_version: row.policy_version,
    segment_start: row.segment_start,
    segment_end: row.segment_end,
    status: row.status,
    fence: row.fence,
    lease_until: row.lease_until ? iso(row.lease_until as Date) : null,
    continuation: row.continuation,
  });
}
/** A lease grants bounded work, not permission to publish after the fence has moved. */
export async function claimWork(
  sql: MemorySql,
  scope: MemoryScope,
  options: { workId?: string; leaseMs?: number } = {},
): Promise<ExtractionBatch | null> {
  return sql.begin(async (tx) => {
    const space = await lockSpace(tx, scope);
    const [row] = await tx`select w.* from memory_work w join memory_sources s on s.id = w.source_id
      where w.space_id = ${scope.spaceId} and s.state = 'active'
        and (${options.workId ?? null}::text is null or w.id = ${options.workId ?? null})
        and (w.status = 'pending' or (w.status = 'leased' and w.lease_until <= clock_timestamp()))
        and (w.retry_at is null or w.retry_at <= clock_timestamp())
      order by w.created_at, w.id for update of w skip locked limit 1`;
    if (!row) return null;
    const [leased] = await tx`update memory_work set status = 'leased', fence = fence + 1,
      lease_until = clock_timestamp() + ${Math.min(Math.max(options.leaseMs ?? 30000, 1), 120000)} * interval '1 millisecond'
      where id = ${row.id} returning *`;
    if (!leased) throw new MemoryError('work_not_claimed');
    const [evidence] =
      await tx`select s.*, b.content from memory_sources s join memory_source_content b on b.source_id = s.id where s.id = ${row.source_id}`;
    if (!evidence) throw new MemoryError('source_unavailable');
    const text = (
      await visibleSourceText(tx, toSource(evidence), evidence.content as string)
    ).slice(row.segment_start, row.segment_end);
    // The claims this evidence is most likely about come first, so an update to
    // something said weeks ago can name the claim it replaces; the newest fill
    // the rest of the snapshot.
    const query = lexicalQuery(text);
    const related = query
      ? await tx`select i.claim_id as id, max(ts_rank_cd(i.tokens, to_tsquery('simple', ${query}))) as score
          from memory_index_entries i join memory_claims c on c.id = i.claim_id
          join memory_index_manifest m on m.space_id = i.space_id and m.generation = i.generation
          where i.space_id = ${scope.spaceId} and c.audience = ${evidence.audience} and not c.hidden
            and i.revision = c.head_revision and i.tokens @@ to_tsquery('simple', ${query})
          group by i.claim_id order by score desc, i.claim_id desc limit ${EXTRACTION_LIMITS.claims - 8}`
      : [];
    const newest =
      await tx`select id from memory_claims where space_id = ${scope.spaceId} and audience = ${evidence.audience} and not hidden order by id desc limit ${EXTRACTION_LIMITS.claims}`;
    const candidates = [...new Set([...related, ...newest].map((row) => row.id as string))]
      .slice(0, EXTRACTION_LIMITS.claims)
      .map((id) => ({ id }));
    const claims: ClaimHead[] = [];
    let remaining = EXTRACTION_LIMITS.context_characters - text.length;
    for (const candidate of candidates) {
      const head = await getHead(tx, scope, candidate.id);
      if (!head || !(await eligibleRevision(tx, scope, head.id, head.head_revision))) continue;
      const size = JSON.stringify(head).length;
      if (size > remaining) continue;
      claims.push(head);
      remaining -= size;
    }
    return {
      work: toWork(leased),
      source: toSource(evidence),
      text,
      claims,
      snapshot: generation(space),
      time_zone: (evidence.time_zone as string | null) ?? null,
    };
  });
}
export async function checkLease(tx: MemoryTx, scope: MemoryScope, batch: ExtractionBatch) {
  const [work] =
    await tx`select * from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}
    and fence = ${batch.work.fence} and status = 'leased' and lease_until > clock_timestamp() for update`;
  if (!work) throw new MemoryError('stale_lease');
  if (
    work.source_id !== batch.source.source_id ||
    work.policy_version !== batch.work.policy_version
  )
    throw new MemoryError('invalid_batch');
  return work;
}
export async function reserveExtractionCall(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
) {
  await sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    const work = await checkLease(tx, scope, batch);
    if (
      work.calls >= EXTRACTION_LIMITS.calls ||
      Number(work.reserved_usd) + EXTRACTION_LIMITS.call_usd > EXTRACTION_LIMITS.usd + 1e-9
    )
      throw new MemoryError('extraction_budget');
    await tx`update memory_work set calls = calls + 1, reserved_usd = (reserved_usd::numeric + ${EXTRACTION_LIMITS.call_usd})::text where id = ${work.id}`;
  });
}
/** Give back a call reservation that no answer came back for. */
export async function refundExtractionCall(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
) {
  await sql`update memory_work set calls = greatest(calls - 1, 0),
    reserved_usd = greatest(reserved_usd::numeric - ${EXTRACTION_LIMITS.call_usd}, 0)::text
    where id = ${batch.work.id} and space_id = ${scope.spaceId} and fence = ${batch.work.fence} and status = 'leased'`;
}
/**
 * How a message waits while the model provider is failing: 30 s after the first
 * failure, doubling, never more than 30 min apart, and at most 8 tries or a day,
 * after which it is given up with a recorded fault. Spent daily reads are not a
 * failure: that wait has no limit.
 */
export const PROVIDER_BACKOFF = {
  first_seconds: 30,
  max_seconds: 1800,
  max_failures: 8,
  max_hours: 24,
} as const;
/** Put work back unread until the provider is likely to answer again, or give it up. */
export async function deferWork(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
  code: string,
): Promise<'deferred' | 'given_up'> {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    if (code === 'memory_daily_budget') {
      // Spent reads are not a failure and are never given up on: the message
      // waits until the person's oldest counted read leaves the day's window,
      // checking again at least every 30 minutes.
      await tx`update memory_work set status = 'pending', lease_until = null, error_code = ${code},
        retry_at = least(
          clock_timestamp() + ${PROVIDER_BACKOFF.max_seconds} * interval '1 second',
          coalesce((select min(created_at) + interval '1 day' from memory_model_calls
            where owner_id = ${scope.ownerId} and created_at > clock_timestamp() - interval '1 day'
              and coalesce(settlement->>'status', '') <> 'failed'),
            clock_timestamp() + ${PROVIDER_BACKOFF.first_seconds} * interval '1 second'))
        where id = ${batch.work.id} and space_id = ${scope.spaceId} and fence = ${batch.work.fence} and status = 'leased'`;
      return 'deferred';
    }
    const [work] = await tx`select provider_failures,
        created_at < clock_timestamp() - ${PROVIDER_BACKOFF.max_hours} * interval '1 hour' as stale
      from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}
        and fence = ${batch.work.fence} and status = 'leased'`;
    if (!work) return 'deferred';
    if (work.stale || Number(work.provider_failures) + 1 >= PROVIDER_BACKOFF.max_failures) {
      await tx`update memory_work set provider_failures = provider_failures + 1 where id = ${batch.work.id}`;
      await finishWork(tx, batch, 'rejected', `${code}:given_up`);
      return 'given_up';
    }
    await tx`update memory_work set status = 'pending', lease_until = null, error_code = ${code},
      provider_failures = provider_failures + 1,
      retry_at = clock_timestamp() + least(
        ${PROVIDER_BACKOFF.max_seconds} * interval '1 second',
        ${PROVIDER_BACKOFF.first_seconds} * power(2, least(provider_failures, 16)) * interval '1 second')
      where id = ${batch.work.id} and space_id = ${scope.spaceId} and fence = ${batch.work.fence} and status = 'leased'`;
    return 'deferred';
  });
}
/** Only committed terminal segments count toward the independently locked stream cursor. */
export async function advanceConsumed(tx: MemoryTx, source: SourceEvent) {
  await tx`select committed_sequence from memory_streams where space_id = ${source.space_id} and publisher = ${source.publisher} and stream = ${source.stream} for update`;
  await tx`update memory_streams st set consumed_sequence = coalesce((
    select min(s.stream_sequence) - 1 from memory_sources s
    where s.space_id = st.space_id and s.publisher = st.publisher and s.stream = st.stream and s.state = 'active'
      and (exists (select 1 from memory_work w where w.source_id = s.id and w.status not in ('done','rejected'))
        or not exists (select 1 from memory_work w where w.source_id = s.id and w.continuation is null and w.status in ('done','rejected')))
  ), st.committed_sequence)
  where st.space_id = ${source.space_id} and st.publisher = ${source.publisher} and st.stream = ${source.stream}`;
}
export async function finishWork(
  tx: MemoryTx,
  batch: ExtractionBatch,
  state: 'done' | 'rejected' = 'done',
  code: string | null = null,
) {
  await tx`update memory_work set status = ${state}, lease_until = null, error_code = ${code} where id = ${batch.work.id}`;
  await tx`update memory_outbox set completed_at = clock_timestamp() where kind = 'extract' and target_id = ${batch.work.id}`;
  if (batch.work.continuation !== null) {
    const [source] =
      await tx`select content_length, state from memory_sources where id = ${batch.source.source_id}`;
    if (source?.state === 'active')
      await stageSegment(tx, batch.source, source.content_length, batch.work.continuation);
  }
  await advanceConsumed(tx, batch.source);
}
export async function retryWork(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
  code: string,
) {
  await sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    // An obsolete process cannot release a replacement worker's lease.
    await tx`update memory_work set status = 'pending', lease_until = null, error_code = ${code}
      where id = ${batch.work.id} and space_id = ${scope.spaceId} and fence = ${batch.work.fence} and status = 'leased'`;
  });
}
/** Queue retention is not an authority: scan durable work periodically to repair lost delivery. */
export async function repairQueue(sql: MemorySql, boss: PgBoss) {
  await boss.createQueue(MEMORY_EXTRACT_QUEUE);
  const rows =
    await sql`select w.id, w.space_id from memory_work w join memory_spaces p on p.space_id = w.space_id join memory_sources s on s.id = w.source_id
    where p.restore_ready and not p.revoked and s.state = 'active'
      and (w.status = 'pending' or (w.status = 'leased' and w.lease_until <= clock_timestamp()))
      and (w.retry_at is null or w.retry_at <= clock_timestamp()) order by w.created_at limit 100`;
  for (const row of rows) {
    await boss.send(
      MEMORY_EXTRACT_QUEUE,
      { work_id: row.id, space_id: row.space_id },
      { singletonKey: row.id, singletonSeconds: 1 },
    );
    await sql`update memory_outbox set delivered_at = clock_timestamp() where kind = 'extract' and target_id = ${row.id} and completed_at is null`;
  }
  return rows.length;
}
export function startRecoveryScan(
  sql: MemorySql,
  boss: PgBoss,
  onError: (code: string) => void,
  intervalMs = 60000,
) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await repairQueue(sql, boss);
    } catch {
      onError('memory_queue_repair_failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
