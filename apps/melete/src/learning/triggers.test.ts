import { describe, expect, test } from 'bun:test';
import { triggersMatch } from './triggers.ts';

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
