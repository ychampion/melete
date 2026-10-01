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
import { invalidateDependencies, lockEventOrder, notifyInvalidated } from './invalidate.ts';
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
  // Claims that cite a removed span. Each keeps whatever rests on other sources.
  const citing = new Set<string>();
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
      for (const ref of refs) citing.add(ref.claim_id);
    }
  }
  if (record.all) {
    const claims = await tx`select id from memory_claims where space_id = ${record.space_id}`;
    for (const claim of claims) affected.add(claim.id);
    await tx`update memory_sources set state = ${record.operation === 'revoke' ? 'revoked' : 'suppressed'} where space_id = ${record.space_id} and eligibility_generation <= ${record.eligibility_cutoff}`;
  }
  const kept = new Set<string>();
  for (const id of citing) {
    if (affected.has(id)) continue;
    if (await keepWhatRemains(tx, record.space_id, id)) kept.add(id);
    else affected.add(id);
  }
  // Exact-version derivations identify transitive descendants; UNION terminates supersession cycles.
  const descendants = await tx`with recursive affected(id) as (
    select unnest(${[...affected, ...kept]}::text[]) union
    select d.output_id from memory_derivations d join affected a on d.input_id = a.id
      where d.space_id = ${record.space_id} and d.input_kind = 'claim' and d.output_kind = 'claim'
  ) select id from affected`;
  for (const descendant of descendants) if (!kept.has(descendant.id)) affected.add(descendant.id);
  await tx`update memory_claims set hidden = true where space_id = ${record.space_id} and id = any(${[...affected]})`;
  // A kept claim lost a value: what quoted or depended on the claim is cleared as for a removed one.
  for (const id of kept) affected.add(id);
  // Anything else that quotes a removed value goes with it: a repair brief would
  // hand the old and new values to the next attempt, and a dispute's question
  // names both alternatives in the owner's queue.
  const removed = [...affected];
  // A conversation's "Remembered" or "Updated" entry quoted the value; the entry
  // stays, naming the detail, and the quotation goes. Clearing a space takes
  // every quotation in it.
  await tx`update event e set payload = jsonb_set(e.payload, '{value}', 'null'::jsonb)
    from job j where j.id = e.job_id and j.space_id = ${record.space_id}
      and e.type = 'notice' and e.payload->>'kind' = 'memory_tool'
      and e.payload->>'value' is not null
      and (${record.all} or e.payload->>'memory_item_id' = any(${removed}))`;
  await tx`delete from memory_repair_briefs where space_id = ${record.space_id} and (${record.all}
    or split_part(changed_handle, '@', 1) = any(${removed})
    or split_part(coalesce(replacement_handle, ''), '@', 1) = any(${removed}))`;
  const disputed = await tx`delete from memory_contradictions where space_id = ${record.space_id}
    and (${record.all} or claim_id = any(${removed})) returning key`;
  const keys = [...new Set(disputed.map((row) => row.key as string))];
  await tx`delete from memory_questions where space_id = ${record.space_id} and (${record.all} or key = any(${keys}))`;
  await tx`delete from question where source = 'memory' and space_id = ${record.space_id} and (${record.all} or key = any(${keys}))`;
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
/**
 * A claim citing a removed span loses only the revisions that rest on removed
 * evidence. When another revision still rests wholly on what remains, the
 * claim stays: the removed revisions are set aside and their text deleted, and
 * if the current value was one of them, the latest remaining revision that is
 * still in force becomes the current value, active, with its own evidence and
 * trust. One that lost to the removed value on precedence wins once that value
 * is gone; one whose validity has ended is not a current value. Returns false
 * when nothing usable remains, and the claim is hidden.
 */
async function keepWhatRemains(tx: MemoryTx, spaceId: string, claimId: string) {
  const [claim] =
    await tx`select head_revision from memory_claims where id = ${claimId} and space_id = ${spaceId} and not hidden`;
  if (!claim) return false;
  const revisions = await tx`select r.revision, r.status,
      (r.valid_until is null or r.valid_until > clock_timestamp()) as in_force,
      exists (select 1 from memory_references ref where ref.claim_id = r.claim_id and ref.revision = r.revision) as cited,
      exists (select 1 from memory_references ref left join memory_sources s on s.id = ref.source_id
        where ref.claim_id = r.claim_id and ref.revision = r.revision and (
          s.id is null or s.space_id <> ${spaceId} or s.state <> 'active' or s.source_version <> ref.source_version
          or exists (select 1 from memory_suppressions sup where sup.space_id = ${spaceId} and
            ((sup.source_id = s.id and (sup.start is null or (sup.start < ref."end" and sup."end" > ref.start)))
             or (sup.operation = 'clear' and s.eligibility_generation <= sup.eligibility_cutoff))))) as removed
    from memory_revisions r where r.claim_id = ${claimId} order by r.revision`;
  const removed = revisions.filter((r) => r.removed).map((r) => Number(r.revision));
  const remaining = revisions.filter((r) => !r.removed && r.cited && r.status !== 'retracted');
  if (!remaining.length) return false;
  const headRemoved = removed.includes(Number(claim.head_revision));
  const next = headRemoved ? remaining.filter((r) => r.in_force).at(-1) : undefined;
  if (headRemoved && !next) return false;
  await tx`update memory_revisions set status = 'retracted', superseded_at = coalesce(superseded_at, clock_timestamp())
    where claim_id = ${claimId} and revision = any(${removed})`;
  await tx`delete from memory_revision_content where claim_id = ${claimId} and revision = any(${removed})`;
  await tx`delete from memory_index_entries where space_id = ${spaceId} and claim_id = ${claimId} and revision = any(${removed})`;
  await tx`delete from memory_dense_entries where space_id = ${spaceId} and claim_id = ${claimId} and revision = any(${removed})`;
  if (next) {
    // A disputed value stays disputed; anything else becomes the active value reads return.
    await tx`update memory_revisions set status = 'active', superseded_at = null
      where claim_id = ${claimId} and revision = ${next.revision} and status in ('superseded', 'historical')`;
    await tx`update memory_claims set head_revision = ${next.revision} where id = ${claimId}`;
  }
  return true;
}
async function restrict(
  sql: MemorySql,
  scope: MemoryScope,
  removal: Removal,
  journal: RestrictionJournal,
): Promise<MemoryOperationResponse> {
  const result = await sql.begin(async (tx) => {
    await lockEventOrder(tx);
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
      // Forgotten text is removed, not only hidden: a source removed whole loses its
      // content, and a span forgotten out of a longer source is blanked in place,
      // which keeps the offsets other claims cite.
      await tx`delete from memory_source_content where source_id in (select id from memory_sources where space_id = ${spaceId} and state <> 'active')`;
      const partial = await tx`select b.source_id, b.content from memory_source_content b
        join memory_sources s on s.id = b.source_id
        where s.space_id = ${spaceId} and exists (select 1 from memory_suppressions sup
          where sup.space_id = s.space_id and sup.source_id = s.id and sup.start is not null)`;
      for (const row of partial) {
        const text = row.content as string;
        const spans = await tx`select start, "end" from memory_suppressions
          where space_id = ${spaceId} and source_id = ${row.source_id} and start is not null`;
        const characters = text.split('');
        for (const span of spans) characters.fill(' ', span.start as number, span.end as number);
        const blanked = characters.join('');
        if (blanked !== text)
          await tx`update memory_source_content set content = ${blanked} where source_id = ${row.source_id}`;
      }
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
