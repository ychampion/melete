import { describe, expect, test } from 'bun:test';
import { keyPrecedence, PRECEDENCE, questionFor, resolveKeyedHead } from './contradictions.ts';

const owner = { origin_trust: 'owner', protected: false, kind: 'user_statement' } as const;
const correction = { origin_trust: 'owner', protected: true, kind: 'user_statement' } as const;
const connector = {
  origin_trust: 'verified_connector',
  protected: false,
  kind: 'checked_fact',
} as const;
const document = {
  origin_trust: 'external_content',
  protected: false,
  kind: 'document_assertion',
} as const;
const inference = { origin_trust: 'external_content', protected: false, kind: 'inferred' } as const;

describe('precedence is a table, not a judgement', () => {
  test('owner correction beats owner statement beats connector beats document beats inference', () => {
    expect(keyPrecedence(correction)).toBe(PRECEDENCE.owner_correction);
    expect(keyPrecedence(owner)).toBe(PRECEDENCE.owner_statement);
    expect(keyPrecedence(connector)).toBe(PRECEDENCE.verified_connector);
    expect(keyPrecedence(document)).toBe(PRECEDENCE.document_assertion);
    expect(keyPrecedence(inference)).toBe(PRECEDENCE.inference);
    expect([correction, owner, connector, document, inference].map(keyPrecedence)).toEqual([
      4, 3, 2, 1, 0,
    ]);
  });

  test('a model conclusion stays an inference however good its evidence looks', () => {
    expect(keyPrecedence({ origin_trust: 'owner', protected: true, kind: 'inferred' })).toBe(
      PRECEDENCE.inference,
    );
  });
});

const candidate = (over: Record<string, unknown> = {}) => ({
  precedence: PRECEDENCE.owner_statement,
  event_at: '2026-07-10T00:00:00Z',
  content: 'August',
  explicit_supersede: false,
  ...over,
});
const head = (over: Record<string, unknown> = {}) => ({
  precedence: PRECEDENCE.owner_statement,
  event_at: '2026-07-03T00:00:00Z',
  content: 'July',
  ...over,
});

describe('one active head per key', () => {
  test('a weaker candidate is recorded and never takes the slot', () => {
    expect(
      resolveKeyedHead(candidate({ precedence: PRECEDENCE.document_assertion }), head()),
    ).toEqual({ decision: 'historical', reason: 'lower_precedence' });
  });

  test('a stronger candidate takes the slot without a question', () => {
    expect(
      resolveKeyedHead(candidate({ precedence: PRECEDENCE.owner_correction }), head()),
    ).toEqual({ decision: 'publish', reason: 'higher_precedence' });
  });

  test('an explicit supersede is the owner saying they meant to replace it', () => {
    expect(resolveKeyedHead(candidate({ explicit_supersede: true }), head())).toEqual({
      decision: 'publish',
      reason: 'explicit_supersede',
    });
  });

  test('two equal statements with no supersede is a contradiction, not a merge', () => {
    expect(resolveKeyedHead(candidate(), head())).toEqual({
      decision: 'dispute',
      reason: 'later_statement_without_an_explicit_supersede',
    });
  });

  test('an older statement arriving later is an older fact, whenever it was imported', () => {
    expect(resolveKeyedHead(candidate({ event_at: '2026-07-01T00:00:00Z' }), head())).toEqual({
      decision: 'historical',
      reason: 'earlier_by_event_time',
    });
  });

  test('with equal event time the slot does not move, because import order is not an authority', () => {
    expect(resolveKeyedHead(candidate({ event_at: head().event_at }), head())).toEqual({
      decision: 'dispute_keep_head',
      reason: 'simultaneous_disagreement',
    });
  });

  test('the same value again is not a disagreement', () => {
    expect(resolveKeyedHead(candidate({ content: 'July ' }), head())).toEqual({
      decision: 'no-op',
      reason: 'already_the_head',
    });
  });

  test('the question names both values and both days, and says what happens if ignored', () => {
    const asked = questionFor(
      'event.trip.date',
      { content: 'July', event_at: '2026-07-03T00:00:00Z' },
      { content: 'August', event_at: '2026-07-10T00:00:00Z' },
    );
    expect(asked.question).toBe(
      'Which is right for the event trip: July, from 3 July, or August, from 10 July?',
    );
    expect(asked.if_ignored).toContain('will not act externally');
    expect(asked.if_ignored).toContain('July');
  });
});
