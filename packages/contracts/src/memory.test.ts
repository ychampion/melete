import { describe, expect, test } from 'bun:test';
import { extractionProposal, ingestSourceRequest, recallRequest, recallResult } from './memory.ts';
import { buildOpenApiDocument } from './openapi.ts';

describe('memory authority contracts', () => {
  const source = {
    stream: 'messages',
    source_identity: 'm1',
    source_version: '1',
    source_type: 'message',
    event_at: '2026-07-01T00:00:00Z',
    text: 'July',
  };
  test('callers cannot supply scope, attribution, audience, or committed sequence', () => {
    expect(ingestSourceRequest.safeParse(source).success).toBe(true);
    for (const key of [
      'space_id',
      'owner_id',
      'publisher',
      'audience',
      'stream_sequence',
      'metadata',
    ]) {
      expect(ingestSourceRequest.safeParse({ ...source, [key]: 'another-space' }).success).toBe(
        false,
      );
    }
    expect(recallRequest.safeParse({ query: 'trip', space_id: 'another' }).success).toBe(false);
  });
  test('proposals require exact spans, target revision, and a typed operation', () => {
    expect(extractionProposal.safeParse({ op: 'supersede', content: 'August' }).success).toBe(
      false,
    );
    expect(extractionProposal.safeParse({ op: 'grant', credential: 'x' }).success).toBe(false);
    expect(extractionProposal.safeParse({ op: 'no-op', sources: [] }).success).toBe(true);
  });
  test('empty complete search differs from unavailable retrieval', () => {
    const base = {
      snapshot: null,
      index_generation: null,
      items: [],
      coverage: {
        indexed_revision: 0,
        authoritative_revision: 0,
        supplemented: 0,
        truncated: false,
        reason: 'ready',
      },
      recipe: 'lexical-v1',
      token_budget: { limit: 1000, used: 0, counter: 'utf8-bytes-upper-bound-v1' },
    };
    expect(recallResult.parse({ ...base, status: 'complete' }).status).toBe('complete');
    expect(recallResult.parse({ ...base, status: 'unavailable' }).status).toBe('unavailable');
    expect(recallResult.safeParse({ ...base, status: 'empty' }).success).toBe(false);
  });
  test('memory and review operations are documented', () => {
    const paths = buildOpenApiDocument().paths;
    for (const path of [
      '/memory/sources',
      '/memory/recall',
      '/memory/corrections',
      '/memory/forget',
      '/memory/sources/{id}',
      '/memory/claims',
      '/memory/claims/{id}/history',
      '/knowledge/proposals/{id}/apply',
      '/knowledge/proposals/{id}',
    ]) {
      expect(paths?.[path]).toBeDefined();
    }
    expect(paths?.['/knowledge/proposals']?.get).toBeDefined();
  });
});
