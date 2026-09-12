import { parseMemoryHandle } from '@melete/contracts';
import type { Query } from '../broker/records.ts';
import { memoryScopeForSpace } from '../memory/broker-trust.ts';
import { eligibleRevision } from '../memory/claims.ts';
import type { MemoryTx } from '../memory/db.ts';
import { plainText } from './projectors.ts';

export const memoryKeyLabel = (key: string | null) => {
  if (!key) return 'Something you shared';
  const [kind, subject, field] = key.split('.');
  const name = (subject ?? '').replaceAll('-', ' ');
  const leaf = (field ?? '').replaceAll('-', ' ');
  if (kind === 'contact') return `${name}'s ${leaf}`;
  if (kind === 'event') return `${name} ${leaf}`;
  if (kind === 'pref') return `${name}: ${leaf}`;
  if (kind === 'constraint') return `${name}: ${leaf}`;
  return plainText(key.replaceAll(/[._-]/g, ' '), 'Something you shared');
};

/** Only evidence still visible in this space may become an explanation. */
export async function explainHandles(
  tx: Query,
  spaceId: string,
  handles: readonly string[],
): Promise<string[]> {
  const reasons: string[] = [];
  for (const raw of handles.slice(0, 50)) {
    const handle = raw.replace(/^(?:claim|source):/, '');
    const parsed = parseMemoryHandle(handle);
    if (parsed?.kind === 'claim') {
      const scope = await memoryScopeForSpace(tx, spaceId);
      if (
        !scope ||
        !(await eligibleRevision(tx as MemoryTx, scope, parsed.claim_id, parsed.revision))
      )
        continue;
      const [row] =
        await tx`select c.key, b.content from memory_claims c join memory_revisions r on r.claim_id = c.id
        join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
        join memory_spaces m on m.space_id = c.space_id
        where c.space_id = ${spaceId} and c.id = ${parsed.claim_id} and r.revision = ${parsed.revision}
        and not c.hidden and r.status not in ('retracted', 'hidden') and m.restore_ready and not m.revoked
        and not exists (select 1 from memory_references ref join memory_sources s on s.id = ref.source_id
          where ref.claim_id = c.id and ref.revision = r.revision and s.state <> 'active')`;
      if (row)
        reasons.push(
          `${memoryKeyLabel(row.key as string | null)}: ${plainText(row.content, 'A detail you shared', 800)}`,
        );
    } else if (parsed?.kind === 'source') {
      const [row] =
        await tx`select s.source_type, s.author, s.event_at from memory_sources s join memory_spaces m on m.space_id = s.space_id
        where s.space_id = ${spaceId} and s.id = ${parsed.source_id} and s.source_version = ${parsed.source_version}
        and s.state = 'active' and m.restore_ready and not m.revoked`;
      if (row)
        reasons.push(
          `${row.author === 'owner' ? 'You shared this' : 'This came from a connected source'} on ${new Date(String(row.event_at)).toLocaleDateString('en-GB', { timeZone: 'UTC' })}.`,
        );
    } else if (raw.startsWith('attempt:') || raw.startsWith('job:')) {
      const [row] = raw.startsWith('attempt:')
        ? await tx`select j.title from attempt a join job j on j.id = a.job_id where a.id = ${raw.slice(8)} and j.space_id = ${spaceId}`
        : await tx`select title from job where id = ${raw.slice(4)} and space_id = ${spaceId}`;
      if (row) reasons.push(`For ${plainText(row.title, 'your request')}.`);
    }
  }
  return [...new Set(reasons)];
}
