/**
 * "Needs you" says urgency in a word only when it is more than ordinary, and
 * mentions unsorted items only when there are some.
 */
import { expect, test } from 'bun:test';
import { unsortedLine, urgencyWords, whenWords } from './NeedsYouSection.tsx';

test('urgency in a word, and nothing for the ordinary lane', () => {
  expect(urgencyWords('urgent')).toBe('Urgent');
  expect(urgencyWords('soon')).toBe('Soon');
  expect(urgencyWords('normal')).toBeNull();
});

test('a time today, a day and time otherwise, nothing without one', () => {
  const now = Date.parse('2026-10-07T15:00:00');
  expect(whenWords('2026-10-07T09:14:00', now)).toBe('9:14 AM');
  expect(whenWords('2026-10-05T09:14:00', now)).toBe('Mon 9:14 AM');
  expect(whenWords(null, now)).toBeNull();
});

test('unsorted items are mentioned only when there are some', () => {
  expect(unsortedLine(0)).toBeNull();
  expect(unsortedLine(3)).toBe('3 not sorted yet');
});
