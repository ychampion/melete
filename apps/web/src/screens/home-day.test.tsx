/**
 * Home's day is drawn on the person's own clock, and its chips are a start for
 * the person to finish, never a request sent on their behalf.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayGrid, promptChips, relative } from './Home.tsx';

const now = Date.parse('2026-10-10T14:56:00Z');

test('the now line sits at the profile’s hour, not the browser’s', () => {
  const pacific = renderToStaticMarkup(
    <DayGrid events={[]} now={now} zone="America/Los_Angeles" />,
  );
  // 7:56 AM in Los Angeles is before the day's first hour, so no now line is drawn.
  expect(pacific).not.toContain('day-now-tag');
  const india = renderToStaticMarkup(<DayGrid events={[]} now={now} zone="Asia/Kolkata" />);
  expect(india).toContain('8:26</span>');
  const later = renderToStaticMarkup(
    <DayGrid events={[]} now={Date.parse('2026-10-10T16:26:00Z')} zone="America/Los_Angeles" />,
  );
  expect(later).toContain('9:26</span>');
});

test('an event is placed and timed on the profile’s clock, and only today’s are drawn', () => {
  const event = (id: string, starts: string, ends: string) => ({
    id,
    title: id,
    starts_at: starts,
    ends_at: ends,
    connection_id: 'conn_cal',
  });
  const html = renderToStaticMarkup(
    <DayGrid
      events={[
        // 9:00 AM in Los Angeles today.
        event('Standup', '2026-10-10T16:00:00Z', '2026-10-10T16:30:00Z'),
        // 9:00 AM in Los Angeles tomorrow.
        event('Tomorrow', '2026-10-11T16:00:00Z', '2026-10-11T16:30:00Z'),
      ]}
      now={now}
      zone="America/Los_Angeles"
    />,
  );
  expect(html).toContain('Standup');
  expect(html).toContain('9:00 AM');
  expect(html).not.toContain('Tomorrow');
});

test('a chat’s time in the list is the profile’s day and hour', () => {
  // 2:00 AM on the 10th in Kolkata is 1:30 PM on the 9th in Los Angeles.
  const iso = '2026-10-09T20:30:00Z';
  expect(relative(iso, now, 'Asia/Kolkata')).toBe('2:00 AM');
  expect(relative(iso, now, 'America/Los_Angeles')).toBe('Yesterday');
});

test('the chips are starts to finish, and none decides where the trip goes', () => {
  for (const calendar of [true, false]) {
    const chips = promptChips(calendar);
    expect(chips.map((chip) => chip.label)).toEqual([
      'Plan my day',
      'Explore an idea',
      'Plan a trip',
    ]);
    for (const chip of chips) {
      // Left open for the person's own words.
      expect(chip.text.endsWith(' ')).toBe(true);
      expect(chip.text).not.toMatch(/Japan|two weeks/);
    }
  }
  // Without a calendar connected, planning the day does not lean on one.
  expect(promptChips(false)[0]?.text).not.toContain('calendar');
  expect(promptChips(true)[0]?.text).toContain('calendar');
});
