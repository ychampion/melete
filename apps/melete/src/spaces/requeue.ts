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
  const [parent] = await tx<
    { id: string; name: string; kind: string; git_path: string; removal_epoch: number }[]
  >`select id, name, kind, git_path, removal_epoch from space where id = ${record.space_id}
    for update`;
  if (!parent) return null;
  // Only a database from before this removal is behind it. One that already
  // carries its epoch has been through it, or has it queued: an emptied space
  // that is in use again is exactly that, and what it holds now is new.
  const epoch = record.removal_epoch ?? 1;
  if (Number(parent.removal_epoch) >= epoch) return null;
  await tx`update memory_spaces set revoked = true, restore_ready = false
    where space_id = ${record.space_id}`;
  await tx`update space set removed_at = coalesce(removed_at, now()), removal_epoch = ${epoch}
    where id = ${record.space_id}`;
  // Its jobs, triggers and connections came back with the backup. The run
  // closes the space as the fence does, and captures them then: it starts from
  // `fence` for exactly that.
  const id = newId('rem');
  const [queued] = await tx<{ id: string }[]>`insert into space_removal
    (id, space_id, space_name, git_path, kind, requested_by, state, phase, epoch)
    select ${id}, ${parent.id}, ${parent.name}, ${parent.git_path},
      ${parent.kind === 'personal' ? 'emptied' : 'removed'}, ${record.requested_by ?? record.owner_id},
      'pending', 'fence', ${epoch}
    where not exists (
      select 1 from space_removal where space_id = ${record.space_id}
        and state not in ('complete', 'cleaning'))
    returning id`;
  return queued?.id ?? null;
}
