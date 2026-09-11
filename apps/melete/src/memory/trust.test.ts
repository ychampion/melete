import { describe, expect, test } from 'bun:test';
import { minimumOriginTrust } from '@melete/contracts';
import {
  describeField,
  describeOrigin,
  originTrustOf,
  payloadFields,
  revisionTrust,
} from './trust.ts';

describe('a trust class is decided by how a value arrived', () => {
  test('the owner, a connected account, the open web, and the model', () => {
    expect(originTrustOf({ source_type: 'owner_edit', author: 'owner' })).toBe('owner');
    expect(originTrustOf({ source_type: 'message', author: 'owner' })).toBe('owner');
    // The same source type; somebody else wrote it, so it is external content.
    expect(originTrustOf({ source_type: 'message', author: 'external' })).toBe('external_content');
    expect(originTrustOf({ source_type: 'observation', author: 'external' })).toBe(
      'verified_connector',
    );
    expect(originTrustOf({ source_type: 'receipt', author: 'external' })).toBe(
      'verified_connector',
    );
    expect(originTrustOf({ source_type: 'document', author: 'owner' })).toBe('external_content');
    expect(originTrustOf({ source_type: 'assistant', author: 'owner' })).toBe('inferred');
  });

  test('a claim is only as trustworthy as its weakest source', () => {
    expect(minimumOriginTrust(['owner', 'external_content'])).toBe('external_content');
    expect(
      revisionTrust('user_statement', [
        { origin_trust: 'owner' },
        { origin_trust: 'verified_connector' },
      ]),
    ).toBe('verified_connector');
    // Supported by the owner's own words, but the conclusion is the model's.
    expect(revisionTrust('inferred', [{ origin_trust: 'owner' }])).toBe('inferred');
    expect(revisionTrust('user_statement', [])).toBe('inferred');
  });

  test('the origin is a sentence a person can read', () => {
    const page = {
      source_type: 'document',
      author: 'external',
      event_at: '2026-09-11T10:00:00Z',
    } as const;
    expect(describeOrigin(page)).toBe('a web page fetched on 11 September');
    expect(describeField('email', page)).toBe(
      'this address came from a web page fetched on 11 September',
    );
    expect(
      describeField('email', {
        source_type: 'message',
        author: 'owner',
        event_at: '2026-09-11T10:00:00Z',
      }),
    ).toBe('this address came from something you said on 11 September');
  });

  test('a payload is flattened to the leaves an approval card would show', () => {
    expect(
      payloadFields({ to: ['a@b.example', 'c@d.example'], body: { text: 'hello' }, count: 2 }),
    ).toEqual([
      { field: 'to[0]', value: 'a@b.example' },
      { field: 'to[1]', value: 'c@d.example' },
      { field: 'body.text', value: 'hello' },
      { field: 'count', value: '2' },
    ]);
  });
});
