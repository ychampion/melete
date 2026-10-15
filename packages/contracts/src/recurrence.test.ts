import { describe, expect, test } from 'bun:test';
import {
  occurrenceBetween,
  occurrences,
  occurrencesAfter,
  parseRecurrence,
  readRecurrence,
  recurrenceWords,
  zonedInstant,
} from './recurrence.ts';

const NEW_YORK = 'America/New_York';

/** The first `take` instants of a rule, as ISO text. */
function first(rrule: string, starts: string, zone: string, take: number): string[] {
  const read = readRecurrence(rrule, starts);
  if (!read.ok) throw new Error(read.problem);
  const out: string[] = [];
  for (const at of occurrences(read.value.rule, read.value.start, zone)) {
    out.push(at.toISOString());
    if (out.length >= take) break;
  }
  return out;
}

/** The first `take` occurrences, as local "YYYY-MM-DD HH:MM" in the zone. */
function local(rrule: string, starts: string, take = 200, zone = NEW_YORK): string[] {
  const read = readRecurrence(rrule, starts);
  if (!read.ok) throw new Error(read.problem);
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const out: string[] = [];
  for (const at of occurrences(read.value.rule, read.value.start, zone)) {
    out.push(format.format(at));
    if (out.length >= take) break;
  }
  return out;
}

/** Local dates at 9:00, the time every RFC 5545 example uses. */
const at9 = (dates: string[]) => dates.map((date) => `${date} 09:00`);

