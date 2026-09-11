import { describe, expect, test } from 'bun:test';
import type { ClaimRevision, SourceEvent } from '@melete/contracts';
import {
  assertMemoryDomain,
  type ExistingMeaning,
  type ProposedClaim,
  resolveMeaning,
  sourceIdentity,
} from './resolve.ts';

const source: SourceEvent = {
  source_id: 'src_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  source_version: '1',
  owner_id: 'own_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  space_id: 'sp_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  publisher: 'owner',
  stream: 'chat',
  source_identity: 'm1',
  stream_sequence: 1,
  source_type: 'message',
  content_ref: 'test',
  event_at: '2026-08-01T00:00:00Z',
  ingested_at: '2026-09-01T00:00:00Z',
  audience: 'private',
  state: 'active',
  eligibility_generation: 1,
};
const july: ClaimRevision = {
  claim_id: 'k_01ARZ3NDEKTSV4RRFFQ69G5FAV',
  revision: 1,
  content: 'July',
  kind: 'user_statement',
  factual_status: 'attributed',
  status: 'active',
  protected: false,
  valid_from: source.event_at,
  valid_until: null,
  recorded_at: source.ingested_at,
  superseded_at: null,
  data_revision: 1,
  sources: [],
};
const proposal: ProposedClaim = {
  op: 'supersede',
  claim_id: july.claim_id,
  expected_revision: 1,
  domain_key: 'trip.month',
  content: 'August',
  kind: 'user_statement',
  factual_status: 'attributed',
  valid_from: source.event_at,
  valid_until: null,
  sources: [],
};
const existing = (revision: Partial<ClaimRevision> = {}): ExistingMeaning => ({
  current: { ...july, ...revision },
  eventAt: source.event_at,
  sourceIdentities: [sourceIdentity(source)],
  history: [{ ...july, ...revision }],
});
describe('memory resolve rules', () => {
  test('new evidence and later eligible facts publish', () => {
    expect(resolveMeaning(proposal, [source]).decision).toBe('publish');
    expect(
      resolveMeaning(proposal, [{ ...source, event_at: '2026-09-01T00:00:00Z' }], existing())
        .decision,
    ).toBe('publish');
  });
  test('import time is not fact time', () => {
    expect(
      resolveMeaning(
        proposal,
        [{ ...source, event_at: '2026-07-01T00:00:00Z', ingested_at: '2027-01-01T00:00:00Z' }],
        existing(),
      ).reason,
    ).toBe('late_import_is_an_older_fact');
  });
  test('explicit corrections remain protected even against newer inferred text', () => {
    expect(
      resolveMeaning(
        proposal,
        [{ ...source, event_at: '2027-01-01T00:00:00Z' }],
        existing({ protected: true }),
      ).reason,
    ).toBe('explicit_correction_is_protected');
  });
  test('old matching evidence attaches to the historical revision', () => {
    const history = {
      ...existing({ content: 'August', protected: true, revision: 2 }),
      history: [july],
    };
    const result = resolveMeaning(
      { ...proposal, content: 'July' },
      [{ ...source, source_identity: 'email', event_at: '2026-07-01T00:00:00Z' }],
      history,
    );
    expect(result).toEqual({
      decision: 'attach',
      reason: 'evidence_for_existing_revision',
      revision: 1,
    });
  });
  test('copies of one source do not count as independent support', () => {
    expect(
      resolveMeaning({ ...proposal, content: 'July' }, [source, source], existing()).reason,
    ).toBe('same_source_is_not_independent_confirmation');
  });
  test('temporary exceptions preserve a base preference and require an end', () => {
    expect(resolveMeaning({ ...proposal, kind: 'exception' }, [source], existing()).reason).toBe(
      'exception_requires_end',
    );
    expect(
      resolveMeaning(
        { ...proposal, kind: 'exception', valid_until: '2026-09-01T00:00:00Z' },
        [source],
        existing(),
      ).decision,
    ).toBe('exception');
  });
  test('historical preferences stay historical', () => {
    expect(resolveMeaning({ ...proposal, kind: 'historical' }, [source]).decision).toBe(
      'historical',
    );
  });
  test('user controls expressed preference', () => {
    expect(
      resolveMeaning(
        { ...proposal, kind: 'checked_fact' },
        [source],
        existing({ kind: 'preference' }),
      ).reason,
    ).toBe('user_controls_expressed_preference');
  });
  test('calendar observations outrank assertions in that domain', () => {
    expect(
      resolveMeaning(
        { ...proposal, domain_key: 'calendar.trip' },
        [source],
        existing({ kind: 'checked_fact' }),
      ).reason,
    ).toBe('calendar_observation_precedes_assertion');
  });
  test('weaker sources remain attributed and disagreements stay visible', () => {
    expect(resolveMeaning({ ...proposal, kind: 'inferred' }, [source], existing()).reason).toBe(
      'weaker_source_kept_attributed',
    );
    expect(resolveMeaning(proposal, [source], existing()).decision).toBe('dispute');
  });
  test('memory cannot establish job, approval, credential, budget, or receipt state', () => {
    for (const key of [
      'job.status',
      'approval.granted',
      'credential.key',
      'budget.usd',
      'receipt.sent',
      'grant.send',
      'action.done',
      'permission.email',
    ])
      expect(() => assertMemoryDomain(key)).toThrow('not_memory_authority');
    expect(() => assertMemoryDomain('trip.month')).not.toThrow();
  });
});
