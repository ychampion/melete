import { describe, expect, test } from 'bun:test';
import { canonicalizePayload } from './broker.ts';
import {
  canonicalOriginWarnings,
  hashOriginWarnings,
  intentKey,
  isTrustedOrigin,
  isTrustGatedEffect,
  NO_ORIGIN_WARNINGS,
  type OriginWarning,
  warningsFor,
} from './effects.ts';

const base = {
  job_id: 'job_01J00000000000000000000000',
  job_revision: 0,
  connection_id: 'conn_01J00000000000000000000000',
  kind: 'email.send',
  payload_hash: canonicalizePayload({ body: 'Meet at 3pm.' }).hash,
};

describe('the intent key', () => {
  test('is the same for the same intended effect, whichever attempt proposes it', () => {
    expect(intentKey(base)).toBe(intentKey({ ...base }));
  });

  test('changes when any one part of the tuple changes', () => {
    const keys = new Set([
      intentKey(base),
      intentKey({ ...base, job_id: 'job_01J0000000000000000000000A' }),
      intentKey({ ...base, job_revision: 1 }),
      intentKey({ ...base, connection_id: 'conn_01J0000000000000000000000A' }),
      intentKey({ ...base, kind: 'email.draft' }),
      intentKey({ ...base, payload_hash: canonicalizePayload({ body: 'Meet at 4pm.' }).hash }),
    ]);
    expect(keys.size).toBe(6);
  });

  test('one changed byte in the payload is a different effect', () => {
    const edited = canonicalizePayload({ body: 'Meet at 4pm.' }).hash;
    expect(intentKey({ ...base, payload_hash: edited })).not.toBe(intentKey(base));
  });

  test('fields cannot be run together to forge a collision', () => {
    // Without length prefixes, `kind` "a" + connection "bc" would hash the same
    // as `kind` "ab" + connection "c".
    const left = intentKey({ ...base, connection_id: 'conn_a', kind: 'bc' });
    const right = intentKey({ ...base, connection_id: 'conn_ab', kind: 'c' });
    expect(left).not.toBe(right);
  });
});

const warning = (field: string, trust: OriginWarning['origin_trust']): OriginWarning => ({
  field,
  origin_trust: trust,
  handle: 'web:friday-page',
  description: 'This address came from a web page fetched on Friday.',
});

describe('origin warnings', () => {
  test('hash the same however the resolver ordered them', () => {
    const a = [warning('to[0]', 'external_content'), warning('url', 'inferred')];
    const b = [warning('url', 'inferred'), warning('to[0]', 'external_content')];
    expect(hashOriginWarnings(a)).toBe(hashOriginWarnings(b));
    expect(canonicalOriginWarnings(a)).toEqual(canonicalOriginWarnings(b));
  });

  test('a repeated warning is one doubt, not two', () => {
    expect(
      canonicalOriginWarnings([warning('to', 'unknown'), warning('to', 'unknown')]),
    ).toHaveLength(1);
  });

  test('no doubts is a real answer with its own hash', () => {
    expect(hashOriginWarnings([])).toBe(NO_ORIGIN_WARNINGS);
    expect(hashOriginWarnings([warning('to', 'unknown')])).not.toBe(NO_ORIGIN_WARNINGS);
  });

  test('a changed description is a different question', () => {
    const original = warning('to', 'external_content');
    const reworded = { ...original, description: 'This address came from an email you received.' };
    expect(hashOriginWarnings([original])).not.toBe(hashOriginWarnings([reworded]));
  });

  test('only the owner and a verified connector pass without a warning', () => {
    expect(isTrustedOrigin('owner')).toBe(true);
    expect(isTrustedOrigin('verified_connector')).toBe(true);
    for (const trust of ['external_content', 'inferred', 'unknown'] as const)
      expect(isTrustedOrigin(trust)).toBe(false);
  });

  test('a resolution from a trusted origin produces no warning at all', () => {
    const resolutions = [
      {
        path: 'to',
        category: 'recipient' as const,
        value: 'zara@example.com',
        origin_trust: 'owner' as const,
        handle: null,
        description: 'You supplied this value.',
      },
      {
        path: 'url',
        category: 'destination' as const,
        value: 'https://example.com/hook',
        origin_trust: 'external_content' as const,
        handle: 'web:friday-page',
        description: 'This value came from a web page fetched on Friday.',
      },
    ];
    expect(warningsFor(resolutions).map((w) => w.field)).toEqual(['url']);
  });
});

describe('trust-gated effect classes', () => {
  test('are the two that change the world outside Melete', () => {
    expect(isTrustGatedEffect('write_external')).toBe(true);
    expect(isTrustGatedEffect('spend')).toBe(true);
    expect(isTrustGatedEffect('read')).toBe(false);
    expect(isTrustGatedEffect('write_reversible')).toBe(false);
  });
});
