import type { ClaimRevision, ExtractionProposal, SourceEvent } from '@melete/contracts';

export type ProposedClaim = Extract<ExtractionProposal, { op: 'add' | 'supersede' }>;
export type Resolution = {
  decision: 'publish' | 'historical' | 'exception' | 'attach' | 'dispute' | 'no-op';
  reason: string;
  revision?: number;
};
export type ExistingMeaning = {
  current: ClaimRevision;
  eventAt: string;
  sourceIdentities: string[];
  history: ClaimRevision[];
};
export const sourceIdentity = (s: SourceEvent) =>
  JSON.stringify([s.publisher, s.stream, s.source_identity]);
export const eventTime = (sources: SourceEvent[]) =>
  sources.reduce((latest, s) => (s.event_at > latest ? s.event_at : latest), '');
export const authority = (kind: ClaimRevision['kind']) => {
  switch (kind) {
    case 'checked_fact':
      return 4;
    case 'preference':
    case 'user_statement':
      return 3;
    case 'document_assertion':
      return 2;
    case 'exception':
      return 3;
    case 'historical':
      return 1;
    case 'inferred':
      return 0;
  }
};
/** Event time and domain authority decide meaning; import order and model confidence do not. */
export function resolveMeaning(
  proposal: ProposedClaim,
  sources: SourceEvent[],
  existing?: ExistingMeaning,
): Resolution {
  if (proposal.kind === 'exception') {
    return proposal.valid_until
      ? { decision: 'exception', reason: 'temporary_exception_keeps_base_preference' }
      : { decision: 'no-op', reason: 'exception_requires_end' };
  }
  if (proposal.kind === 'historical')
    return { decision: 'historical', reason: 'explicitly_historical' };
  if (!existing) return { decision: 'publish', reason: 'new_supported_claim' };
  const matching = existing.history.find((r) => r.content === proposal.content);
  const later = eventTime(sources) > existing.eventAt;
  if (
    matching &&
    (!later || existing.current.protected || existing.current.content === proposal.content)
  ) {
    const independent = sources.some((s) => !existing.sourceIdentities.includes(sourceIdentity(s)));
    return independent
      ? {
          decision: 'attach',
          reason: 'evidence_for_existing_revision',
          revision: matching.revision,
        }
      : { decision: 'no-op', reason: 'same_source_is_not_independent_confirmation' };
  }
  if (existing.current.protected)
    return { decision: 'historical', reason: 'explicit_correction_is_protected' };
  if (eventTime(sources) < existing.eventAt)
    return { decision: 'historical', reason: 'late_import_is_an_older_fact' };
  // The person owns their preference even if a document claims to have checked it.
  if (
    existing.current.kind === 'preference' &&
    !['preference', 'user_statement'].includes(proposal.kind)
  ) {
    return { decision: 'historical', reason: 'user_controls_expressed_preference' };
  }
  // A checked observation is scoped to its source domain, never arbitrary returned prose.
  if (
    proposal.domain_key.startsWith('calendar.') &&
    existing.current.kind === 'checked_fact' &&
    proposal.kind !== 'checked_fact'
  ) {
    return { decision: 'historical', reason: 'calendar_observation_precedes_assertion' };
  }
  if (authority(proposal.kind) < authority(existing.current.kind))
    return { decision: 'historical', reason: 'weaker_source_kept_attributed' };
  if (
    !later &&
    proposal.content !== existing.current.content &&
    authority(proposal.kind) === authority(existing.current.kind)
  ) {
    return { decision: 'dispute', reason: 'unresolved_disagreement' };
  }
  return { decision: 'publish', reason: 'later_eligible_evidence' };
}

/** These are owned by the job/action authority, regardless of who proposes a memory write. */
export function assertMemoryDomain(key: string) {
  if (
    /^(?:job|approval|credential|secret|budget|receipt|grant|action|permission)(?:[.:/]|$)/i.test(
      key,
    )
  ) {
    throw new Error('not_memory_authority');
  }
}
