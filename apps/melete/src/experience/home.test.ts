import { expect, test } from 'bun:test';
import { dayGreeting } from './home.ts';
import { scheduleSentence } from './planning.ts';

test('greeting respects an overnight day window and the profile time zone', () => {
  const profile = {
    name: 'Alex',
    time_zone: 'Asia/Kolkata',
    day_hours: { start: '22:00', end: '06:00' },
  };
  expect(dayGreeting(profile, new Date('2026-09-11T19:00:00Z'))).toMatchObject({
    greeting: 'Good morning, Alex',
    within_day_hours: true,
    date: 'Saturday, 12 September',
  });
  expect(dayGreeting(profile, new Date('2026-09-11T06:00:00Z')).within_day_hours).toBe(false);
  expect(scheduleSentence('30 8 * * 1,2,3,4,5', profile.time_zone)).toBe(
    'Every weekday at 8:30 AM (Asia/Kolkata)',
  );
});
