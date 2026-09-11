import {
  type Claim,
  type ClaimRevision,
  claim,
  claimRevision,
  correctionRequest,
  type SourceRef,
} from '@melete/contracts';
import {
  bumpRevision,
  enqueue,
  iso,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
  newId,
} from './db.ts';
import { persistEvidence } from './evidence.ts';
import { assertMemoryDomain } from './resolve.ts';

export type ClaimHead = Claim & { current: ClaimRevision };
export async function references(tx: MemoryTx, id: string, revision: number): Promise<SourceRef[]> {
  const rows =
    await tx`select source_id, source_version, start, "end" from memory_references where claim_id = ${id} and revision = ${revision} order by source_id, start`;
  return rows as unknown as SourceRef[];
}
export async function revisionFromRow(
  tx: MemoryTx,
  row: Record<string, unknown>,
): Promise<ClaimRevision> {
  return claimRevision.parse({
    claim_id: row.claim_id,
    revision: row.revision,
    content: row.content ?? null,
    kind: row.kind,
    factual_status: row.factual_status,
    status: row.status,
    protected: row.protected,
    data_revision: row.data_revision,
    valid_from: iso(row.valid_from as Date),
    valid_until: row.valid_until ? iso(row.valid_until as Date) : null,
    recorded_at: iso(row.recorded_at as Date),
    superseded_at: row.superseded_at ? iso(row.superseded_at as Date) : null,
    sources: await references(tx, row.claim_id as string, row.revision as number),
  });
}
export async function getHead(
  tx: MemoryTx,
  scope: MemoryScope,
  id: string,
): Promise<ClaimHead | null> {
  const [row] = await tx`select c.*, r.*, b.content from memory_claims c
    join memory_revisions r on r.claim_id = c.id and r.revision = c.head_revision
    left join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
    where c.id = ${id} and c.space_id = ${scope.spaceId} and not c.hidden
    and (${scope.role === 'owner'} or c.audience in ('space','public'))`;
  if (!row) return null;
  return {
    ...claim.parse({
      id: row.id,
      space_id: row.space_id,
      domain_key: row.domain_key,
      audience: row.audience,
      head_revision: row.head_revision,
      hidden: row.hidden,
    }),
    current: await revisionFromRow(tx, row),
  };
}
export async function historyInTransaction(tx: MemoryTx, scope: MemoryScope, id: string) {
  const head = await getHead(tx, scope, id);
  if (!head) throw new MemoryError('claim_not_found');
  const rows =
    await tx`select r.*, b.content from memory_revisions r left join memory_revision_content b
    on b.claim_id = r.claim_id and b.revision = r.revision where r.claim_id = ${id} order by r.revision`;
  const { current: _current, ...identity } = head;
  return {
    claim: claim.parse(identity),
    revisions: await Promise.all(rows.map((row) => revisionFromRow(tx, row))),
  };
}

