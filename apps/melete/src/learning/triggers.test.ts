import { describe, expect, test } from 'bun:test';
import {
  overlapsProcedure,
  triggerSpecificity,
  triggersMatch,
  triggersOverlap,
} from './triggers.ts';

describe('trigger matching', () => {
  test('matches the objective or the latest message after normalisation', () => {
    const triggers = [{ phrase: 'follow-up email' }];
    expect(triggersMatch(triggers, 'Draft a FOLLOW-UP email, please')).toBe(true);
    expect(triggersMatch(triggers, 'Answer the plumber', 'Make it a follow-up email.')).toBe(true);
    expect(triggersMatch(triggers, 'Answer the plumber', 'Something else')).toBe(false);
  });

  test('no triggers, or a trigger with no words, matches nothing', () => {
    expect(triggersMatch([], 'Draft a follow-up email')).toBe(false);
    expect(triggersMatch([{ phrase: '...' }], 'Draft a follow-up email')).toBe(false);
    expect(triggersMatch([{ phrase: '!!!' }], '', '')).toBe(false);
  });
});

describe('a built-in skill beside a delivered procedure', () => {
  const message = {
    phrases: ['follow-up email'],
    learnedFrom: ['Draft a follow-up email to the recruiter after the interview'],
  };

  test('overlaps when a trigger is the same phrase, or one sits inside the other', () => {
    expect(overlapsProcedure(['follow up'], message)).toBe(true);
    expect(overlapsProcedure(['follow-up email to'], message)).toBe(true);
    expect(overlapsProcedure(['email'], { ...message, learnedFrom: [] })).toBe(true);
  });

  test('overlaps when it would have been chosen for the request the procedure was learned on', () => {
    // "draft a" shares no phrase with "follow-up email", but it was in play when the person corrected the format.
    expect(overlapsProcedure(['draft a', 'rewrite'], message)).toBe(true);
    expect(
      overlapsProcedure(['summarise', 'summary of'], {
        phrases: ['status report'],
        learnedFrom: ['Summarise the weekly status report for the leadership team'],
      }),
    ).toBe(true);
  });

  test('does not overlap work the procedure never covered', () => {
    expect(overlapsProcedure(['remind me', 'calendar'], message)).toBe(false);
    expect(overlapsProcedure(['emails'], { phrases: ['mail'], learnedFrom: [] })).toBe(false);
  });
});

describe('specificity and overlap', () => {
  test('the longest matching phrase is the most specific; no match is -1, no triggers 0', () => {
    const objective = 'Draft a follow-up email to the recruiter';
    expect(
      triggerSpecificity([{ phrase: 'email' }, { phrase: 'follow-up email' }], objective),
    ).toBe('follow-up email'.length);
    expect(triggerSpecificity([{ phrase: 'invoice' }], objective)).toBe(-1);
    expect(triggerSpecificity([], objective)).toBe(0);
  });

  test('phrases overlap when one contains the other; no triggers overlaps everything', () => {
    expect(triggersOverlap([{ phrase: 'recruiter' }], [{ phrase: 'the recruiter' }])).toBe(true);
    expect(triggersOverlap([{ phrase: 'Follow-up email' }], [{ phrase: 'FOLLOW-UP email' }])).toBe(
      true,
    );
    expect(triggersOverlap([{ phrase: 'recruiter' }], [{ phrase: 'weekly summary' }])).toBe(false);
    expect(triggersOverlap([], [{ phrase: 'weekly summary' }])).toBe(true);
  });
});
