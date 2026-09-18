/**
 * What the startup replay does with a removal record.
 *
 * Restoring a backup taken before a space was removed brings the space back in
 * the database. The restriction journal is retained apart from those snapshots,
 * so the replay still finds the record, and this is what it does about it: mark
 * memory revoked and unready, stamp the space, and queue the sweep again. The
 * space never serves in between, because `restore_ready` gates serving.
 */
import type { MemoryTx } from '../memory/db.ts';
import { newId } from '../memory/db.ts';
import type { RestrictionRecord } from '../memory/restore.ts';

/** Called only for a `remove_space` record, and only where the space came back. */
export async function requeueSpaceRemoval(
  tx: MemoryTx,
  record: RestrictionRecord,
): Promise<string | null> {
  await tx`update memory_spaces set revoked = true, restore_ready = false
    where space_id = ${record.space_id}`;
  const [parent] = await tx<
    { id: string; name: string; kind: string; git_path: string }[]
  >`select id, name, kind, git_path from space where id = ${record.space_id}`;
  // The memory row came back but the space row did not. There is nothing left
  // to take apart, and memory stays revoked either way.
  if (!parent) return null;
  await tx`update space set removed_at = now() where id = ${record.space_id} and removed_at is null`;
  // The restored backup has its jobs and connections again, so they are
  // captured again rather than read from the record, which carries neither.
  const jobs = await tx<{ id: string }[]>`select id from job
    where space_id = ${record.space_id} order by id`;
  const providers = await tx<{ provider: string; label: string }[]>`select distinct provider, label
    from connection where space_id = ${record.space_id} order by provider, label`;
  const id = newId('rem');
  const [queued] = await tx<{ id: string }[]>`insert into space_removal
    (id, space_id, space_name, git_path, kind, requested_by, state, phase, job_ids, providers)
    select ${id}, ${parent.id}, ${parent.name}, ${parent.git_path},
      ${parent.kind === 'personal' ? 'emptied' : 'removed'}, ${record.owner_id}, 'pending', 'fence',
      ${JSON.stringify(jobs.map((row) => row.id))}::text::jsonb,
      ${JSON.stringify(providers)}::text::jsonb
    where not exists (
      select 1 from space_removal where space_id = ${record.space_id} and state <> 'complete')
    returning id`;
  return queued?.id ?? null;
}
