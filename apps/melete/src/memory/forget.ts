import { forgetRequest, type MemoryOperationResponse } from '@melete/contracts';
import { restrictEpisodes } from '../learning/retention.ts';
import {
  bumpRevision,
  enqueue,
  generation,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
} from './db.ts';
import { invalidateDependencies, notifyInvalidated } from './invalidate.ts';
import type { RestrictionJournal, RestrictionRecord } from './restore.ts';

type Removal = {
  operation: RestrictionRecord['operation'];
  claimId?: string;
  sourceId?: string;
  all: boolean;
};
async function planRestriction(
  tx: MemoryTx,
  scope: MemoryScope,
  removal: Removal,
): Promise<RestrictionRecord> {
  const space = await lockSpace(tx, scope);
  let claimIds: string[] = [];
  if (removal.claimId) {
    const [claim] =
      await tx`select id from memory_claims where id = ${removal.claimId} and space_id = ${scope.spaceId}`;
    if (!claim) throw new MemoryError('claim_not_found');
    claimIds = [claim.id];
  }
  if (removal.sourceId) {
    const [source] =
      await tx`select id from memory_sources where id = ${removal.sourceId} and space_id = ${scope.spaceId}`;
    if (!source) throw new MemoryError('source_not_found');
  }
  const rows = removal.claimId
    ? await tx`select distinct s.id, s.publisher, s.stream, s.source_identity, ref.start, ref."end" from memory_references ref
        join memory_sources s on s.id = ref.source_id where ref.claim_id = ${removal.claimId} and s.space_id = ${scope.spaceId}`
    : await tx`select id, publisher, stream, source_identity, 0 as start, content_length as "end" from memory_sources where space_id = ${scope.spaceId}
        and (${removal.all} or id = ${removal.sourceId ?? null})`;
  return {
    id: newId('sup'),
    owner_id: scope.ownerId,
    space_id: scope.spaceId,
    operation: removal.operation,
    all: removal.all,
    claim_ids: claimIds,
    targets: rows.map((row) => ({
      source_id: row.id,
      publisher: row.publisher,
      stream: row.stream,
      source_identity: row.source_identity,
      start: row.start,
      end: row.end,
      suppression_id: newId('sup'),
    })),
    eligibility_cutoff: space.eligibility_generation as number,
    access_generation: (space.access_generation as number) + 1,
    recorded_at: new Date().toISOString(),
  };
}

/** Also used by startup replay; source identities cover versions missing from an older snapshot. */
export async function applyRestriction(tx: MemoryTx, record: RestrictionRecord) {
  const [space] =
    await tx`select * from memory_spaces where space_id = ${record.space_id} and owner_id = ${record.owner_id} for update`;
  if (!space) throw new MemoryError('scope_denied');
  const [applied] =
    await tx`select id from memory_suppressions where id = ${record.id} and space_id = ${record.space_id}`;
  if (applied) {
    await restrictEpisodes(tx, record, record.claim_ids);
    return generation(space);
  }
  await tx`insert into memory_suppressions (id, space_id, eligibility_cutoff, operation, recorded_at)
    values (${record.id}, ${record.space_id}, ${record.eligibility_cutoff}, ${record.operation}, ${record.recorded_at})`;
  const affected = new Set(record.claim_ids);
  for (const target of record.targets) {
    await tx`insert into memory_suppressions (id, space_id, source_id, publisher, stream, source_identity, start, "end", eligibility_cutoff, operation, recorded_at)
      values (${target.suppression_id}, ${record.space_id}, ${target.source_id}, ${target.publisher}, ${target.stream}, ${target.source_identity}, ${target.start}, ${target.end}, ${record.eligibility_cutoff}, ${record.operation}, ${record.recorded_at}) on conflict do nothing`;
    const identities =
      await tx`select id, content_length from memory_sources where space_id = ${record.space_id} and publisher = ${target.publisher}
      and stream = ${target.stream} and source_identity = ${target.source_identity}`;
    for (const identity of identities) {
      // A replayed version has the same authenticated origin. Partial spans remain precise on the original version.
      const entire =
        record.operation === 'delete' ||
        record.operation === 'revoke' ||
        identity.id !== target.source_id ||
        (target.start === 0 && target.end >= identity.content_length);
      if (entire) {
        const state =
          record.operation === 'delete'
            ? 'deleted'
            : record.operation === 'revoke'
              ? 'revoked'
              : 'suppressed';
        await tx`update memory_sources set state = ${state} where id = ${identity.id}`;
      }
      const refs =
        await tx`select distinct claim_id from memory_references where source_id = ${identity.id}
        and (${entire} or (start < ${target.end} and "end" > ${target.start}))`;
      for (const ref of refs) affected.add(ref.claim_id);
    }
  }
  if (record.all) {
    const claims = await tx`select id from memory_claims where space_id = ${record.space_id}`;
    for (const claim of claims) affected.add(claim.id);
    await tx`update memory_sources set state = ${record.operation === 'revoke' ? 'revoked' : 'suppressed'} where space_id = ${record.space_id} and eligibility_generation <= ${record.eligibility_cutoff}`;
  }
  // Exact-version derivations identify transitive descendants; UNION terminates supersession cycles.
  const descendants = await tx`with recursive affected(id) as (
    select unnest(${[...affected]}::text[]) union
    select d.output_id from memory_derivations d join affected a on d.input_id = a.id
      where d.space_id = ${record.space_id} and d.input_kind = 'claim' and d.output_kind = 'claim'
  ) select id from affected`;
  for (const descendant of descendants) affected.add(descendant.id);
  await tx`update memory_claims set hidden = true where space_id = ${record.space_id} and id = any(${[...affected]})`;
  const dataRevision = await bumpRevision(tx, record.space_id);
  const [next] =
    await tx`update memory_spaces set eligibility_generation = greatest(eligibility_generation, ${record.eligibility_cutoff + 1}),
    access_generation = greatest(access_generation, ${record.access_generation}),
    revoked = revoked or ${record.operation === 'revoke' && record.all},
    restore_ready = restore_ready and not ${record.operation === 'revoke' && record.all}
    where space_id = ${record.space_id} returning *`;
  const scope: MemoryScope = {
    ownerId: record.owner_id,
    spaceId: record.space_id,
    publisher: 'restriction-replay',
    role: 'owner',
    audience: 'private',
  };
  await invalidateDependencies(tx, scope, [...affected], dataRevision, record.all);
  // Invalidation waits for active job transactions; include episodes they committed while removal waited.
  await restrictEpisodes(tx, record, [...affected]);
  await enqueue(tx, record.space_id, 'cleanup', record.id);
  await enqueue(tx, record.space_id, 'index', String(dataRevision));
  return generation(next ?? {});
}
async function restrict(
  sql: MemorySql,
  scope: MemoryScope,
  removal: Removal,
  journal: RestrictionJournal,
): Promise<MemoryOperationResponse> {
  const result = await sql.begin(async (tx) => {
    // One journal append order across service processes, released automatically on process death.
    await tx`select pg_advisory_xact_lock(hashtext('melete-memory-restrictions'))`;
    const record = await planRestriction(tx, scope, removal);
    await journal.append(record);
    return { generation: await applyRestriction(tx, record), cleanup: 'pending' as const };
  });
  await notifyInvalidated(sql, scope.spaceId);
  return result;
}
export async function forgetMemory(
  sql: MemorySql,
  scope: MemoryScope,
  raw: unknown,
  journal: RestrictionJournal,
) {
  const input = forgetRequest.parse(raw);
  if (Boolean(input.claim_id) === Boolean(input.all))
    throw new MemoryError('invalid_forget_target');
  return restrict(
    sql,
    scope,
    { operation: input.all ? 'clear' : 'forget', claimId: input.claim_id, all: input.all ?? false },
    journal,
  );
}
export const deleteMemorySource = (
  sql: MemorySql,
  scope: MemoryScope,
  sourceId: string,
  journal: RestrictionJournal,
) => restrict(sql, scope, { operation: 'delete', sourceId, all: false }, journal);
export const revokeMemorySource = (
  sql: MemorySql,
  scope: MemoryScope,
  sourceId: string,
  journal: RestrictionJournal,
) => restrict(sql, scope, { operation: 'revoke', sourceId, all: false }, journal);
export const revokeMemorySpace = (
  sql: MemorySql,
  scope: MemoryScope,
  journal: RestrictionJournal,
) => restrict(sql, scope, { operation: 'revoke', all: true }, journal);

