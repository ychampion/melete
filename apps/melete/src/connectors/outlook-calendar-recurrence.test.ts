import { describe, expect, test } from 'bun:test';
import { mailAction, mailContext } from './mail-fixtures.ts';
import { OutlookCalendarConnector } from './outlook-calendar.ts';

const base = 'https://graph.example/v1.0/me';
const occurrence = (
  id: string,
  start: string,
  end: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  type: 'occurrence',
  seriesMasterId: 'series',
  subject: 'Planning',
  start: { dateTime: start, timeZone: 'UTC' },
  end: { dateTime: end, timeZone: 'UTC' },
  ...extra,
});

function calendar(
  items: unknown[],
  master: unknown,
  now = '2026-10-28T12:00:00Z',
  paging: { next?: string; later?: unknown[] } = {},
) {
  const asked: URL[] = [];
  const connector = new OutlookCalendarConnector({
    id: 'con_test',
    spaceId: 'spc_test',
    base,
    access: { token: async () => 'local-test-token', renew: async () => 'local-test-token' },
    now: () => Date.parse(now),
    fetcher: (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      );
      asked.push(url);
      if (url.pathname.endsWith('/calendarView'))
        return Response.json(
          url.searchParams.has('$skip')
            ? { value: paging.later ?? [] }
            : { value: items, ...(paging.next ? { '@odata.nextLink': paging.next } : {}) },
        );
      if (url.pathname.endsWith('/events/series'))
        return master ? Response.json(master) : new Response(null, { status: 404 });
      return Response.json({ value: master ? [master] : [] });
    }) as typeof fetch,
  });
  const list = async (payload: Record<string, unknown> = {}) => {
    const result = await connector.execute(mailAction('calendar.list', payload), mailContext());
    if (result.outcome !== 'succeeded') throw new Error(result.outcome);
    return result.receipt.detail as {
      events: Record<string, unknown>[];
      truncated: boolean;
      recurrence_complete?: boolean;
      note?: string;
    };
  };
  return { asked, list };
}

const weeklyMaster = {
  id: 'series',
  type: 'seriesMaster',
  subject: 'Planning',
  start: { dateTime: '2026-09-08T16:00:00', timeZone: 'UTC' },
  end: { dateTime: '2026-09-08T17:00:00', timeZone: 'UTC' },
  recurrence: {
    pattern: { type: 'weekly', interval: 1, daysOfWeek: ['tuesday'], firstDayOfWeek: 'monday' },
    range: { type: 'noEnd', startDate: '2026-09-08' },
  },
};