function dates(year: number, month: number, days: number[]): string[] {
  return days.map(
    (day) => `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  );
}

// The examples of RFC 5545 section 3.8.5.3 that this subset covers, in New York.
describe('RFC 5545 example sequences', () => {
  test('daily for 10 occurrences', () => {
    expect(local('FREQ=DAILY;COUNT=10', '1997-09-02T09:00')).toEqual(
      at9(dates(1997, 9, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11])),
    );
  });

  test('daily until December 24, 1997, across the change to standard time', () => {
    const all = local('RRULE:FREQ=DAILY;UNTIL=19971224T000000Z', '1997-09-02T09:00');
    expect(all).toHaveLength(113);
    expect(all[0]).toBe('1997-09-02 09:00');
    expect(all.at(-1)).toBe('1997-12-23 09:00');
    expect(all.every((line) => line.endsWith('09:00'))).toBe(true);
  });

  test('every other day, and every 10 days 5 times', () => {
    expect(local('FREQ=DAILY;INTERVAL=2', '1997-09-02T09:00', 5)).toEqual(
      at9(dates(1997, 9, [2, 4, 6, 8, 10])),
    );
    expect(local('FREQ=DAILY;INTERVAL=10;COUNT=5', '1997-09-02T09:00')).toEqual(
      at9([...dates(1997, 9, [2, 12, 22]), ...dates(1997, 10, [2, 12])]),
    );
  });

  test('every day in January for 3 years', () => {
    const all = local('FREQ=DAILY;UNTIL=20000131T140000Z;BYMONTH=1', '1998-01-01T09:00');
    expect(all).toHaveLength(93);
    expect(all.slice(30, 32)).toEqual(['1998-01-31 09:00', '1999-01-01 09:00']);
    expect(all.at(-1)).toBe('2000-01-31 09:00');
  });

  test('weekly for 10 occurrences', () => {
    expect(local('FREQ=WEEKLY;COUNT=10', '1997-09-02T09:00')).toEqual(
      at9([
        ...dates(1997, 9, [2, 9, 16, 23, 30]),
        ...dates(1997, 10, [7, 14, 21, 28]),
        ...dates(1997, 11, [4]),
      ]),
    );
  });

  test('every other week on Monday, Wednesday and Friday until December 24', () => {
    expect(
      local(
        'FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000Z;WKST=SU;BYDAY=MO,WE,FR',
        '1997-09-01T09:00',
      ),
    ).toEqual(
      at9([
        ...dates(1997, 9, [1, 3, 5, 15, 17, 19, 29]),
        ...dates(1997, 10, [1, 3, 13, 15, 17, 27, 29, 31]),
        ...dates(1997, 11, [10, 12, 14, 24, 26, 28]),
        ...dates(1997, 12, [8, 10, 12, 22]),
      ]),
    );
  });

  test('weekly on Tuesday and Thursday for five weeks', () => {
    expect(local('FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH', '1997-09-02T09:00')).toEqual(
      at9([...dates(1997, 9, [2, 4, 9, 11, 16, 18, 23, 25, 30]), ...dates(1997, 10, [2])]),
    );
  });

  test('the week start changes which days an every-other-week rule takes', () => {
    expect(local('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO', '1997-08-05T09:00')).toEqual(
      at9(dates(1997, 8, [5, 10, 19, 24])),
    );
    expect(local('FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU', '1997-08-05T09:00')).toEqual(
      at9(dates(1997, 8, [5, 17, 19, 31])),
    );
  });

  test('monthly on the first Friday for 10 occurrences', () => {
    expect(local('FREQ=MONTHLY;COUNT=10;BYDAY=1FR', '1997-09-05T09:00')).toEqual(
      at9([
        '1997-09-05',
        '1997-10-03',
        '1997-11-07',
        '1997-12-05',
        '1998-01-02',
        '1998-02-06',
        '1998-03-06',
        '1998-04-03',
        '1998-05-01',
        '1998-06-05',
      ]),
    );
  });

  test('every other month on the first and last Sunday', () => {
    expect(local('FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU', '1997-09-07T09:00')).toEqual(
      at9([
        '1997-09-07',
        '1997-09-28',
        '1997-11-02',
        '1997-11-30',
        '1998-01-04',
        '1998-01-25',
        '1998-03-01',
        '1998-03-29',
        '1998-05-03',
        '1998-05-31',
      ]),
    );
  });

  test('monthly on the second-to-last Monday', () => {
    expect(local('FREQ=MONTHLY;COUNT=6;BYDAY=-2MO', '1997-09-22T09:00')).toEqual(
      at9(['1997-09-22', '1997-10-20', '1997-11-17', '1997-12-22', '1998-01-19', '1998-02-16']),
    );
  });

  test('monthly on the third-to-last day', () => {
    expect(local('FREQ=MONTHLY;BYMONTHDAY=-3', '1997-09-28T09:00', 6)).toEqual(
      at9(['1997-09-28', '1997-10-29', '1997-11-28', '1997-12-29', '1998-01-29', '1998-02-26']),
    );
  });

  test('monthly on the 2nd and 15th, and on the first and last day', () => {
    expect(local('FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15', '1997-09-02T09:00')).toEqual(
      at9([
        ...dates(1997, 9, [2, 15]),
        ...dates(1997, 10, [2, 15]),
        ...dates(1997, 11, [2, 15]),
        ...dates(1997, 12, [2, 15]),
        ...dates(1998, 1, [2, 15]),
      ]),
    );
    expect(local('FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1', '1997-09-30T09:00')).toEqual(
      at9([
        '1997-09-30',
        '1997-10-01',
        '1997-10-31',
        '1997-11-01',
        '1997-11-30',
        '1997-12-01',
        '1997-12-31',
        '1998-01-01',
        '1998-01-31',
        '1998-02-01',
      ]),
    );
  });

  test('every 18 months on the 10th to the 15th', () => {
    expect(
      local('FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15', '1997-09-10T09:00'),
    ).toEqual(
      at9([...dates(1997, 9, [10, 11, 12, 13, 14, 15]), ...dates(1999, 3, [10, 11, 12, 13])]),
    );
  });

  test('every Tuesday, every other month', () => {
    expect(local('FREQ=MONTHLY;INTERVAL=2;BYDAY=TU', '1997-09-02T09:00', 13)).toEqual(
      at9([
        ...dates(1997, 9, [2, 9, 16, 23, 30]),
        ...dates(1997, 11, [4, 11, 18, 25]),
        ...dates(1998, 1, [6, 13, 20, 27]),
      ]),
    );
  });

  test('yearly in June and July, and every other year in January to March', () => {
    expect(local('FREQ=YEARLY;COUNT=10;BYMONTH=6,7', '1997-06-10T09:00')).toEqual(
      at9([1997, 1998, 1999, 2000, 2001].flatMap((year) => [`${year}-06-10`, `${year}-07-10`])),
    );
    expect(local('FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3', '1997-03-10T09:00')).toEqual(
      at9([
        '1997-03-10',
        ...[1999, 2001, 2003].flatMap((year) => [
          `${year}-01-10`,
          `${year}-02-10`,
          `${year}-03-10`,
        ]),
      ]),
    );
  });

  test('every 20th Monday of the year, and every Thursday in March', () => {
    expect(local('FREQ=YEARLY;BYDAY=20MO', '1997-05-19T09:00', 3)).toEqual(
      at9(['1997-05-19', '1998-05-18', '1999-05-17']),
    );
    expect(local('FREQ=YEARLY;BYMONTH=3;BYDAY=TH', '1997-03-13T09:00', 11)).toEqual(
      at9([
        ...dates(1997, 3, [13, 20, 27]),
        ...dates(1998, 3, [5, 12, 19, 26]),
        ...dates(1999, 3, [4, 11, 18, 25]),
      ]),
    );
  });

  test('every Friday the 13th, and the first Saturday after the first Sunday', () => {
    expect(local('FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', '1997-09-02T09:00', 5)).toEqual(
      at9(['1998-02-13', '1998-03-13', '1998-11-13', '1999-08-13', '2000-10-13']),
    );
    expect(
      local('FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13', '1997-09-13T09:00', 10),
    ).toEqual(
      at9([
        '1997-09-13',
        '1997-10-11',
        '1997-11-08',
        '1997-12-13',
        '1998-01-10',
        '1998-02-07',
        '1998-03-07',
        '1998-04-11',
        '1998-05-09',
        '1998-06-13',
      ]),
    );
  });

  test('election day: every 4 years, the first Tuesday after a Monday in November', () => {
    expect(
      local(
        'FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8',
        '1996-11-05T09:00',
        3,
      ),
    ).toEqual(at9(['1996-11-05', '2000-11-07', '2004-11-02']));
  });

  test('a numbered day of the year beside a day of the month counts through the year', () => {
    // January 1 when it is the 53rd-from-last Thursday: a year that starts on a Thursday.
    expect(local('FREQ=YEARLY;BYDAY=-53TH;BYMONTHDAY=1', '2026-01-01T09:00', 4)).toEqual([
      '2026-01-01 09:00',
      '2032-01-01 09:00',
      '2037-01-01 09:00',
      '2043-01-01 09:00',
    ]);
  });

  test('a month without the day is skipped, not moved', () => {
    expect(local('FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5', '2007-01-15T09:00')).toEqual(
      at9(['2007-01-15', '2007-01-30', '2007-02-15', '2007-03-15', '2007-03-30']),
    );
  });
});

describe('schedules people ask for', () => {
  test('every other Friday counts its weeks from the start', () => {
    expect(local('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '2026-10-16T09:00', 4)).toEqual([
      '2026-10-16 09:00',
      '2026-10-30 09:00',
      '2026-11-13 09:00',
      '2026-11-27 09:00',
    ]);
    // Starting on a Wednesday, the first Friday is that week's.
    expect(local('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '2026-10-14T09:00', 2)).toEqual([
      '2026-10-16 09:00',
      '2026-10-30 09:00',
    ]);
    // Starting the next week gives the other Fridays.
    expect(local('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '2026-10-23T09:00', 2)).toEqual([
      '2026-10-23 09:00',
      '2026-11-06 09:00',
    ]);
  });

  test('the 31st only in months that have one', () => {
    expect(local('FREQ=MONTHLY', '2026-01-31T08:00', 4)).toEqual([
      '2026-01-31 08:00',
      '2026-03-31 08:00',
      '2026-05-31 08:00',
      '2026-07-31 08:00',
    ]);
  });

  test('the last day of each month, February in leap years included', () => {
    expect(local('FREQ=MONTHLY;BYMONTHDAY=-1', '2027-12-01T18:00', 4)).toEqual([
      '2027-12-31 18:00',
      '2028-01-31 18:00',
      '2028-02-29 18:00',
      '2028-03-31 18:00',
    ]);
  });

  test('February 29 comes round only in leap years, and not in 2100', () => {
    expect(local('FREQ=YEARLY', '2024-02-29T09:00', 3)).toEqual([
      '2024-02-29 09:00',
      '2028-02-29 09:00',
      '2032-02-29 09:00',
    ]);
    expect(local('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2096-01-01T09:00', 2)).toEqual([
      '2096-02-29 09:00',
      '2104-02-29 09:00',
    ]);
    expect(local('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1', '2027-01-01T09:00', 2)).toEqual([
      '2027-02-28 09:00',
      '2028-02-29 09:00',
    ]);
  });

  test('a rule that never comes round ends instead of searching for ever', () => {
    expect(local('FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=30', '2026-01-01T09:00')).toEqual([]);
    expect(local('FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31', '2026-01-01T09:00')).toEqual([]);
  });

  test('the last Friday of each month', () => {
    expect(local('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-01T17:00', 3)).toEqual([
      '2026-10-30 17:00',
      '2026-11-27 17:00',
      '2026-12-25 17:00',
    ]);
  });
});

describe('time zones and daylight saving', () => {
  test('a 9:00 rule stays at 9:00 local across both changes', () => {
    expect(first('FREQ=DAILY', '2026-10-31T09:00', NEW_YORK, 2)).toEqual([
      '2026-10-31T13:00:00.000Z',
      '2026-11-01T14:00:00.000Z',
    ]);
    expect(first('FREQ=WEEKLY', '2026-03-01T09:00', NEW_YORK, 2)).toEqual([
      '2026-03-01T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
    ]);
  });

  test('a time skipped by the change moves forward by the gap', () => {
    expect(local('FREQ=DAILY', '2026-03-07T02:30', 3)).toEqual([
      '2026-03-07 02:30',
      '2026-03-08 03:30',
      '2026-03-09 02:30',
    ]);
  });

  test('a time that happens twice is the first', () => {
    expect(
      zonedInstant(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30, second: 0 },
        NEW_YORK,
      ).toISOString(),
    ).toBe('2026-11-01T05:30:00.000Z');
  });

  test('zones with half-hour offsets and the southern hemisphere', () => {
    expect(local('FREQ=DAILY', '2026-10-16T09:00', 1, 'Asia/Kolkata')).toEqual([
      '2026-10-16 09:00',
    ]);
    // Sydney leaves daylight saving on April 5, 2026.
    expect(first('FREQ=DAILY', '2026-04-04T09:00', 'Australia/Sydney', 2)).toEqual([
      '2026-04-03T22:00:00.000Z',
      '2026-04-04T23:00:00.000Z',
    ]);
  });

  test('zones twelve or more hours ahead of UTC change at the right moment', () => {
    // New Zealand goes forward at 2:00 on September 27, 2026 and back at 3:00 on April 5.
    const auckland = (day: number, month: number, hour: number) =>
      zonedInstant(
        { year: 2026, month, day, hour, minute: 30, second: 0 },
        'Pacific/Auckland',
      ).toISOString();
    expect(auckland(27, 9, 2)).toBe('2026-09-26T14:30:00.000Z');
    expect(auckland(5, 4, 2)).toBe('2026-04-04T13:30:00.000Z');
    expect(auckland(5, 4, 1)).toBe('2026-04-04T12:30:00.000Z');
    expect(first('FREQ=DAILY', '2026-09-25T02:30', 'Pacific/Auckland', 4)).toEqual([
      '2026-09-24T14:30:00.000Z',
      '2026-09-25T14:30:00.000Z',
      '2026-09-26T14:30:00.000Z',
      '2026-09-27T13:30:00.000Z',
    ]);
  });

  test('UNTIL as a local date includes that whole day', () => {
    expect(local('FREQ=DAILY;UNTIL=20261018', '2026-10-16T21:00')).toEqual([
      '2026-10-16 21:00',
      '2026-10-17 21:00',
      '2026-10-18 21:00',
    ]);
  });
});

describe('finding the next time', () => {
  const read = readRecurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=3', '2026-10-16T09:00');
  if (!read.ok) throw new Error(read.problem);
  const { rule, start } = read.value;

  test('the next occurrences after a moment, and none once COUNT is used up', () => {
    expect(
      occurrencesAfter(rule, start, NEW_YORK, new Date('2026-10-20T00:00:00Z'), 5).map((at) =>
        at.toISOString(),
      ),
    ).toEqual(['2026-10-30T13:00:00.000Z', '2026-11-13T14:00:00.000Z']);
    expect(occurrencesAfter(rule, start, NEW_YORK, new Date('2026-12-01T00:00:00Z'), 1)).toEqual(
      [],
    );
  });

  test('asking from a later moment gives the times reading from the start would', () => {
    const rules: [string, string][] = [
      ['FREQ=DAILY', '2019-03-09T02:30'],
      ['FREQ=DAILY;INTERVAL=3', '2020-02-29T23:45'],
      ['FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', '2021-01-01T09:00'],
      ['FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,SU;WKST=SU', '2021-06-13T07:15'],
      ['FREQ=MONTHLY;BYDAY=-1FR', '2018-05-01T17:00'],
      ['FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31', '2017-01-31T09:00'],
      ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29', '2016-02-29T09:00'],
      ['FREQ=DAILY;COUNT=2500', '2020-01-01T01:30'],
      ['FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20270301', '2024-01-02T09:00'],
    ];
    const moments = ['2024-11-03T06:30:00Z', '2026-10-15T12:00:00Z', '2027-02-28T23:00:00Z'];
    for (const [rrule, starts] of rules) {
      const read = readRecurrence(rrule, starts);
      if (!read.ok) throw new Error(read.problem);
      const { rule, start } = read.value;
      for (const moment of moments) {
        const after = new Date(moment);
        const week = new Date(after.getTime() - 7 * 86_400_000);
        const next: string[] = [];
        let latest: string | null = null;
        for (const at of occurrences(rule, start, NEW_YORK)) {
          if (at.getTime() > week.getTime() && at.getTime() <= after.getTime())
            latest = at.toISOString();
          if (at.getTime() > after.getTime()) next.push(at.toISOString());
          if (next.length >= 3) break;
        }
        const label = `${rrule} after ${moment}`;
        expect([
          label,
          occurrencesAfter(rule, start, NEW_YORK, after, 3).map((at) => at.toISOString()),
          occurrenceBetween(rule, start, NEW_YORK, week, after)?.toISOString() ?? null,
        ]).toEqual([label, next, latest]);
      }
    }
  });

  test('a daily rule started long ago is as quick to ask as a new one', () => {
    const read = readRecurrence('FREQ=DAILY', '1900-01-01T09:00');
    if (!read.ok) throw new Error(read.problem);
    const { rule, start } = read.value;
    const now = new Date('2026-10-15T12:00:00Z');
    const began = performance.now();
    for (let wake = 0; wake < 10; wake++) {
      occurrenceBetween(rule, start, NEW_YORK, new Date(now.getTime() - 7_200_000), now);
      occurrencesAfter(rule, start, NEW_YORK, now, 6);
    }
    // Reading every day since 1900 took seconds a call.
    expect(performance.now() - began).toBeLessThan(1000);
  });

  test('the occurrence a wake falls on', () => {
    expect(
      occurrenceBetween(
        rule,
        start,
        NEW_YORK,
        new Date('2026-10-30T12:00:00Z'),
        new Date('2026-10-30T13:00:30Z'),
      )?.toISOString(),
    ).toBe('2026-10-30T13:00:00.000Z');
    expect(
      occurrenceBetween(
        rule,
        start,
        NEW_YORK,
        new Date('2026-10-23T12:00:00Z'),
        new Date('2026-10-23T14:00:00Z'),
      ),
    ).toBeNull();
  });
});

describe('reading rules', () => {
  test('refusals say what to change', () => {
    const problem = (text: string, starts = '2026-10-16T09:00') => {
      const read = readRecurrence(text, starts);
      return read.ok ? null : read.problem;
    };
    expect(problem('FREQ=HOURLY')).toContain('use DAILY, WEEKLY, MONTHLY or YEARLY');
    expect(problem('FREQ=WEEKLY;BYDAY=1MO')).toContain('needs FREQ=MONTHLY');
    expect(problem('FREQ=MONTHLY;BYDAY=6MO')).toContain('1 to 5');
    expect(problem('FREQ=WEEKLY;BYMONTHDAY=1')).toContain('FREQ=MONTHLY');
    expect(problem('FREQ=DAILY;COUNT=2;UNTIL=20261231')).toBe('Give COUNT or UNTIL, not both.');
    expect(problem('FREQ=DAILY;BYHOUR=9')).toContain('BYHOUR is not supported');
    expect(problem('FREQ=DAILY;INTERVAL=0')).toContain('INTERVAL');
    expect(problem('BYDAY=MO')).toContain('needs a FREQ');
    expect(problem('DTSTART:20261016T090000\nRRULE:FREQ=DAILY')).toContain('starts');
    expect(problem('FREQ=DAILY', '')).toContain('starts');
    expect(problem('FREQ=DAILY', '2026-02-30T09:00')).toContain('local date and time');
    expect(problem('FREQ=DAILY', '2026-10-16T09:00Z')).toContain('local date and time');
    expect(problem('rrule:freq=weekly;byday=fr')).toBeNull();
  });

  test('a parsed rule keeps its parts', () => {
    const parsed = parseRecurrence('FREQ=MONTHLY;BYDAY=2TU,-1FR;BYMONTH=12,1');
    expect(parsed.ok && parsed.value).toMatchObject({
      freq: 'MONTHLY',
      interval: 1,
      byDay: [
        { weekday: 2, nth: 2 },
        { weekday: 5, nth: -1 },
      ],
      byMonth: [1, 12],
    });
  });
});

describe('in plain words', () => {
  const words = (rrule: string, starts = '2026-10-16T09:00') => {
    const read = readRecurrence(rrule, starts);
    if (!read.ok) throw new Error(read.problem);
    return recurrenceWords(read.value.rule, read.value.start);
  };

  test('the shapes people ask for', () => {
    expect(words('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('Every other Friday at 9:00');
    expect(words('FREQ=WEEKLY;INTERVAL=2')).toBe('Every other Friday at 9:00');
    expect(words('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TH')).toBe(
      'Every 3 weeks on Monday and Thursday at 9:00',
    );
    // Several days every other week is not every other one of those days.
    expect(words('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR')).toBe(
      'Every other week on Monday, Wednesday and Friday at 9:00',
    );
    expect(words('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR')).toBe(
      'Every other week on weekdays at 9:00',
    );
    expect(words('FREQ=WEEKLY;INTERVAL=3;BYDAY=FR')).toBe('Every 3 weeks on Friday at 9:00');
    expect(words('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday at 9:00');
    expect(words('FREQ=DAILY')).toBe('Every day at 9:00');
    expect(words('FREQ=DAILY;INTERVAL=2')).toBe('Every other day at 9:00');
    expect(words('FREQ=DAILY;INTERVAL=3', '2026-10-16T08:30')).toBe('Every 3 days at 8:30');
    expect(words('FREQ=MONTHLY;BYDAY=1MO')).toBe('On the first Monday of every month at 9:00');
    expect(words('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-01T17:00')).toBe(
      'On the last Friday of every month at 17:00',
    );
    expect(words('FREQ=MONTHLY;INTERVAL=2;BYDAY=1SU,-1SU')).toBe(
      'On the first Sunday and last Sunday of every other month at 9:00',
    );
    expect(words('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-10-31T18:00')).toBe(
      'On the last day of every month at 18:00',
    );
    expect(words('FREQ=MONTHLY;BYMONTHDAY=1,15')).toBe(
      'On the 1st and 15th of every month at 9:00',
    );
    expect(words('FREQ=MONTHLY')).toBe('On the 16th of every month at 9:00');
    expect(words('FREQ=MONTHLY;INTERVAL=3')).toBe('On the 16th of every 3 months at 9:00');
    expect(words('FREQ=YEARLY')).toBe('Every year on October 16 at 9:00');
    expect(words('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15')).toBe('Every year on March 15 at 9:00');
    expect(words('FREQ=YEARLY;BYMONTH=11;BYDAY=4TH')).toBe(
      'Every year on the fourth Thursday of November at 9:00',
    );
    expect(words('FREQ=WEEKLY;BYDAY=MO;BYMONTH=6,7,8')).toBe(
      'Every Monday at 9:00 in June, July and August',
    );
    expect(words('FREQ=WEEKLY;BYDAY=FR;COUNT=4')).toBe('Every Friday at 9:00, 4 times');
    expect(words('FREQ=DAILY;UNTIL=20261231T235959Z')).toBe(
      'Every day at 9:00, until December 31, 2026',
    );
  });

  test('a 12-hour clock where the page uses one, and UNTIL on its date in the zone', () => {
    const read = readRecurrence(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;UNTIL=20261231T230000Z',
      '2026-10-16T17:30',
    );
    if (!read.ok) throw new Error(read.problem);
    const { rule, start } = read.value;
    expect(recurrenceWords(rule, start, { clock: '12h', zone: NEW_YORK })).toBe(
      'Every other Friday at 5:30 PM, until December 31, 2026',
    );
    // 23:00 UTC on December 31 is already January 1 in Tokyo.
    expect(recurrenceWords(rule, start, { zone: 'Asia/Tokyo' })).toBe(
      'Every other Friday at 17:30, until January 1, 2027',
    );
    expect(words('FREQ=DAILY', '2026-10-16T00:05')).toBe('Every day at 0:05');
  });

  test('anything else gets a neutral line, never a wrong one', () => {
    for (const rule of [
      'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13',
      'FREQ=YEARLY;BYDAY=20MO',
      'FREQ=DAILY;BYMONTHDAY=1',
      'FREQ=MONTHLY;BYDAY=-3MO',
    ])
      expect(words(rule)).toBe('On a set schedule');
  });
});
