/**
 * The record that makes a removal survive a restore.
 *
 * The restriction journal is retained apart from database snapshots and holds
 * no claim or source text. Startup replays it before anything serves, and
 * applies each record only where the named space still exists. That is exactly
 * the hook a removal needs: a backup taken before the deletion brings the space
 * back, the replay sees it again, and re-queues the sweep. Rolling the database
 * back does not roll the removal back with it.
 */
import type { Sql } from 'postgres';
import { newId } from '../memory/db.ts';
import type { RestrictionJournal, RestrictionRecord } from '../memory/restore.ts';

/**
 * Phase 3, before any data goes. A removal record carries no targets and no
 * claim ids: suppressing spans is the wrong shape for a space that is going
 * away entirely. It carries the generations at the moment of the fence, so a
 * replay knows what it is re-applying to.
 *
 * One record per space. A repeated phase finds the one already written and
 * appends nothing, and space ids are never reused.
 */
export async function appendRemovalRecord(
  raw: Sql,
  journal: RestrictionJournal,
  spaceId: string,
): Promise<RestrictionRecord | null> {
  const [space] = await raw<
    { owner_id: string; eligibility_generation: number; access_generation: number }[]
  >`select owner_id, eligibility_generation, access_generation
    from memory_spaces where space_id = ${spaceId}`;
  // A space that never held memory has nothing for the replay to re-apply to,
  // and a record naming a space the replay will never find is dead weight.
  if (!space) return null;
  const written = await journal.read();
  const already = written.find(
    (record) => record.space_id === spaceId && record.operation === 'remove_space',
  );
  if (already) return already;
  const record: RestrictionRecord = {
    id: newId('sup'),
    owner_id: space.owner_id,
    space_id: spaceId,
    operation: 'remove_space',
    all: true,
    claim_ids: [],
    targets: [],
    eligibility_cutoff: Number(space.eligibility_generation),
    access_generation: Number(space.access_generation) + 1,
    recorded_at: new Date().toISOString(),
  };
  await journal.append(record);
  return record;
}
