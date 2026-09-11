import type { MemorySql, MemoryTx } from '../memory/db.ts';
import type { RestrictionRecord } from '../memory/restore.ts';

/** Invoked inside the memory restriction transaction, including journal replay after restore. */
export async function restrictEpisodes(
  tx: MemoryTx,
  record: RestrictionRecord,
  affectedClaims: string[],
) {
  const ids = [...affectedClaims, ...record.targets.map((target) => target.source_id)];
  const removed =
    await tx`update episode set restricted = true, intervention = null, versions = '[]',
    artifacts = '[]', receipts = '[]', input_refs = '[]', generation_state = 'restricted'
    where space_id = ${record.space_id} and (
      (${record.all} and exists (select 1 from job j where j.id = episode.job_id
        and j.created_at <= ${record.recorded_at})) or exists (
        select 1 from jsonb_array_elements_text(input_refs) ref where split_part(ref, '@', 1) = any(${ids})
      )) returning id`;
  await tx`delete from procedure_candidate where episode_id = any(${removed.map((row) => row.id)})`;
}

/** Retention erases private bytes and keeps only a tombstone so retries cannot recreate evidence. */
export async function expireEpisodes(sql: MemorySql, now = new Date()) {
  return sql.begin(async (tx) => {
    const rows =
      await tx`update episode set restricted = true, intervention = null, versions = '[]',
      artifacts = '[]', receipts = '[]', input_refs = '[]', generation_state = 'restricted'
      where expires_at <= ${now.toISOString()} and not restricted returning id`;
    await tx`delete from procedure_candidate where episode_id = any(${rows.map((row) => row.id)})`;
    return rows.length;
  });
}
