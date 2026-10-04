import { describe, expect, test } from 'bun:test';
import { expandIcs } from '../signals/occurrences.ts';
import type { Occurrence } from '../signals/types.ts';
import { calendarConcern, IMPORTANT_WITHIN_HOURS, spansOf, windowOf } from './calendar-check.ts';

const now = Date.parse('2026-10-05T09:00:00Z');
const at = (hours: number) => new Date(now + hours * 3600_000).toISOString();
const event = (patch: Partial<Occurrence> = {}): Occurrence => ({
  uid: 'person-1',
  occurrence: null,
  title: 'Dentist',
  start: at(24),
  end: at(25),
  all_day: false,
  location: '',
  status: 'confirmed',
  attendees: 0,
  time_zone: null,
  ...patch,
});
const tomorrow = [{ start: at(24.5), end: at(25.5) }];
const concern = (items: Occurrence[], spans = tomorrow, complete = true) =>
  calendarConcern({ spans, read: { items, complete }, now });

describe('what makes a change on the person’s own calendar important', () => {
  test('a clear slot tomorrow touches nothing important', () => {
    expect(concern([])).toBeNull();
    expect(concern([event({ start: at(30), end: at(31) })])).toBeNull();
  });

  test('anything within the next few hours, or already past, is important', () => {
    expect(concern([], [{ start: at(IMPORTANT_WITHIN_HOURS - 0.5), end: at(5) }])).toBe(
      `It is within the next ${IMPORTANT_WITHIN_HOURS} hours.`,
    );
    expect(concern([], [{ start: at(-2), end: at(-1) }])).not.toBeNull();
    expect(concern([], [{ start: at(IMPORTANT_WITHIN_HOURS + 0.5), end: at(6) }])).toBeNull();
  });

  test('overlapping one of the person’s own events that blocks the time is important', () => {
    expect(concern([event()])).toBe(
      'It overlaps “Dentist” on your calendar, which blocks that time.',
    );
  });

  test('a repeating meeting, guests, or an important mark make an overlap important', () => {
    expect(concern([event({ occurrence: at(24), melete: true })])).toBe(
      'It overlaps “Dentist”, a repeating meeting.',
    );
    expect(concern([event({ attendees: 2, busy: false })])).toBe(
      'It overlaps “Dentist”, which has guests.',
    );
    expect(concern([event({ important: true, melete: true })])).toBe(
      'It overlaps “Dentist”, which is marked important.',
    );
  });

  test('Melete’s own event with no guests, or one marked free, may be overlapped', () => {
    expect(concern([event({ melete: true })])).toBeNull();
    expect(concern([event({ busy: false })])).toBeNull();
    expect(concern([event({ status: 'cancelled' })])).toBeNull();
  });

  test('an all-day event covers its whole day', () => {
    expect(
      concern([event({ all_day: true, start: '2026-10-06', end: '2026-10-06' })]),
    ).not.toBeNull();
  });

  test('a calendar read only in part is important', () => {
    expect(concern([], tomorrow, false)).toBe(
      'Melete could not read all of your calendar around that time.',
    );
  });

  test('a title is quoted on one line and kept short', () => {
    const reason = concern([event({ title: `Board\nreview ${'x'.repeat(80)}` })]);
    expect(reason).not.toContain('\n');
    expect(reason?.length).toBeLessThan(140);
  });
});

describe('the time a change touches', () => {
  const fields = { summary: 'Focus', start: at(24), end: at(25) };
  test('a create touches its new time; an update its new and old times; a removal its old', () => {
    const before = { summary: 'Focus', start: at(48), end: at(49) };
    expect(spansOf('calendar.create', fields, null)).toEqual([{ start: at(24), end: at(25) }]);
    expect(spansOf('calendar.update', fields, before)).toHaveLength(2);
    expect(spansOf('calendar.delete', { uid: 'act_1', etag: '"1"' }, before)).toEqual([
      { start: at(48), end: at(49) },
    ]);
    // A day wider on each side, so an all-day event on the person's own day is read.
    expect(windowOf(spansOf('calendar.update', fields, before))).toEqual({
      from: at(0),
      to: at(73),
    });
    expect(windowOf([])).toBeNull();
  });
});

describe('all-day events on the person’s own day', () => {
  // Los Angeles, from 17:00 local on 10 October: 00:00 UTC on the 11th.
  const evening = [{ start: '2026-10-10T18:00:00-07:00', end: '2026-10-10T19:00:00-07:00' }];
  const anniversary = (patch: Partial<Occurrence> = {}) =>
    event({
      title: 'Anniversary',
      start: '2026-10-10',
      end: '2026-10-11',
      all_day: true,
      important: true,
      ...patch,
    });
  const check = (zones: string[], items: Occurrence[], spans = evening) =>
    calendarConcern({ spans, read: { items, complete: true }, now, zones });

  test('an important all-day event covers the evening in Los Angeles', () => {
    expect(check(['America/Los_Angeles'], [anniversary()])).toBe(
      'It overlaps “Anniversary”, which is marked important.',
    );
    // Its own time zone counts as well, and with no zone known it is read as wide as a date can be.
    expect(check([], [anniversary({ time_zone: 'America/Los_Angeles' })])).not.toBeNull();
    expect(check([], [anniversary()])).not.toBeNull();
  });

  test('the evening before, in Los Angeles, is not that day', () => {
    const before = [{ start: '2026-10-09T18:00:00-07:00', end: '2026-10-09T19:00:00-07:00' }];
    expect(check(['America/Los_Angeles'], [anniversary()], before)).toBeNull();
  });

  test('a calendar read for those hours brings the all-day event back', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:anniversary',
      'DTSTAMP:20261001T000000Z',
      'DTSTART;VALUE=DATE:20261010',
      'DTEND;VALUE=DATE:20261011',
      'PRIORITY:1',
      'SUMMARY:Anniversary',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const window = windowOf(evening);
    if (!window) throw new Error('no window');
    const read = await expandIcs([ics], window);
    expect(read.items.map((item) => item.title)).toEqual(['Anniversary']);
    expect(
      calendarConcern({ spans: evening, read, now, zones: ['America/Los_Angeles'] }),
    ).not.toBeNull();
  });
});

describe('long events', () => {
  test('anything longer than a day asks', () => {
    expect(concern([], [{ start: at(30), end: at(30 + 24 * 30) }])).toBe(
      'It runs longer than a day.',
    );
    expect(concern([], [{ start: at(30), end: at(53) }])).toBeNull();
  });
});

describe('whose event it is', () => {
  test('a UID shaped like Melete’s is only a claim, never Melete’s own', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//test//EN',
      'BEGIN:VEVENT',
      'UID:act_lookslikemelete',
      'DTSTAMP:20261001T000000Z',
      'DTSTART:20261010T180000Z',
      'DTEND:20261010T190000Z',
      'TRANSP:OPAQUE',
      'SUMMARY:Planning',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const read = await expandIcs([ics], {
      from: '2026-10-10T00:00:00Z',
      to: '2026-10-11T00:00:00Z',
    });
    expect(read.items[0]).toMatchObject({ melete_uid: 'act_lookslikemelete' });
    expect(read.items[0]?.melete).toBeUndefined();
    expect(
      calendarConcern({
        spans: [{ start: '2026-10-10T18:30:00Z', end: '2026-10-10T19:30:00Z' }],
        read,
        now: Date.parse('2026-10-01T00:00:00Z'),
      }),
    ).toBe('It overlaps “Planning” on your calendar, which blocks that time.');
  });
});
