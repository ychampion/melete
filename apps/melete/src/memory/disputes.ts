/**
 * Settling a disputed key from the owner's queue.
 *
 * E2 puts one question per disputed key in front of the person. This is what
 * happens when they answer it: the revision they name is committed through the
 * ordinary correction path as a protected owner correction, and the
 * contradiction closes because the key now has an owner-stated head, not
 * because a row was marked read.
 *
 * The queue hands over a space, a key, a chosen handle and the words the owner
 * typed. It knows nothing else about memory, and memory learns nothing about
 * queues.
 */
import { parseMemoryHandle } from '@melete/contracts';
import type { DisputeSettler } from '../jobs/questions.ts';
import { correctClaim } from './claims.ts';
import { resolveContradictions } from './contradictions.ts';
import { iso, lockSpace, MemoryError, type MemoryScope, type MemorySql } from './db.ts';

/**
 * Read the content of the revision the owner chose. It is read rather than
 * taken from the request so the correction records what that revision actually
 * said, not what a client claimed it said.
 */
async function chosenContent(
  sql: MemorySql,
  scope: MemoryScope,
  claimId: string,
  revision: number,
): Promise<{ content: string; headRevision: number }> {
  const [row] = await sql`select c.head_revision, b.content
    from memory_claims c
    join memory_revisions r on r.claim_id = c.id and r.revision = ${revision}
    left join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.id = ${claimId} and c.space_id = ${scope.spaceId} and not c.hidden`;
  if (!row) throw new MemoryError('claim_not_found');
  return { content: (row.content as string) ?? '', headRevision: row.head_revision as number };
}

export function createDisputeSettler(
  scopeFor: (spaceId: string) => Promise<MemoryScope>,
  sql: MemorySql,
): DisputeSettler {
  return {
    async settle({ spaceId, key, choice, text, idempotencyKey }) {
      const parsed = parseMemoryHandle(choice);
      if (parsed?.kind !== 'claim') throw new MemoryError('invalid_choice');
      const scope = await scopeFor(spaceId);
      if (scope.spaceId !== spaceId) throw new MemoryError('scope_denied');
      const chosen = await chosenContent(sql, scope, parsed.claim_id, parsed.revision);
      // The owner's answer is the correction: protected, and dated now, because
      // what is being asserted is that this is right today.
      await correctClaim(
        sql,
        scope,
        {
          claim_id: parsed.claim_id,
          expected_revision: chosen.headRevision,
          text,
          content: chosen.content,
          valid_from: iso(new Date()),
          idempotency_key: idempotencyKey,
        },
        true,
      );
      await sql.begin(async (tx) => {
        await lockSpace(tx, scope);
        await resolveContradictions(tx, scope, key);
      });
    },
  };
}