describe('Outlook recurring listings', () => {
  test('the series zone keeps its wall-clock rule when the person uses another zone', async () => {
    const { list } = calendar([occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00')], {
      ...weeklyMaster,
      originalStartTimeZone: 'America/Los_Angeles',
    });
    expect((await list({ time_zone: 'UTC' })).events[0]).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'Every Tuesday at 9:00',
    });
  });

  test('a Windows series zone never invents a fixed UTC recurrence time across DST', async () => {
    const { list } = calendar([occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00')], {
      ...weeklyMaster,
      originalStartTimeZone: 'Pacific Standard Time',
    });
    expect((await list({ time_zone: 'UTC' })).events[0]).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'Every Tuesday',
    });
  });

  test('an old series lists its next instance and reads its rule once across the DST change', async () => {
    const { asked, list } = calendar(
      [
        occurrence('second', '2026-11-10T17:00:00', '2026-11-10T18:00:00'),
        occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00'),
        occurrence('past', '2026-10-27T16:00:00', '2026-10-27T17:00:00'),
      ],
      weeklyMaster,
    );
    const result = await list({ time_zone: 'America/Los_Angeles' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      uid: 'series',
      start: '2026-11-03T17:00:00.000Z',
      end: '2026-11-03T18:00:00.000Z',
      series_start: '2026-09-08T16:00:00.000Z',
      recurrence_status: 'active',
      recurrence_summary: 'Every Tuesday at 9:00',
    });
    expect(asked.filter((url) => url.pathname.endsWith('/events/series'))).toHaveLength(1);
    const view = asked.find((url) => url.pathname.endsWith('/calendarView'));
    expect(view?.searchParams.get('startDateTime')).toBe('2026-10-27T12:00:00.000Z');
    expect(view?.searchParams.get('endDateTime')).toBe('2027-01-25T12:00:00.000Z');
    expect(asked.some((url) => url.pathname.endsWith('/events'))).toBe(false);
  });

  test('a historical window still lists its occurrence rather than the original series start', async () => {
    const { list } = calendar(
      [occurrence('historical', '2026-10-06T16:00:00', '2026-10-06T17:00:00')],
      weeklyMaster,
    );
    const result = await list({
      from: '2026-10-01',
      to: '2026-10-08',
      time_zone: 'America/Los_Angeles',
    });
    expect(result.events[0]?.start).toBe('2026-10-06T16:00:00.000Z');
  });

  test('an all-day series keeps today’s date and has no invented clock time', async () => {
    const master = {
      ...weeklyMaster,
      isAllDay: true,
      start: { dateTime: '2026-09-01T00:00:00', timeZone: 'UTC' },
      recurrence: {
        pattern: { type: 'daily', interval: 1 },
        range: { type: 'noEnd', startDate: '2026-09-01' },
      },
    };
    const { list } = calendar(
      [
        occurrence('today', '2026-11-01T00:00:00', '2026-11-02T00:00:00', { isAllDay: true }),
        occurrence('tomorrow', '2026-11-02T00:00:00', '2026-11-03T00:00:00', { isAllDay: true }),
      ],
      master,
      '2026-11-01T20:00:00Z',
    );
    expect((await list({ time_zone: 'America/Los_Angeles' })).events[0]).toMatchObject({
      start: '2026-11-01',
      end: '2026-11-02',
      recurrence_summary: 'Every day',
      recurrence_status: 'active',
    });
  });

  test('an inaccessible master preserves the occurrence with an honest incomplete summary', async () => {
    const { list } = calendar(
      [occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00')],
      null,
    );
    const result = await list();
    expect(result.events[0]).toMatchObject({
      start: '2026-11-03T17:00:00.000Z',
      recurrence_summary: 'On a set schedule',
      recurrence_status: 'active',
    });
    expect(result.recurrence_complete).toBe(false);
    expect(result.note).toContain('could not be read');
  });

  test('pagination finds the next distinct event and omits cancelled occurrences', async () => {
    const { asked, list } = calendar(
      [
        occurrence('cancelled', '2026-10-29T17:00:00', '2026-10-29T18:00:00', {
          isCancelled: true,
        }),
        occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00'),
      ],
      weeklyMaster,
      '2026-10-28T12:00:00Z',
      {
        next: `${base}/calendarView?$skip=100`,
        later: [
          occurrence('single', '2026-11-04T17:00:00', '2026-11-04T18:00:00', {
            type: 'singleInstance',
            seriesMasterId: undefined,
          }),
        ],
      },
    );
    const result = await list({ limit: 2 });
    expect(result.events.map((event) => event.uid)).toEqual(['series', 'single']);
    expect(result.truncated).toBe(false);
    expect(asked.filter((url) => url.pathname.endsWith('/calendarView'))).toHaveLength(2);
  });

  test('a pagination link outside this Graph account is not followed and marks the list incomplete', async () => {
    const { asked, list } = calendar(
      [occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00')],
      weeklyMaster,
      '2026-10-28T12:00:00Z',
      { next: 'https://elsewhere.example/events' },
    );
    const result = await list();
    expect(result.truncated).toBe(true);
    expect(asked.every((url) => url.href.startsWith(`${base}/`))).toBe(true);
    expect(asked.filter((url) => url.pathname.endsWith('/calendarView'))).toHaveLength(1);
  });

  test.each([
    [
      { type: 'daily', interval: 3 },
      { type: 'numbered', numberOfOccurrences: 10 },
      'Every 3 days at 9:00, 10 times',
    ],
    [
      { type: 'relativeMonthly', interval: 1, daysOfWeek: ['tuesday'], index: 'second' },
      { type: 'noEnd' },
      'On the second Tuesday of every month at 9:00',
    ],
    [
      { type: 'relativeYearly', interval: 2, daysOfWeek: ['tuesday'], index: 'second', month: 11 },
      { type: 'noEnd' },
      'Every other year on the second Tuesday of November at 9:00',
    ],
    [
      { type: 'absoluteMonthly', interval: 2, dayOfMonth: 15 },
      { type: 'endDate', endDate: '2027-01-31' },
      'On the 15th of every other month at 9:00, until January 31, 2027',
    ],
  ])(
    'Graph recurrence %j is summarized with the existing rule utility',
    async (pattern, range, summary) => {
      const { list } = calendar(
        [occurrence('first', '2026-11-03T17:00:00', '2026-11-03T18:00:00')],
        { ...weeklyMaster, recurrence: { pattern, range } },
      );
      expect((await list({ time_zone: 'America/Los_Angeles' })).events[0]?.recurrence_summary).toBe(
        summary,
      );
    },
  );
});
