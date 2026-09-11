import {
  type ExtractionProposal,
  extractionChangeSet,
  type SourceEvent,
  type SourceRef,
} from '@melete/contracts';
import {
  addReferences,
  type ClaimHead,
  getHead,
  historyInTransaction,
  publishRevision,
} from './claims.ts';
import {
  bumpRevision,
  enqueue,
  lockSpace,
  MemoryError,
  type MemoryScope,
  type MemorySql,
  type MemoryTx,
} from './db.ts';
import { toSource } from './evidence.ts';
import { assertMemoryDomain, eventTime, resolveMeaning, sourceIdentity } from './resolve.ts';
import { checkLease, type ExtractionBatch, finishWork, retryWork } from './work.ts';

type Validated = {
  proposal: ExtractionProposal;
  head: ClaimHead | null;
  sources: SourceEvent[];
  refs: SourceRef[];
};
async function validateProposal(
  tx: MemoryTx,
  scope: MemoryScope,
  batch: ExtractionBatch,
  proposal: ExtractionProposal,
): Promise<Validated> {
  let head: ClaimHead | null = null;
  if (proposal.op === 'supersede' || proposal.op === 'retract') {
    head = await getHead(tx, scope, proposal.claim_id);
    if (!head || head.head_revision !== proposal.expected_revision)
      throw new MemoryError('stale_revision');
    if (
      !batch.claims.some((c) => c.id === head?.id && c.head_revision === proposal.expected_revision)
    )
      throw new MemoryError('target_not_in_snapshot');
    if (
      proposal.op === 'supersede' &&
      (head.domain_key !== proposal.domain_key || head.audience !== batch.source.audience)
    )
      throw new MemoryError('target_mismatch');
    if (proposal.op === 'retract' && head.current.protected)
      throw new MemoryError('protected_correction');
  }
  if (proposal.op === 'add' || proposal.op === 'supersede') {
    assertMemoryDomain(proposal.domain_key);
    if (proposal.valid_until && new Date(proposal.valid_until) < new Date(proposal.valid_from))
      throw new MemoryError('invalid_validity');
    if (proposal.op === 'add') {
      const [existing] =
        await tx`select id from memory_claims where space_id = ${scope.spaceId} and audience = ${batch.source.audience} and domain_key = ${proposal.domain_key} and not hidden`;
      if (existing) throw new MemoryError('stale_revision');
    }
  }
  const sources: SourceEvent[] = [];
  const refs: SourceRef[] = [];
  for (const span of proposal.sources) {
    // Only evidence delivered to this invocation may be cited, even if another source is nearby.
    if (
      span.source_id !== batch.source.source_id ||
      span.source_version !== batch.source.source_version ||
      span.start < batch.work.segment_start ||
      span.end > batch.work.segment_end ||
      span.start >= span.end
    )
      throw new MemoryError('invalid_source_span');
    const [row] =
      await tx`select s.*, b.content from memory_sources s join memory_source_content b on b.source_id = s.id
      where s.id = ${span.source_id} and s.space_id = ${scope.spaceId} and s.state = 'active' and s.source_version = ${span.source_version}`;
    if (!row || (row.content as string).slice(span.start, span.end) !== span.quote)
      throw new MemoryError('invalid_source_span');
    const [suppressed] =
      await tx`select id from memory_suppressions where space_id = ${scope.spaceId} and
      ((source_id = ${span.source_id} and (start is null or (start < ${span.end} and "end" > ${span.start})))
        or (operation = 'clear' and eligibility_cutoff >= ${row.eligibility_generation})) limit 1`;
    if (suppressed) throw new MemoryError('source_suppressed');
    sources.push(toSource(row));
    refs.push({
      source_id: span.source_id,
      source_version: span.source_version,
      start: span.start,
      end: span.end,
    });
  }
  if (proposal.op === 'add' || proposal.op === 'supersede') {
    if (sources.every((s) => s.source_type === 'assistant'))
      throw new MemoryError('unsupported_attribution');
    if (
      ['user_statement', 'preference', 'exception'].includes(proposal.kind) &&
      !sources.some((s) => ['message', 'owner_edit'].includes(s.source_type))
    )
      throw new MemoryError('unsupported_attribution');
    if (
      proposal.kind === 'checked_fact' &&
      (!proposal.domain_key.startsWith('calendar.') ||
        !sources.every((s) => s.source_type === 'observation'))
    )
      throw new MemoryError('unsupported_checked_fact');
    if (proposal.factual_status === 'checked' && proposal.kind !== 'checked_fact')
      throw new MemoryError('unsupported_checked_fact');
  }
  return { proposal, head, sources, refs };
}
export type CommitResult = {
  status: 'committed' | 'duplicate' | 'retry' | 'rejected' | 'review';
  claim_ids: string[];
  reason?: string;
};
/** Validate every operation before publishing any revision, edge, cursor or invalidation. */
export async function commitExtraction(
  sql: MemorySql,
  scope: MemoryScope,
  batch: ExtractionBatch,
  raw: unknown,
  reviewed = false,
): Promise<CommitResult> {
  try {
    const { proposals } = extractionChangeSet.parse(raw);
    return await sql.begin(async (tx) => {
      const space = await lockSpace(tx, scope);
      const [prior] =
        await tx`select status, fence from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}`;
      if (prior?.status === 'done') return { status: 'duplicate', claim_ids: [] } as CommitResult;
      const work = await checkLease(tx, scope, batch);
      if (
        space.policy_generation !== batch.snapshot.policy_generation ||
        space.access_generation !== batch.snapshot.access_generation
      )
        throw new MemoryError('stale_policy');
      if (
        work.segment_start !== batch.work.segment_start ||
        work.segment_end !== batch.work.segment_end
      )
        throw new MemoryError('invalid_batch');
      const [source] =
        await tx`select state from memory_sources where id = ${batch.source.source_id}`;
      if (source?.state !== 'active') throw new MemoryError('source_suppressed');
      const validated: Validated[] = [];
      const targets = new Set<string>();
      for (const proposal of proposals) {
        const item = await validateProposal(tx, scope, batch, proposal);
        if (proposal.op !== 'no-op') {
          const target =
            proposal.op === 'add' ? `key:${proposal.domain_key}` : `id:${proposal.claim_id}`;
          if (targets.has(target)) throw new MemoryError('conflicting_changeset');
          targets.add(target);
        }
        validated.push(item);
      }
      if (space.require_review && !reviewed && validated.some((v) => v.proposal.op !== 'no-op')) {
        await tx`insert into memory_proposals (id, space_id, work_id, fence, payload) values (${batch.work.id}, ${scope.spaceId}, ${batch.work.id}, ${batch.work.fence}, ${JSON.stringify({ batch, proposals })}::text::jsonb)
          on conflict (id) do update set fence = excluded.fence, payload = excluded.payload, status = 'pending'`;
        await tx`update memory_work set status = 'review', lease_until = null where id = ${batch.work.id}`;
        await enqueue(tx, scope.spaceId, 'proposal', batch.work.id);
        return { status: 'review', claim_ids: [] } as CommitResult;
      }
      const claimIds: string[] = [];
      for (const { proposal, head, sources, refs } of validated) {
        if (proposal.op === 'no-op') continue;
        if (proposal.op === 'retract') {
          if (!head) throw new MemoryError('claim_not_found');
          const dataRevision = await bumpRevision(tx, scope.spaceId);
          await tx`update memory_claims set hidden = true where id = ${head.id}`;
          await tx`update memory_revisions set status = 'retracted', superseded_at = clock_timestamp() where claim_id = ${head.id} and revision = ${head.head_revision}`;
          await enqueue(tx, scope.spaceId, 'invalidate', `${head.id}:${dataRevision}`);
          await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
          claimIds.push(head.id);
          continue;
        }
        const sourceRows = head
          ? await tx`select distinct s.* from memory_references ref join memory_sources s on s.id = ref.source_id where ref.claim_id = ${head.id} and ref.revision = ${head.head_revision}`
          : [];
        const history = head ? await historyInTransaction(tx, scope, head.id) : null;
        const existing =
          head && history
            ? {
                current: head.current,
                eventAt: eventTime(sourceRows.map(toSource)),
                sourceIdentities: sourceRows.map((r) => sourceIdentity(toSource(r))),
                history: history.revisions,
              }
            : undefined;
        const resolution = resolveMeaning(proposal, sources, existing);
        if (resolution.decision === 'no-op') continue;
        if (resolution.decision === 'attach' && head && resolution.revision) {
          await addReferences(tx, scope.spaceId, head.id, resolution.revision, refs);
          const dataRevision = await bumpRevision(tx, scope.spaceId);
          await tx`update memory_revisions set data_revision = ${dataRevision} where claim_id = ${head.id} and revision = ${resolution.revision}`;
          await enqueue(tx, scope.spaceId, 'index', String(dataRevision));
          claimIds.push(head.id);
          continue;
        }
        const exception = resolution.decision === 'exception';
        const domain = exception
          ? `${proposal.domain_key}:exception:${proposal.valid_from}:${proposal.valid_until}`
          : proposal.domain_key;
        const draft = {
          content: proposal.content,
          kind: proposal.kind,
          factual_status: proposal.factual_status,
          protected: false,
          valid_from: proposal.valid_from,
          valid_until: proposal.valid_until,
          sources: refs,
        };
        if (resolution.decision === 'dispute' && head) {
          // Both alternatives remain explicit; only the selected head occupies the active slot.
          await publishRevision(
            tx,
            { ...scope, audience: head.audience },
            domain,
            head,
            { ...head.current, factual_status: 'disputed' },
            'disputed',
          );
          draft.factual_status = 'disputed';
        }
        const historical =
          resolution.decision === 'historical' || resolution.decision === 'dispute';
        const revision = await publishRevision(
          tx,
          { ...scope, audience: batch.source.audience },
          domain,
          exception ? null : head,
          draft,
          historical ? 'historical' : 'active',
        );
        claimIds.push(revision.claim_id);
      }
      await finishWork(tx, batch);
      return { status: 'committed', claim_ids: [...new Set(claimIds)] } as CommitResult;
    });
  } catch (error) {
    const code =
      error instanceof MemoryError
        ? error.code
        : error instanceof Error && error.message === 'not_memory_authority'
          ? error.message
          : 'invalid_proposal';
    if (['stale_revision', 'stale_policy', 'stale_lease'].includes(code)) {
      await retryWork(sql, scope, batch, code);
      return { status: 'retry', claim_ids: [], reason: code };
    }
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
      await retryWork(sql, scope, batch, 'stale_revision');
      return { status: 'retry', claim_ids: [], reason: 'stale_revision' };
    }
    // Rejections contain operational codes only, never source or forgotten plaintext.
    await sql.begin(async (tx) => {
      await lockSpace(tx, scope);
      const [work] =
        await tx`select status, fence from memory_work where id = ${batch.work.id} and space_id = ${scope.spaceId}`;
      if (work?.status === 'leased' && work.fence === batch.work.fence)
        await finishWork(tx, batch, 'rejected', code);
    });
    return { status: 'rejected', claim_ids: [], reason: code };
  }
}