export type DerivedCleanup = (spaceId: string, claimIds: string[]) => Promise<void>;
/** Serving is already restricted. Physical cleanup has its own retryable outcome. */
export async function cleanupMemory(
  sql: MemorySql,
  spaceId: string,
  cleanupFiles?: DerivedCleanup,
) {
  const work =
    await sql`select id from memory_outbox where space_id = ${spaceId} and kind = 'cleanup' and completed_at is null order by created_at`;
  if (!work.length) return 0;
  try {
    const hidden = await sql.begin(async (tx) => {
      await tx`select space_id from memory_spaces where space_id = ${spaceId} for update`;
      const rows = await tx`select id from memory_claims where space_id = ${spaceId} and hidden`;
      const ids = rows.map((row) => row.id as string);
      await tx`delete from memory_index_entries where space_id = ${spaceId} and claim_id = any(${ids})`;
      await tx`delete from memory_dense_entries where space_id = ${spaceId} and claim_id = any(${ids})`;
      await tx`delete from memory_revision_content where claim_id = any(${ids})`;
      await tx`delete from memory_source_content where source_id in (select id from memory_sources where space_id = ${spaceId} and state in ('deleted','revoked'))`;
      await tx`update memory_prepared set content = null where space_id = ${spaceId} and stale`;
      await tx`update memory_profile set items = '[]'::jsonb where space_id = ${spaceId} and stale`;
      const discarded =
        await tx`update memory_proposals set payload = null, status = 'discarded' where space_id = ${spaceId} and status = 'pending' returning work_id`;
      // Conservatively discarded review material is regenerated from a fresh, redacted snapshot.
      await tx`update memory_work set status = 'pending', lease_until = null where space_id = ${spaceId} and status = 'review' and id = any(${discarded.map((row) => row.work_id)})`;
      await tx`update memory_work set status = 'rejected', error_code = 'source_restricted', lease_until = null where space_id = ${spaceId} and status in ('pending','leased','review')
        and source_id in (select id from memory_sources where space_id = ${spaceId} and state <> 'active')`;
      return ids;
    });
    const [markdown] =
      await sql`select output_id from memory_derivations where space_id = ${spaceId} and output_kind = 'markdown' limit 1`;
    if (markdown && !cleanupFiles) throw new MemoryError('cleanup_view_hook_required');
    await cleanupFiles?.(spaceId, hidden);
    await sql`update memory_outbox set completed_at = clock_timestamp(), error_code = null where id = any(${work.map((row) => row.id)})`;
    return work.length;
  } catch (error) {
    await sql`update memory_outbox set failures = failures + 1, error_code = 'physical_cleanup_failed' where id = any(${work.map((row) => row.id)})`;
    throw error;
  }
}
