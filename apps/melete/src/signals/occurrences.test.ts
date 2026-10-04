import { describe, expect, test } from 'bun:test';
import { expandIcs, zonedToUtc } from './occurrences.ts';

const NEW_YORK = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'TZNAME:EDT',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'TZNAME:EST',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/**
 * A weekly Monday 09:00 New York meeting across the end of summer time: one
 * Monday removed (EXDATE), one extra Wednesday (RDATE), one moved and
 * re-roomed, one cancelled, and one moved into the window from a week the
 * rule's walk never reaches.
 */
function weekly(withZone: boolean) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Fixture//EN',
    ...(withZone ? NEW_YORK : []),
    'BEGIN:VEVENT',
    'UID:weekly@example.test',
    'DTSTAMP:20261001T000000Z',
    'DTSTART;TZID=America/New_York:20261019T090000',
    'DTEND;TZID=America/New_York:20261019T093000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=8',
    'EXDATE;TZID=America/New_York:20261026T090000',
    'RDATE;TZID=America/New_York:20261104T090000',
    'SUMMARY:Pipeline review',
    'LOCATION:Room 1',
    'ATTENDEE:mailto:a@example.test',
    'ATTENDEE:mailto:b@example.test',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.test',
    'DTSTAMP:20261001T000000Z',
    'RECURRENCE-ID;TZID=America/New_York:20261109T090000',
    'DTSTART;TZID=America/New_York:20261109T110000',
    'DTEND;TZID=America/New_York:20261109T113000',
    'SUMMARY:Pipeline review',
    'LOCATION:Room 2',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.test',
    'DTSTAMP:20261001T000000Z',
    'RECURRENCE-ID;TZID=America/New_York:20261116T090000',
    'DTSTART;TZID=America/New_York:20261116T090000',
    'DTEND;TZID=America/New_York:20261116T093000',
    'SUMMARY:Pipeline review',
    'STATUS:CANCELLED',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly@example.test',
    'DTSTAMP:20261001T000000Z',
    'RECURRENCE-ID;TZID=America/New_York:20261123T090000',
    'DTSTART;TZID=America/New_York:20261119T100000',
    'DTEND;TZID=America/New_York:20261119T103000',
    'SUMMARY:Pipeline review (early)',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

const WINDOW = { from: '2026-10-18T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' };

describe('calendar occurrences from iCalendar', () => {
  for (const withZone of [true, false])
    test(`a repeating event is its instances, with exceptions, across a DST change (${withZone ? 'VTIMEZONE in the file' : 'IANA zone by name only'})`, () => {
      const read = expandIcs([weekly(withZone)], WINDOW);
      expect(read.complete).toBe(true);
      expect(
        read.items.map((item) => [item.occurrence, item.start, item.location, item.status]),
      ).toEqual([
        // Summer time: 09:00 in New York is 13:00Z.
        ['2026-10-19T13:00:00.000Z', '2026-10-19T13:00:00.000Z', 'Room 1', 'confirmed'],
        // 26 October is removed by EXDATE. After 1 November, 09:00 is 14:00Z.
        ['2026-11-02T14:00:00.000Z', '2026-11-02T14:00:00.000Z', 'Room 1', 'confirmed'],
        // The extra Wednesday from RDATE.
        ['2026-11-04T14:00:00.000Z', '2026-11-04T14:00:00.000Z', 'Room 1', 'confirmed'],
        // Moved to 11:00 and to another room: still the 9 November instance.
        ['2026-11-09T14:00:00.000Z', '2026-11-09T16:00:00.000Z', 'Room 2', 'confirmed'],
        ['2026-11-16T14:00:00.000Z', '2026-11-16T14:00:00.000Z', '', 'cancelled'],
        // The 23 November instance, moved into the window.
        ['2026-11-23T14:00:00.000Z', '2026-11-19T15:00:00.000Z', '', 'confirmed'],
      ]);
      const first = read.items[0];
      expect(first).toMatchObject({
        uid: 'weekly@example.test',
        title: 'Pipeline review',
        end: '2026-10-19T13:30:00.000Z',
        all_day: false,
        attendees: 2,
        time_zone: 'America/New_York',
      });
    });

  test('a single event has no occurrence id, an all-day one keeps its date, and an instance without its series stands alone', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:single@example.test',
      'DTSTART:20261020T150000Z',
      'DTEND:20261020T160000Z',
      'SUMMARY:Dentist',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:holiday@example.test',
      'DTSTART;VALUE=DATE:20261021',
      'DTEND;VALUE=DATE:20261022',
      'SUMMARY:Day off',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:invited-once@example.test',
      'RECURRENCE-ID:20261022T170000Z',
      'DTSTART:20261022T180000Z',
      'DTEND:20261022T190000Z',
      'SUMMARY:One meeting of someone else series',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:old@example.test',
      'DTSTART:20261001T150000Z',
      'DTEND:20261001T160000Z',
      'SUMMARY:Already over',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const read = expandIcs([ics], WINDOW);
    expect(read.items.map((item) => [item.uid, item.occurrence, item.start, item.all_day])).toEqual(
      [
        ['single@example.test', null, '2026-10-20T15:00:00.000Z', false],
        ['holiday@example.test', null, '2026-10-21', true],
        [
          'invited-once@example.test',
          '2026-10-22T17:00:00.000Z',
          '2026-10-22T18:00:00.000Z',
          false,
        ],
      ],
    );
  });

  test('a floating time with no zone reads as UTC, never as the server clock', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:floating@example.test',
      'DTSTART:20261020T090000',
      'DTEND:20261020T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(expandIcs([ics], WINDOW).items[0]?.start).toBe('2026-10-20T09:00:00.000Z');
  });

  test('wall-clock times in a named zone land on the right instant on both sides of a change', () => {
    const wall = (day: number, hour: number) => ({
      year: 2026,
      month: 11,
      day,
      hour,
      minute: 0,
      second: 0,
    });
    expect(new Date(zonedToUtc(wall(1, 0), 'America/New_York')).toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(new Date(zonedToUtc(wall(1, 12), 'America/New_York')).toISOString()).toBe(
      '2026-11-01T17:00:00.000Z',
    );
    expect(new Date(zonedToUtc(wall(1, 12), 'Asia/Kolkata')).toISOString()).toBe(
      '2026-11-01T06:30:00.000Z',
    );
  });
});
