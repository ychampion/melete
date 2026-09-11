/**
 * What the four falsifiers need in common: ingest one piece of evidence, commit
 * the keyed claims it supports, and read back the head of a key exactly as the
 * database holds it.
 */
import type { ExtractionProposal } from '@melete/contracts';
import { commitExtraction } from '../../src/memory/commit.ts';
import type { MemoryScope } from '../../src/memory/db.ts';
import { ingest } from '../../src/memory/evidence.ts';
import { claimWork } from '../../src/memory/work.ts';
import type { TestDatabase } from './postgres.ts';

export type Said = {
  identity: string;
  text: string;
  eventAt: string;
  sourceType?: 'message' | 'document' | 'observation' | 'receipt';
  author?: 'owner' | 'external';
  stream?: string;
};
export type Claimed = { key: string; content: string; quote: string; kind: string };

/** Ingest one piece of evidence and commit the keyed claims it supports. */
export async function record(db: TestDatabase, scope: MemoryScope, said: Said, claims: Claimed[]) {
  const evidence = await ingest(db.sql, scope, {
    stream: said.stream ?? 'chat',
    source_identity: said.identity,
    source_version: '1',
    source_type: said.sourceType ?? 'message',
    author: said.author ?? 'owner',
    event_at: said.eventAt,
    text: said.text,
  });
  const batch = await claimWork(db.sql, scope);
  if (!batch) throw new Error(`no work for ${said.identity}`);
  const proposals = claims.map((claim) => {
    const at = batch.text.indexOf(claim.quote);
    if (at < 0) throw new Error(`quote not in evidence: ${claim.quote}`);
    const start = batch.work.segment_start + at;
    return {
      op: 'add',
      expected_revision: null,
      domain_key: claim.key,
      key: claim.key,
      content: claim.content,
      kind: claim.kind,
      factual_status: claim.kind === 'checked_fact' ? 'checked' : 'attributed',
      valid_from: said.eventAt,
      valid_until: null,
      sources: [
        {
          source_id: batch.source.source_id,
          source_version: '1',
          start,
          end: start + claim.quote.length,
          quote: claim.quote,
        },
      ],
    } as ExtractionProposal;
  });
  const result = await commitExtraction(db.sql, scope, batch, { proposals });
  return { ...result, sourceId: evidence.source.source_id };
}

/** The head of one key, as the database holds it. */
export async function head(db: TestDatabase, scope: MemoryScope, key: string) {
  const [row] =
    await db.sql`select c.id, c.head_revision, r.status, r.kind, r.origin_trust, b.content
    from memory_claims c join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    left join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.space_id = ${scope.spaceId} and c.key = ${key} and not c.hidden`;
  return row as
    | {
        id: string;
        head_revision: number;
        status: string;
        kind: string;
        origin_trust: string;
        content: string | null;
      }
    | undefined;
}

/** Every revision of a key that currently occupies the active slot. */
export async function activeHeads(db: TestDatabase, scope: MemoryScope, key: string) {
  return db.sql`select r.claim_id, r.revision, r.status from memory_claims c
    join memory_revisions r on r.claim_id = c.id
    where c.space_id = ${scope.spaceId} and c.key = ${key} and not c.hidden
      and r.status in ('active','disputed') order by r.claim_id, r.revision`;
}
