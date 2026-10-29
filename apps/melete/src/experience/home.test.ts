import { expect, test } from 'bun:test';
import { dayGreeting, ExperienceHome } from './home.ts';
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

test('upcoming events keep recurrence words and skip ended or unavailable series', () => {
  const event = {
    uid: 'weekly',
    summary: 'Planning',
    start: '2026-11-03T17:00:00.000Z',
    end: '2026-11-03T18:00:00.000Z',
    recurrence_status: 'active',
    recurrence_summary: 'Every Tuesday',
  };
  const events = ExperienceHome.prototype.calendarEvents('con_cal', {
    events: [
      event,
      { ...event, uid: 'ended', recurrence_status: 'ended' },
      { ...event, uid: 'unknown', recurrence_status: 'unknown' },
    ],
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    starts_at: '2026-11-03T17:00:00.000Z',
    recurrence_summary: 'Every Tuesday',
  });
});

test('all-day occurrences remain on their local date through the Pacific DST change', () => {
  const events = ExperienceHome.prototype.calendarEvents(
    'con_cal',
    {
      events: [
        {
          uid: 'daily',
          summary: 'Holiday',
          start: '2026-11-01',
          end: '2026-11-02',
          recurrence_status: 'active',
          recurrence_summary: 'Every day',
        },
      ],
    },
    'America/Los_Angeles',
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    starts_at: '2026-11-01T07:00:00.000Z',
    ends_at: '2026-11-02T08:00:00.000Z',
    all_day: true,
    recurrence_summary: 'Every day',
  });
});
