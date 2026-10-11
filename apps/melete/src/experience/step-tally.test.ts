/** What a routine run made of its steps, counted from the broker's records first. */
import { expect, test } from 'bun:test';
import { stepNames, tallySteps } from './planning.ts';

const refused = (kind: string) => ({ phase: 'proposal_refused', kind, code: 'scope_denied' });

test('reads the broker refused are held back, though the engine called each one ok', () => {
  expect(
    tallySteps({
      results: [true, true],
      effects: [],
      notes: [refused('web.read'), refused('mail.search')],
    }),
  ).toEqual({ steps: 2, worked: 0, held: ['web.read', 'mail.search'] });
});

test('an action refused at admission, or denied, did not work', () => {
  expect(
    tallySteps({
      results: [true, true, true],
      effects: [
        { kind: 'web.read', status: 'proposed', rejected: true },
        { kind: 'mail.send', status: 'denied', rejected: false },
        { kind: 'web.read', status: 'succeeded', rejected: false },
      ],
      notes: [],
    }),
  ).toEqual({ steps: 3, worked: 1, held: ['web.read', 'mail.send'] });
});

test('a step that failed is not held back, and the engine’s own steps still count', () => {
  expect(
    tallySteps({
      results: [true, false, true],
      effects: [{ kind: 'web.read', status: 'failed', rejected: false }],
      notes: [],
    }),
  ).toEqual({ steps: 3, worked: 1, held: [] });
  expect(tallySteps({ results: [false, true], effects: [], notes: [] })).toEqual({
    steps: 2,
    worked: 1,
    held: [],
  });
});

test('a search held back before the refusal note existed is counted once', () => {
  const trace = { kind: 'tool_trace', call: { id: 'held-search:att_1:abc' } };
  expect(tallySteps({ results: [true], effects: [], notes: [trace] })).toEqual({
    steps: 1,
    worked: 0,
    held: ['web.search'],
  });
  expect(
    tallySteps({ results: [true], effects: [], notes: [trace, refused('web.search')] }).held,
  ).toEqual(['web.search']);
});

test('the kinds read as words, a few named and the rest counted', () => {
  expect(stepNames(['web.search'])).toBe('web search');
  expect(stepNames(['web.read', 'web.search', 'web.read'])).toBe('web read and web search');
  expect(stepNames(['a.b', 'c.d', 'e.f', 'g.h', 'i.j'])).toBe('a b, c d and e f, and 2 more');
});
