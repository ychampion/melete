import { expect, test } from 'bun:test';
import { keptAnswer, SETUP_QUESTIONS } from './setup-answers.ts';
import { setupTimeZone } from './timezone.ts';

test('a skip, an empty answer or a stand-in is never kept as a fact', () => {
  for (const value of ['', '   ', 'Somewhere else', 'my family', 'My team at work', 'Skip'])
    expect(keptAnswer(value)).toBeNull();
});

test('what the person typed is kept as they said it', () => {
  expect(keptAnswer('  Pune ')).toBe('Pune');
  expect(keptAnswer('Sam, my partner;   Priya, my manager')).toBe(
    'Sam, my partner; Priya, my manager',
  );
});

test('no question offers a placeholder or a made-up person as an answer', () => {
  for (const question of SETUP_QUESTIONS)
    for (const suggestion of question.suggestions) expect(keptAnswer(suggestion)).toBe(suggestion);
  const offered = SETUP_QUESTIONS.flatMap((question) => question.suggestions);
  expect(offered).not.toContain('Alex and Priya');
  expect(offered).not.toContain('New York');
  // The names reply repeats what was said, not its first word.
  const names = SETUP_QUESTIONS.find((question) => question.key === 'pref.people.names');
  expect(names?.reply('My sister Ana')).toContain('My sister Ana');
});

test('setup saves the browser zone unless the person already chose one', () => {
  expect(setupTimeZone({ time_zone: 'UTC', time_zone_confirmed: false }, 'Asia/Kolkata')).toBe(
    'Asia/Kolkata',
  );
  expect(
    setupTimeZone({ time_zone: 'Europe/London', time_zone_confirmed: true }, 'Asia/Kolkata'),
  ).toBe('Europe/London');
  expect(setupTimeZone(null, null)).toBe('UTC');
  expect(setupTimeZone({ time_zone: 'UTC', time_zone_confirmed: false }, null)).toBe('UTC');
});
