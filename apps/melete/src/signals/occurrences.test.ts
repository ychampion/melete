import { describe, expect, test } from 'bun:test';
import { CalendarTooLarge, confirmFromIcs, expandIcs, zonedToUtc } from './occurrences.ts';

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
    test(`a repeating event is its instances, with exceptions, across a DST change (${withZone ? 'VTIMEZONE in the file' : 'IANA zone by name only'})`, async () => {
      const read = await expandIcs([weekly(withZone)], WINDOW);
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

  test('a single event has no occurrence id, an all-day one keeps its date, and an instance without its series stands alone', async () => {
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
    const read = await expandIcs([ics], WINDOW);
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

  test('a floating time with no zone reads as UTC, never as the server clock', async () => {
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
    expect((await expandIcs([ics], WINDOW)).items[0]?.start).toBe('2026-10-20T09:00:00.000Z');
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

describe('what one calendar read may cost', () => {
  const series = (count: number, rule: string, start: string) =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...Array.from({ length: count }, (_, index) => [
        'BEGIN:VEVENT',
        `UID:flood-${index}@feed.example`,
        `DTSTART:${start}`,
        'DURATION:PT1M',
        `RRULE:${rule}`,
        'SUMMARY:x',
        'END:VEVENT',
      ]).flat(),
      'END:VCALENDAR',
    ].join('\r\n');

  test('a feed of many minutely series is refused within the budget, and other work keeps running meanwhile', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    const began = performance.now();
    try {
      const refused = await expandIcs(
        [series(200, 'FREQ=MINUTELY', '20261018T000000Z')],
        WINDOW,
      ).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(CalendarTooLarge);
      expect((refused as Error).message).toContain('repeating events');
    } finally {
      clearInterval(timer);
    }
    expect(performance.now() - began).toBeLessThan(5_000);
    // The expansion yielded: the timer ran while it worked.
    expect(ticks).toBeGreaterThan(0);
  });

  test('a series with a COUNT walked from long ago stops at the step budget', async () => {
    const refused = await expandIcs(
      [series(5, 'FREQ=SECONDLY;COUNT=100000', '20200101T000000Z')],
      WINDOW,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CalendarTooLarge);
  });

  test('a daily series that began decades ago still has its instances in the window', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:old-daily@example.test',
      'DTSTART;TZID=America/New_York:19900102T090000',
      'DTEND;TZID=America/New_York:19900102T091500',
      'RRULE:FREQ=DAILY',
      'SUMMARY:Standup',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:old-hourly@example.test',
      'DTSTART:20200101T000000Z',
      'DURATION:PT10M',
      'RRULE:FREQ=HOURLY;INTERVAL=6',
      'SUMMARY:Sync',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:old-monthly@example.test',
      'DTSTART:19990120T150000Z',
      'DTEND:19990120T160000Z',
      'RRULE:FREQ=MONTHLY',
      'SUMMARY:Board',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const read = await expandIcs([ics], WINDOW);
    const of = (uid: string) => read.items.filter((item) => item.uid === uid);
    // 18 October to 19 November: one standup a day, at 09:00 New York time.
    expect(of('old-daily@example.test')).toHaveLength(33);
    expect(of('old-daily@example.test')[0]).toMatchObject({
      occurrence: '2026-10-18T13:00:00.000Z',
      start: '2026-10-18T13:00:00.000Z',
    });
    expect(of('old-daily@example.test').at(-1)?.start).toBe('2026-11-19T14:00:00.000Z');
    expect(of('old-hourly@example.test')).toHaveLength(33 * 4);
    expect(of('old-monthly@example.test').map((item) => item.start)).toEqual([
      '2026-10-20T15:00:00.000Z',
    ]);
  });

  test('a time in the spring-forward gap is read with the offset before the gap; a repeated hour takes the first', () => {
    const at = (month: number, day: number, hour: number, minute: number) =>
      new Date(
        zonedToUtc({ year: 2026, month, day, hour, minute, second: 0 }, 'America/New_York'),
      ).toISOString();
    // 02:30 does not exist on 8 March 2026 in New York: it is 03:30 daylight time.
    expect(at(3, 8, 2, 30)).toBe('2026-03-08T07:30:00.000Z');
    expect(at(3, 8, 3, 30)).toBe('2026-03-08T07:30:00.000Z');
    expect(at(3, 8, 1, 30)).toBe('2026-03-08T06:30:00.000Z');
    // 01:30 happens twice on 1 November 2026: the first is daylight time.
    expect(at(11, 1, 1, 30)).toBe('2026-11-01T05:30:00.000Z');
    expect(
      new Date(
        zonedToUtc(
          { year: 2026, month: 10, day: 4, hour: 2, minute: 30, second: 0 },
          'Australia/Sydney',
        ),
      ).toISOString(),
    ).toBe('2026-10-03T16:30:00.000Z');
  });
});

describe('looking an occurrence up again', () => {
  const file = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:moved@example.test',
    'DTSTART:20261210T150000Z',
    'DTEND:20261210T160000Z',
    'SUMMARY:Moved far away',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:series@example.test',
    'DTSTART:20261019T150000Z',
    'DTEND:20261019T153000Z',
    'RRULE:FREQ=WEEKLY',
    'EXDATE:20261026T150000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:series@example.test',
    'RECURRENCE-ID:20261102T150000Z',
    'DTSTART:20261215T150000Z',
    'DTEND:20261215T153000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  test('an event the calendar no longer holds, or an instance it removed, is gone', () => {
    expect(confirmFromIcs([file], 'deleted@example.test', null)).toBe('gone');
    expect(confirmFromIcs([file], 'series@example.test', '2026-10-26T15:00:00.000Z')).toBe('gone');
  });

  test('a single event or a changed instance that moved is found where it now is', () => {
    expect(confirmFromIcs([file], 'moved@example.test', null)).toMatchObject({
      start: '2026-12-10T15:00:00.000Z',
      title: 'Moved far away',
    });
    expect(confirmFromIcs([file], 'series@example.test', '2026-11-02T15:00:00.000Z')).toMatchObject(
      { start: '2026-12-15T15:00:00.000Z' },
    );
  });

  test('an instance of a series that is neither removed nor changed is not known', () => {
    expect(confirmFromIcs([file], 'series@example.test', '2026-11-09T15:00:00.000Z')).toBe(
      'unknown',
    );
  });
});