/** All support must remain accessible. An index hit alone never passes this gate. */
export async function eligibleRevision(
  tx: MemoryTx,
  scope: MemoryScope,
  id: string,
  revision: number,
) {
  const [eligible] =
    await tx`select r.claim_id from memory_revisions r join memory_claims c on c.id = r.claim_id
    where c.space_id = ${scope.spaceId} and r.claim_id = ${id} and r.revision = ${revision}
      and not c.hidden and r.status <> 'retracted'
      and (${scope.role === 'owner'} or c.audience in ('space','public'))
      and exists (select 1 from memory_references ref where ref.claim_id = r.claim_id and ref.revision = r.revision)
      and not exists (
        select 1 from memory_references ref left join memory_sources s on s.id = ref.source_id
        where ref.claim_id = r.claim_id and ref.revision = r.revision and (
          s.id is null or s.space_id <> c.space_id or s.state <> 'active' or s.source_version <> ref.source_version
          or (${scope.role !== 'owner'} and s.audience = 'private')
          or exists (select 1 from memory_suppressions sup where sup.space_id = c.space_id and
            ((sup.source_id = s.id and (sup.start is null or (sup.start < ref."end" and sup."end" > ref.start)))
             or (sup.operation = 'clear' and s.eligibility_generation <= sup.eligibility_cutoff)))
        )
      )`;
  return Boolean(eligible);
}
export async function listClaims(sql: MemorySql, scope: MemoryScope) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const rows =
      await tx`select id from memory_claims where space_id = ${scope.spaceId} and not hidden order by id limit 200`;
    const claims: ClaimHead[] = [];
    for (const row of rows) {
      const head = await getHead(tx, scope, row.id);
      if (head && (await eligibleRevision(tx, scope, head.id, head.head_revision)))
        claims.push(head);
    }
    return { claims };
  });
}
export async function claimHistory(sql: MemorySql, scope: MemoryScope, id: string) {
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope, false);
    const history = await historyInTransaction(tx, scope, id);
    const visible: ClaimRevision[] = [];
    for (const revision of history.revisions) {
      if (await eligibleRevision(tx, scope, id, revision.revision)) visible.push(revision);
    }
    return { ...history, revisions: visible };
  });
}
export async function addReferences(
  tx: MemoryTx,
  spaceId: string,
  id: string,
  revision: number,
  refs: SourceRef[],
) {
  for (const ref of refs) {
    await tx`insert into memory_references (claim_id, revision, source_id, source_version, start, "end")
      values (${id}, ${revision}, ${ref.source_id}, ${ref.source_version}, ${ref.start}, ${ref.end}) on conflict do nothing`;
    await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
      values (${spaceId}, 'source', ${ref.source_id}, ${ref.source_version}, 'claim', ${id}, ${String(revision)}) on conflict do nothing`;
  }
}
export type RevisionDraft = Pick<
  ClaimRevision,
  'content' | 'kind' | 'factual_status' | 'valid_from' | 'valid_until' | 'sources' | 'protected'
>;
/** The caller holds the space lock and has validated the complete change set. */
export async function publishRevision(
  tx: MemoryTx,
  scope: MemoryScope,
  domainKey: string,
  head: ClaimHead | null,
  draft: RevisionDraft,
  status: ClaimRevision['status'] = 'active',
) {
  assertMemoryDomain(domainKey);
  const id = head?.id ?? newId('k');
  if (!head)
    await tx`insert into memory_claims (id, space_id, domain_key, audience) values (${id}, ${scope.spaceId}, ${domainKey}, ${scope.audience})`;
  const [next] =
    await tx`select coalesce(max(revision), 0) + 1 as revision from memory_revisions where claim_id = ${id}`;
  const revision = next?.revision as number;
  const dataRevision = await bumpRevision(tx, scope.spaceId);
  const active = status === 'active' || status === 'disputed';
  if (active && head) {
    // Transaction time is when our belief changed; valid time describes the world.
    await tx`update memory_revisions set status = 'superseded', superseded_at = clock_timestamp(),
      valid_until = case when valid_until is null and valid_from <= ${draft.valid_from} then ${draft.valid_from} else valid_until end
      where claim_id = ${id} and status in ('active','disputed')`;
  }
  const [row] =
    await tx`insert into memory_revisions (claim_id, revision, kind, factual_status, status, protected, valid_from, valid_until, data_revision)
    values (${id}, ${revision}, ${draft.kind}, ${draft.factual_status}, ${status}, ${draft.protected}, ${draft.valid_from}, ${draft.valid_until}, ${dataRevision}) returning *`;
  if (draft.content !== null)
    await tx`insert into memory_revision_content (claim_id, revision, content) values (${id}, ${revision}, ${draft.content})`;
  await addReferences(tx, scope.spaceId, id, revision, draft.sources);
  if (active || !head)
    await tx`update memory_claims set head_revision = ${revision} where id = ${id}`;
  if (head && active) {
    await tx`insert into memory_derivations (space_id, input_kind, input_id, input_version, output_kind, output_id, output_version)
      values (${scope.spaceId}, 'claim', ${id}, ${String(head.head_revision)}, 'claim', ${id}, ${String(revision)}) on conflict do nothing`;
  }
  await tx`update memory_profile set stale = true where space_id = ${scope.spaceId}`;
  await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
  return revisionFromRow(tx, { ...row, content: draft.content });
}

/** Direct owner corrections do not wait for extraction or model agreement. */
export async function correctClaim(
  sql: MemorySql,
  scope: MemoryScope,
  raw: unknown,
  ownerEdit = false,
) {
  const input = correctionRequest.parse(raw);
  return sql.begin(async (tx) => {
    await lockSpace(tx, scope);
    const head = await getHead(tx, scope, input.claim_id);
    if (!head) throw new MemoryError('claim_not_found');
    const evidence = await persistEvidence(
      tx,
      scope,
      {
        stream: 'owner-corrections',
        source_identity: input.idempotency_key,
        source_version: '1',
        source_type: 'message',
        event_at: input.valid_from,
        text: input.text,
      },
      ownerEdit,
    );
    if (evidence.duplicate) {
      const [prior] =
        await tx`select r.* , b.content from memory_references ref join memory_revisions r on r.claim_id = ref.claim_id and r.revision = ref.revision
        join memory_revision_content b on b.claim_id = r.claim_id and b.revision = r.revision
        where ref.source_id = ${evidence.source.source_id} and r.claim_id = ${head.id} and r.protected limit 1`;
      if (!prior || prior.content !== input.content) throw new MemoryError('idempotency_conflict');
      return revisionFromRow(tx, prior);
    }
    if (head.head_revision !== input.expected_revision) throw new MemoryError('stale_revision');
    if (evidence.source.state !== 'active') throw new MemoryError('source_suppressed');
    const revision = await publishRevision(
      tx,
      { ...scope, audience: head.audience },
      head.domain_key,
      head,
      {
        content: input.content,
        kind: head.current.kind === 'preference' ? 'preference' : 'user_statement',
        factual_status: 'attributed',
        valid_from: input.valid_from,
        valid_until: input.valid_until,
        protected: true,
        sources: [
          {
            source_id: evidence.source.source_id,
            source_version: '1',
            start: 0,
            end: input.text.length,
          },
        ],
      },
    );
    await tx`update memory_work set status = 'done' where source_id = ${evidence.source.source_id}`;
    await tx`update memory_streams set consumed_sequence = committed_sequence where space_id = ${scope.spaceId} and publisher = ${scope.publisher} and stream = 'owner-corrections'`;
    await tx`update memory_prepared set stale = true where space_id = ${scope.spaceId}`;
    await enqueue(tx, scope.spaceId, 'invalidate', `${head.id}:${revision.revision}`);
    return revision;
  });
}
