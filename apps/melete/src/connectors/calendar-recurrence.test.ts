import { describe, expect, spyOn, test } from 'bun:test';
import type { Query } from '../broker/records.ts';
import { CalendarConnector, eventsInWindow, importIcs, parseIcs } from './calendar.ts';
import { bindCalendarCheck } from './calendar-truth.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';

const calendar = (properties: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:recurring',
    'SUMMARY:Planning',
    ...properties,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

const project = (properties: string[], now: string, timeZone = 'UTC') =>
  importIcs(calendar(properties), null, { now: Date.parse(now), timeZone })[0];

describe('the next date of a calendar series', () => {
  test('a weekly series started months ago shows the next Tuesday and its duration', () => {
    expect(
      project(
        ['DTSTART:20260908T090000Z', 'DTEND:20260908T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU'],
        '2026-10-28T12:00:00Z',
      ),
    ).toMatchObject({
      start: '2026-11-03T09:00:00.000Z',
      end: '2026-11-03T10:00:00.000Z',
      series_start: '2026-09-08T09:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 9:00',
      recurrence_status: 'active',
    });
  });

  test('monthly numbered weekdays keep the second Tuesday of each month', () => {
    expect(
      project(['DTSTART:20260908T090000Z', 'RRULE:FREQ=MONTHLY;BYDAY=2TU'], '2026-10-28T12:00:00Z'),
    ).toMatchObject({
      start: '2026-11-10T09:00:00.000Z',
      recurrence_summary: 'On the second Tuesday of every month at 9:00',
    });
  });

  test('COUNT exhaustion explicitly ends the series without an obsolete next date', () => {
    expect(
      project(
        ['DTSTART:20260908T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3'],
        '2026-10-28T12:00:00Z',
      ),
    ).toMatchObject({ start: '', end: '', recurrence_status: 'ended' });
  });

  test('an EXDATE removes the next date without extending COUNT', () => {
    const properties = [
      'DTSTART:20260908T090000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10',
      'EXDATE:20261103T090000Z',
    ];
    expect(project(properties, '2026-10-28T12:00:00Z')).toMatchObject({
      start: '2026-11-10T09:00:00.000Z',
      recurrence_status: 'active',
    });
    expect(project(properties, '2026-11-11T12:00:00Z')).toMatchObject({
      recurrence_status: 'ended',
    });
  });

  test('daily INTERVAL and inclusive UNTIL use the original anchor', () => {
    const properties = [
      'DTSTART:20261001T090000Z',
      'RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261103T090000Z',
    ];
    expect(project(properties, '2026-11-01T12:00:00Z')).toMatchObject({
      start: '2026-11-03T09:00:00.000Z',
      recurrence_summary: 'Every 3 days at 9:00, until November 3, 2026',
    });
    expect(project(properties, '2026-11-03T09:00:00Z')?.start).toBe('2026-11-03T09:00:00.000Z');
    expect(project(properties, '2026-11-03T09:00:00.001Z')?.recurrence_status).toBe('ended');
  });

  test('yearly INTERVAL and BYDAY keep the second Tuesday of November', () => {
    expect(
      project(
        ['DTSTART:20241112T090000Z', 'RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=11;BYDAY=2TU'],
        '2026-10-28T12:00:00Z',
      ),
    ).toMatchObject({
      start: '2026-11-10T09:00:00.000Z',
      recurrence_summary: 'Every other year on the second Tuesday of November at 9:00',
    });
  });

  test('an all-day series uses the local date, including today after UTC midnight', () => {
    expect(
      project(
        ['DTSTART;VALUE=DATE:20260908', 'DTEND;VALUE=DATE:20260909', 'RRULE:FREQ=WEEKLY;BYDAY=TU'],
        '2026-11-04T02:00:00Z',
        'America/Los_Angeles',
      ),
    ).toMatchObject({
      start: '2026-11-03',
      end: '2026-11-04',
      recurrence_summary: 'Every Tuesday',
      recurrence_status: 'active',
    });
  });

  test('a Pacific series keeps 09:00 across the November 2026 DST change', () => {
    const properties = [
      'DTSTART;TZID=America/Los_Angeles:20260908T090000',
      'DTEND;TZID=America/Los_Angeles:20260908T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=TU',
    ];
    expect(project(properties, '2026-10-25T00:00:00Z')?.start).toBe('2026-10-27T16:00:00.000Z');
    expect(project(properties, '2026-10-28T00:00:00Z', 'America/Los_Angeles')).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      end: '2026-11-03T18:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 9:00',
    });
  });

  test("floating series use the person's zone", () => {
    expect(
      project(
        ['DTSTART:20260908T090000', 'RRULE:FREQ=WEEKLY;BYDAY=TU'],
        '2026-11-03T16:30:00Z',
        'America/Los_Angeles',
      )?.start,
    ).toBe('2026-11-03T17:00:00.000Z');
  });

  test('tool results for this week carry the occurrence date and plain rule', async () => {
    const connector = new CalendarConnector(
      {
        id: 'con_test',
        spaceId: 'spc_test',
        mode: 'ics',
        ics: calendar([
          'DTSTART:20260908T090000Z',
          'DTEND:20260908T100000Z',
          'RRULE:FREQ=WEEKLY;BYDAY=TU',
        ]),
      },
      {
        withSecret: async () => {
          throw new Error('No credential needed');
        },
      },
    );
    const result = await connector.execute(
      mailAction('calendar.list', { from: '2026-11-02', to: '2026-11-09' }),
      mailContext(),
    );
    expect(result).toMatchObject({
      outcome: 'succeeded',
      receipt: {
        detail: {
          events: [
            { start: '2026-11-03T09:00:00.000Z', recurrence_summary: 'Every Tuesday at 9:00' },
          ],
        },
      },
    });
  });

  test('a default listing skips a recurring time that already passed today', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-03T10:00:00Z'));
    try {
      const connector = new CalendarConnector(
        {
          id: 'con_test',
          spaceId: 'spc_test',
          mode: 'ics',
          ics: calendar(['DTSTART:20260908T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU']),
        },
        {
          withSecret: async () => {
            throw new Error('No credential needed');
          },
        },
      );
      const result = await connector.execute(mailAction('calendar.list'), mailContext());
      expect(result).toMatchObject({
        outcome: 'succeeded',
        receipt: {
          detail: {
            events: [{ start: '2026-11-10T09:00:00.000Z' }],
          },
        },
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("listing preparation binds the person's timezone", async () => {
    const tx = (async () => [{ time_zone: 'America/Los_Angeles' }]) as unknown as Query;
    expect(await bindCalendarCheck({}, mailContext(), tx, 'calendar.list')).toEqual({
      time_zone: 'America/Los_Angeles',
    });
  });

  test('a date-only today window includes late local times after UTC midnight', async () => {
    const connector = new CalendarConnector(
      {
        id: 'con_test',
        spaceId: 'spc_test',
        mode: 'ics',
        ics: calendar([
          'DTSTART;TZID=America/Los_Angeles:20260908T233000',
          'RRULE:FREQ=WEEKLY;BYDAY=TU',
        ]),
      },
      {
        withSecret: async () => {
          throw new Error('No credential needed');
        },
      },
    );
    expect(
      await connector.execute(
        mailAction('calendar.list', {
          from: '2026-11-03',
          to: '2026-11-04',
          time_zone: 'America/Los_Angeles',
        }),
        mailContext(),
      ),
    ).toMatchObject({
      outcome: 'succeeded',
      receipt: {
        detail: {
          events: [{ start: '2026-11-04T07:30:00.000Z' }],
        },
      },
    });
  });

  test('looking ahead does not rewrite the original recurrence anchor', () => {
    const parsed = parseIcs(calendar(['DTSTART:20200908T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU']));
    eventsInWindow(parsed, { from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' }, 50);
    expect(
      eventsInWindow(
        parsed,
        {
          from: '2020-09-01T00:00:00Z',
          to: '2020-10-01T00:00:00Z',
        },
        50,
      ).events[0]?.start,
    ).toBe('2020-09-08T09:00:00.000Z');
  });

  test('an invitation to one instance without its master remains visible', () => {
    expect(
      project(
        ['DTSTART:20261103T090000Z', 'RECURRENCE-ID:20261103T090000Z'],
        '2026-10-28T12:00:00Z',
      ),
    ).toMatchObject({ start: '2026-11-03T09:00:00.000Z' });
  });

  test('a moved instance is ordered by its actual time rather than its original date', () => {
    const ics = calendar(['DTSTART:20260908T090000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU']).replace(
      'END:VCALENDAR',
      [
        'BEGIN:VEVENT',
        'UID:recurring',
        'RECURRENCE-ID:20261103T090000Z',
        'DTSTART:20261112T090000Z',
        'SUMMARY:Moved planning',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    );
    expect(importIcs(ics, null, { now: Date.parse('2026-10-28T12:00:00Z') })[0]?.start).toBe(
      '2026-11-10T09:00:00.000Z',
    );
  });

  test('a UTC exclusion matches a named Pacific occurrence after DST changes', () => {
    expect(
      project(
        [
          'DTSTART;TZID=America/Los_Angeles:20260908T090000',
          'RRULE:FREQ=WEEKLY;BYDAY=TU',
          'EXDATE:20261103T170000Z',
        ],
        '2026-10-28T12:00:00Z',
      )?.start,
    ).toBe('2026-11-10T17:00:00.000Z');
  });

  test('UTC UNTIL is compared to the Pacific instant after DST, not its wall clock', () => {
    expect(
      project(
        [
          'DTSTART;TZID=America/Los_Angeles:20260908T090000',
          'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261103T160000Z',
        ],
        '2026-10-28T12:00:00Z',
      ),
    ).toMatchObject({
      start: '',
      recurrence_status: 'ended',
    });
  });

  test('an exhausted supported COUNT can be longer than the ordinary search budget', () => {
    expect(
      project(['DTSTART:20000101T090000Z', 'RRULE:FREQ=DAILY;COUNT=6000'], '2026-10-28T12:00:00Z'),
    ).toMatchObject({ start: '', recurrence_status: 'ended' });
  });

  test('a long COUNT series resolves without walking from its first day', () => {
    const rule = ['DTSTART;TZID=America/New_York:20000101T090000', 'RRULE:FREQ=DAILY;COUNT=9999'];
    const began = performance.now();
    const view = project(rule, '2026-10-28T12:00:00Z', 'America/New_York');
    expect(performance.now() - began).toBeLessThan(200);
    expect(view).toMatchObject({
      start: '2026-10-28T13:00:00.000Z',
      recurrence_summary: 'Every day at 9:00, 9999 times',
      recurrence_status: 'active',
    });
    // The 9999th day is May 17, 2027, and nothing comes after it.
    expect(project(rule, '2027-05-17T12:00:00Z', 'America/New_York')).toMatchObject({
      start: '2027-05-17T13:00:00.000Z',
    });
    expect(project(rule, '2027-05-18T12:00:00Z', 'America/New_York')).toMatchObject({
      start: '',
      recurrence_status: 'ended',
    });
  });

  test("the rule is said on the person's clock, as the card shows it", () => {
    const pacific = (properties: string[]) =>
      project(properties, '2026-10-28T12:00:00Z', 'America/Los_Angeles');
    expect(pacific(['DTSTART:20260908T170000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU'])).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 9:00',
    });
    expect(
      pacific(['DTSTART;TZID=America/New_York:20260908T120000', 'RRULE:FREQ=WEEKLY;BYDAY=TU']),
    ).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 9:00',
    });
    // 02:00 UTC on a Wednesday is Tuesday evening in California.
    expect(pacific(['DTSTART:20260909T020000Z', 'RRULE:FREQ=WEEKLY;BYDAY=WE'])).toMatchObject({
      start: '2026-11-04T02:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 18:00',
    });
  });

  test('a yearly February 29th waits for the next leap year', () => {
    expect(
      project(['DTSTART:20240229T090000Z', 'RRULE:FREQ=YEARLY'], '2026-10-28T12:00:00Z'),
    ).toMatchObject({ start: '2028-02-29T09:00:00.000Z', recurrence_status: 'active' });
  });

  test('a date-only UNTIL on a timed series runs through that local date', () => {
    const properties = [
      'DTSTART;TZID=America/Los_Angeles:20261001T090000',
      'RRULE:FREQ=DAILY;INTERVAL=3;UNTIL=20261103',
    ];
    expect(project(properties, '2026-11-01T12:00:00Z', 'America/Los_Angeles')).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'Every 3 days at 9:00, until November 3, 2026',
      recurrence_status: 'active',
    });
    expect(project(properties, '2026-11-04T12:00:00Z', 'America/Los_Angeles')).toMatchObject({
      start: '',
      recurrence_status: 'ended',
    });
  });

  test('a meeting under way is the current occurrence', () => {
    expect(
      project(
        ['DTSTART:20260908T090000Z', 'DTEND:20260908T100000Z', 'RRULE:FREQ=WEEKLY;BYDAY=TU'],
        '2026-11-03T09:30:00Z',
      ),
    ).toMatchObject({ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' });
  });

  test('a rule ical.js cannot finish or refuses leaves the rest of the list intact', () => {
    const vevent = (uid: string, rule: string) => [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `SUMMARY:${uid}`,
      'DTSTART:20261028T150000Z',
      'DTEND:20261028T160000Z',
      `RRULE:${rule}`,
      'END:VEVENT',
    ];
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...vevent('never', 'FREQ=SECONDLY;BYMONTH=2;BYMONTHDAY=30'),
      ...vevent('never-reached', 'FREQ=DAILY;INTERVAL=7;BYDAY=TH'),
      ...vevent('huge', 'FREQ=DAILY;INTERVAL=99999999999999'),
      ...vevent('refused', 'FREQ=YEARLY;INTERVAL=99999999'),
      ...vevent('weekly', 'FREQ=WEEKLY'),
      'END:VCALENDAR',
    ].join('\r\n');
    const listed = eventsInWindow(
      parseIcs(ics),
      { from: '2026-10-28T00:00:00.000Z', to: '2026-11-28T00:00:00.000Z' },
      10,
      { now: Date.parse('2026-10-28T12:00:00Z') },
    );
    const unread = {
      start: '2026-10-28T15:00:00.000Z',
      end: '2026-10-28T16:00:00.000Z',
      recurrence_summary: 'Repeats',
      recurrence_status: 'unknown',
    };
    expect(Object.fromEntries(listed.events.map((event) => [event.uid, event]))).toMatchObject({
      never: unread,
      'never-reached': unread,
      huge: unread,
      refused: unread,
      weekly: { start: '2026-10-28T15:00:00.000Z', recurrence_status: 'active' },
    });
    expect(listed.truncated).toBe(true);
  });
});
