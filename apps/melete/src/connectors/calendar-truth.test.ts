/**
 * Calendar truth against recorded provider answers: free/busy from Google
 * (instances listed with `singleEvents`), Graph (`calendarView`) and a CalDAV
 * collection (expanded here), with repeating busy blocks, time zones across a
 * daylight-saving change, all-day events, and the events that leave time free.
 * Then the checks a write makes: a taken time is refused with what is there
 * named, and inviting someone outside asks, naming them.
 */
import { describe, expect, test } from 'bun:test';
import type { JsonObject } from '@melete/contracts';
import { calendarReasons } from '../experience/projectors.ts';
import { expandIcs } from '../signals/occurrences.ts';
import type { CalendarOccurrences } from '../signals/types.ts';
import { CalendarConnector } from './calendar.ts';
import {
  type BusyBlock,
  calendarAsksFirst,
  checkCalendarAhead,
  clearToWrite,
  conflictsAt,
  freeBusy,
} from './calendar-truth.ts';
import { GoogleCalendarConnector } from './google-calendar.ts';
import { OutlookCalendarConnector } from './outlook-calendar.ts';
import type { SecretAccess } from './secrets.ts';
import type { SignedInAccess } from './signed-in.ts';

const access: SignedInAccess = { token: async () => 'token', renew: async () => 'token' };
const secret: SecretAccess = { withSecret: async (_id, _space, use) => use('password') };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const shape = (blocks: BusyBlock[]) =>
  blocks.map(({ title, start, end, status, all_day }) => ({ title, start, end, status, all_day }));

// --------------------------------------------------------------------------
// Google
// --------------------------------------------------------------------------

const standup = (day: string, id: string) => ({
  id,
  iCalUID: 'std@google.com',
  recurringEventId: 'std',
  status: 'confirmed',
  summary: 'Standup',
  start: { dateTime: `2026-10-${day}T09:00:00-07:00`, timeZone: 'America/Los_Angeles' },
  end: { dateTime: `2026-10-${day}T09:30:00-07:00`, timeZone: 'America/Los_Angeles' },
  originalStartTime: { dateTime: `2026-10-${day}T09:00:00-07:00` },
});
const googleItems = [
  standup('05', 'std_1'),
  standup('06', 'std_2'),
  standup('07', 'std_3'),
  {
    id: 'off',
    iCalUID: 'off@google.com',
    status: 'confirmed',
    summary: 'Offsite',
    start: { date: '2026-10-06' },
    end: { date: '2026-10-07' },
  },
  {
    id: 'lunch',
    status: 'confirmed',
    summary: 'Lunch reminder',
    transparency: 'transparent',
    start: { dateTime: '2026-10-05T12:00:00Z' },
    end: { dateTime: '2026-10-05T13:00:00Z' },
  },
  {
    id: 'pitch',
    status: 'confirmed',
    summary: 'Vendor pitch',
    start: { dateTime: '2026-10-05T18:00:00Z' },
    end: { dateTime: '2026-10-05T19:00:00Z' },
    attendees: [
      { email: 'me@example.test', self: true, responseStatus: 'declined' },
      { email: 'vendor@example.test', organizer: true, responseStatus: 'accepted' },
    ],
  },
  {
    id: 'old',
    status: 'cancelled',
    summary: 'Old sync',
    start: { dateTime: '2026-10-05T20:00:00Z' },
    end: { dateTime: '2026-10-05T21:00:00Z' },
  },
  {
    id: 'dinner',
    status: 'tentative',
    summary: 'Maybe dinner',
    start: { dateTime: '2026-10-07T19:00:00-04:00' },
    end: { dateTime: '2026-10-07T21:00:00-04:00' },
  },
];

function google(items: unknown[] = googleItems) {
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    if (url.pathname.endsWith('/events') && url.searchParams.get('singleEvents') === 'true')
      return json({ items });
    return json({ error: { code: 404 } }, 404);
  }) as typeof fetch;
  return new GoogleCalendarConnector({
    id: 'con_g',
    spaceId: 'spc_test',
    base: 'https://www.googleapis.com/calendar/v3/calendars/primary',
    access,
    fetcher,
  });
}

// --------------------------------------------------------------------------
// Microsoft Graph
// --------------------------------------------------------------------------

const graphItems = [
  {
    id: 'g1',
    type: 'occurrence',
    seriesMasterId: 'M1',
    originalStart: '2026-10-05T17:00:00Z',
    subject: 'One to one',
    start: { dateTime: '2026-10-05T17:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T17:30:00.0000000', timeZone: 'UTC' },
    showAs: 'busy',
  },
  {
    id: 'g2',
    type: 'occurrence',
    seriesMasterId: 'M1',
    originalStart: '2026-10-06T17:00:00Z',
    subject: 'One to one',
    start: { dateTime: '2026-10-06T17:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-06T17:30:00.0000000', timeZone: 'UTC' },
    showAs: 'busy',
  },
  {
    id: 'g3',
    type: 'singleInstance',
    subject: 'Focus',
    start: { dateTime: '2026-10-05T15:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T16:00:00.0000000', timeZone: 'UTC' },
    showAs: 'free',
  },
  {
    id: 'g4',
    type: 'singleInstance',
    subject: 'Dentist',
    start: { dateTime: '2026-10-05T20:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T21:00:00.0000000', timeZone: 'UTC' },
    showAs: 'tentative',
  },
  {
    id: 'g5',
    type: 'singleInstance',
    subject: 'Board review',
    start: { dateTime: '2026-10-05T22:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T23:00:00.0000000', timeZone: 'UTC' },
    showAs: 'busy',
    responseStatus: { response: 'declined' },
  },
  {
    id: 'g6',
    type: 'singleInstance',
    subject: 'Conference',
    isAllDay: true,
    start: { dateTime: '2026-10-06T00:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-07T00:00:00.0000000', timeZone: 'UTC' },
    showAs: 'oof',
  },
  {
    id: 'g7',
    type: 'singleInstance',
    subject: 'From home',
    isAllDay: true,
    start: { dateTime: '2026-10-05T00:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-06T00:00:00.0000000', timeZone: 'UTC' },
    showAs: 'workingElsewhere',
  },
  {
    id: 'g8',
    type: 'singleInstance',
    subject: 'Called off',
    isCancelled: true,
    start: { dateTime: '2026-10-05T18:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-05T19:00:00.0000000', timeZone: 'UTC' },
    showAs: 'busy',
  },
];

function graph(items: unknown[] = graphItems) {
  const asked: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    asked.push(url);
    if (url.pathname.endsWith('/calendarView')) return json({ value: items });
    return json({ error: { code: 'ErrorItemNotFound' } }, 404);
  }) as typeof fetch;
  const connector = new OutlookCalendarConnector({
    id: 'con_o',
    spaceId: 'spc_test',
    base: 'https://graph.microsoft.com/v1.0/me',
    access,
    fetcher,
  });
  return { connector, asked };
}

// --------------------------------------------------------------------------
// CalDAV
// --------------------------------------------------------------------------

const vevent = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const caldavIcs = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  ...vevent([
    'UID:team-sync',
    'DTSTART;TZID=America/New_York:20261026T090000',
    'DTEND;TZID=America/New_York:20261026T093000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'SUMMARY:Team sync',
  ]),
  ...vevent([
    'UID:holiday',
    'DTSTART;VALUE=DATE:20261102',
    'DTEND;VALUE=DATE:20261103',
    'SUMMARY:Holiday',
  ]),
  ...vevent([
    'UID:gym',
    'DTSTART:20261027T120000Z',
    'DTEND:20261027T130000Z',
    'TRANSP:TRANSPARENT',
    'SUMMARY:Gym',
  ]),
  ...vevent([
    'UID:pitch',
    'DTSTART:20261027T150000Z',
    'DTEND:20261027T160000Z',
    'SUMMARY:Pitch',
    'ORGANIZER:mailto:vendor@example.test',
    'ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.test',
  ]),
  ...vevent([
    'UID:hold',
    'DTSTART:20261028T150000Z',
    'DTEND:20261028T160000Z',
    'STATUS:TENTATIVE',
    'SUMMARY:Hold: call',
  ]),
  ...vevent([
    'UID:old',
    'DTSTART:20261029T150000Z',
    'DTEND:20261029T160000Z',
    'STATUS:CANCELLED',
    'SUMMARY:Old',
  ]),
  'END:VCALENDAR',
  '',
].join('\r\n');

function caldav(ics = caldavIcs) {
  const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== 'REPORT') return new Response(null, { status: 405 });
    return new Response(
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/c/all.ics</d:href><d:propstat><d:prop><d:getetag>"1"</d:getetag><c:calendar-data><![CDATA[${ics}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`,
      { status: 207 },
    );
  }) as typeof fetch;
  return new CalendarConnector(
    {
      id: 'con_c',
      spaceId: 'spc_test',
      mode: 'caldav',
      calendarUrl: 'https://dav.example.test/c/',
      username: 'me@example.test',
      secretRef: 'sec',
    },
    secret,
    fetcher,
  );
}

const sourceOf = (connector: { signals?: unknown }) => connector.signals as CalendarOccurrences;

describe('free/busy from each provider', () => {
  test('Google: repeating instances, an all-day day in the person’s zone, and what leaves time free', async () => {
    const window = { from: '2026-10-05T04:00:00.000Z', to: '2026-10-08T04:00:00.000Z' };
    const found = await freeBusy(sourceOf(google()), window, 'America/New_York');
    expect(found.complete).toBe(true);
    expect(shape(found.busy)).toEqual([
      {
        title: 'Standup',
        start: '2026-10-05T16:00:00.000Z',
        end: '2026-10-05T16:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      // The all-day event fills the person's own day, midnight to midnight in New York.
      {
        title: 'Offsite',
        start: '2026-10-06T04:00:00.000Z',
        end: '2026-10-07T04:00:00.000Z',
        status: 'busy',
        all_day: true,
      },
      {
        title: 'Standup',
        start: '2026-10-06T16:00:00.000Z',
        end: '2026-10-06T16:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      {
        title: 'Standup',
        start: '2026-10-07T16:00:00.000Z',
        end: '2026-10-07T16:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      {
        title: 'Maybe dinner',
        start: '2026-10-07T23:00:00.000Z',
        end: '2026-10-08T01:00:00.000Z',
        status: 'tentative',
        all_day: false,
      },
    ]);
    // Shown as free, declined and cancelled leave their time open.
    expect(found.free).toEqual([
      { start: '2026-10-05T04:00:00.000Z', end: '2026-10-05T16:00:00.000Z' },
      { start: '2026-10-05T16:30:00.000Z', end: '2026-10-06T04:00:00.000Z' },
      { start: '2026-10-07T04:00:00.000Z', end: '2026-10-07T16:00:00.000Z' },
      { start: '2026-10-07T16:30:00.000Z', end: '2026-10-07T23:00:00.000Z' },
      { start: '2026-10-08T01:00:00.000Z', end: '2026-10-08T04:00:00.000Z' },
    ]);
  });

  test('Graph: a series’ instances, tentative and away count; free, working elsewhere and declined do not', async () => {
    const { connector, asked } = graph();
    const window = { from: '2026-10-05T07:00:00.000Z', to: '2026-10-07T07:00:00.000Z' };
    const found = await freeBusy(sourceOf(connector), window, 'America/Los_Angeles');
    expect(shape(found.busy)).toEqual([
      {
        title: 'One to one',
        start: '2026-10-05T17:00:00.000Z',
        end: '2026-10-05T17:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      {
        title: 'Dentist',
        start: '2026-10-05T20:00:00.000Z',
        end: '2026-10-05T21:00:00.000Z',
        status: 'tentative',
        all_day: false,
      },
      // Away all day on the 6th, in Los Angeles.
      {
        title: 'Conference',
        start: '2026-10-06T07:00:00.000Z',
        end: '2026-10-07T07:00:00.000Z',
        status: 'busy',
        all_day: true,
      },
      {
        title: 'One to one',
        start: '2026-10-06T17:00:00.000Z',
        end: '2026-10-06T17:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
    ]);
    // The account's own answer is asked for, so a declined invitation is known.
    expect(asked[0]?.searchParams.get('$select')).toContain('responseStatus');
  });

  test('CalDAV: a weekly meeting keeps 9:00 in New York across the clock change, a holiday fills its day', async () => {
    const window = { from: '2026-10-26T04:00:00.000Z', to: '2026-11-10T05:00:00.000Z' };
    const found = await freeBusy(sourceOf(caldav()), window, 'America/New_York');
    expect(shape(found.busy)).toEqual([
      {
        title: 'Team sync',
        start: '2026-10-26T13:00:00.000Z',
        end: '2026-10-26T13:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      {
        title: 'Hold: call',
        start: '2026-10-28T15:00:00.000Z',
        end: '2026-10-28T16:00:00.000Z',
        status: 'tentative',
        all_day: false,
      },
      {
        title: 'Holiday',
        start: '2026-11-02T05:00:00.000Z',
        end: '2026-11-03T05:00:00.000Z',
        status: 'busy',
        all_day: true,
      },
      {
        title: 'Team sync',
        start: '2026-11-02T14:00:00.000Z',
        end: '2026-11-02T14:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
      {
        title: 'Team sync',
        start: '2026-11-09T14:00:00.000Z',
        end: '2026-11-09T14:30:00.000Z',
        status: 'busy',
        all_day: false,
      },
    ]);
  });

  test('the free/busy tool answers with the window, the zone and the busy blocks', async () => {
    const connector = caldav();
    const result = await connector.execute(
      {
        id: 'act_fb',
        job_id: 'job_test',
        connection_id: 'con_c',
        kind: 'calendar.freebusy',
        canonical_payload: {
          start: '2026-11-02',
          end: '2026-11-03',
          time_zone: 'America/New_York',
        },
        idempotency_key: 'act_fb',
      } as never,
      {
        job_id: 'job_test',
        space_id: 'spc_test',
        idempotency_key: 'act_fb',
        constraints: {} as never,
      },
    );
    if (result.outcome !== 'succeeded') throw new Error(result.outcome);
    expect(result.receipt.detail).toMatchObject({
      time_zone: 'America/New_York',
      complete: true,
      window: { from: '2026-11-02T00:00:00.000Z', to: '2026-11-03T00:00:00.000Z' },
    });
    expect((result.receipt.detail.busy as { title: string }[]).map((block) => block.title)).toEqual(
      ['Holiday', 'Team sync'],
    );
  });
});

describe('a write over busy time', () => {
  const write = (start: string, end: string, extra: JsonObject = {}) =>
    ({
      summary: 'New',
      start,
      end,
      description: '',
      location: '',
      checked: { names: true },
      ...extra,
    }) as JsonObject & {
      start: string;
      end: string;
    };

  test('a create over a busy slot is refused with the conflict named', async () => {
    for (const [source, start, end, named] of [
      [sourceOf(caldav()), '2026-11-02T14:15:00Z', '2026-11-02T14:45:00Z', '“Team sync”'],
      [sourceOf(google()), '2026-10-06T16:15:00Z', '2026-10-06T17:00:00Z', '“Standup”'],
      [sourceOf(graph().connector), '2026-10-05T20:30:00Z', '2026-10-05T21:30:00Z', '“Dentist”'],
    ] as const) {
      const refused = await clearToWrite(source, write(start, end));
      expect(refused).toMatchObject({ outcome: 'failed', retryable: false });
      expect(refused && 'reason' in refused ? refused.reason : '').toContain(named);
    }
  });

  test('the conflict is named in the person’s own zone, and an all-day one by its day', async () => {
    const refused = await clearToWrite(
      sourceOf(caldav()),
      write('2026-11-02T14:15:00Z', '2026-11-02T14:45:00Z', {
        checked: {
          time_zone: 'America/New_York',
          outside: [],
          conflicts: [],
          read: true,
          names: true,
        },
      }),
    );
    const reason = refused && 'reason' in refused ? refused.reason : '';
    expect(reason).toContain('“Holiday” (all day, Mon, Nov 2)');
    expect(reason).toContain('“Team sync” (Mon, Nov 2, 9:00 AM–9:30 AM EST)');
  });

  test('touching is not overlapping, and an event never conflicts with itself', async () => {
    const source = sourceOf(caldav());
    expect(
      await clearToWrite(source, write('2026-11-09T14:30:00Z', '2026-11-09T15:00:00Z')),
    ).toBeNull();
    // Moving one Team sync is checked against everything but that series.
    expect(
      await clearToWrite(
        source,
        write('2026-11-09T14:00:00Z', '2026-11-09T14:30:00Z'),
        (occurrence) => occurrence.uid === 'team-sync',
      ),
    ).toBeNull();
    // Time shown as free or declined can be booked.
    expect(
      await clearToWrite(source, write('2026-10-27T12:00:00Z', '2026-10-27T16:00:00Z')),
    ).toBeNull();
  });

  test('a double-booking goes over what the person agreed to, and nothing else', async () => {
    const source = sourceOf(caldav());
    const slot = { start: '2026-11-09T14:00:00Z', end: '2026-11-09T15:00:00Z' };
    const { conflicts } = await conflictsAt(source, slot, { zone: 'America/New_York' });
    expect(conflicts.map((block) => block.title)).toEqual(['Team sync']);
    const agreed = write(slot.start, slot.end, {
      double_book: { reason: 'The person asked to sit in on both' },
      checked: {
        time_zone: 'America/New_York',
        outside: [],
        conflicts,
        read: true,
        names: true,
      } as never,
    });
    expect(await clearToWrite(source, agreed)).toBeNull();
    // The same agreement does not cover a time it never named.
    const wider = { ...agreed, end: '2026-11-09T16:30:00Z' };
    const moved = await clearToWrite(
      sourceOf(
        caldav(
          caldavIcs.replace(
            'END:VCALENDAR',
            [
              ...vevent([
                'UID:late',
                'DTSTART:20261109T160000Z',
                'DTEND:20261109T170000Z',
                'SUMMARY:Late call',
              ]),
              'END:VCALENDAR',
            ].join('\r\n'),
          ),
        ),
      ),
      wider,
    );
    expect(moved && 'reason' in moved ? moved.reason : '').toContain('“Late call”');
    expect(moved && 'reason' in moved ? moved.reason : '').not.toContain('Team sync');
  });

  test('a calendar that cannot be read stops the write', async () => {
    const broken: CalendarOccurrences = {
      occurrences: async () => {
        throw new Error('down');
      },
    };
    expect(
      await clearToWrite(broken, write('2026-11-09T10:00:00Z', '2026-11-09T11:00:00Z')),
    ).toMatchObject({
      outcome: 'failed',
      retryable: true,
    });
    const partial: CalendarOccurrences = {
      occurrences: async () => ({ items: [], complete: false }),
    };
    expect(
      await clearToWrite(partial, write('2026-11-09T10:00:00Z', '2026-11-09T11:00:00Z')),
    ).toMatchObject({
      outcome: 'failed',
    });
  });
});

describe('who an event invites', () => {
  const action = (payload: JsonObject) => ({ kind: 'calendar.create', canonical_payload: payload });

  test('inviting someone outside asks, naming them', () => {
    const payload = {
      summary: 'Intro',
      start: '2026-11-09T10:00:00Z',
      end: '2026-11-09T11:00:00Z',
      attendees: ['priya@partner.example', 'me@work.example'],
      checked: { time_zone: 'UTC', outside: ['priya@partner.example'], conflicts: [], read: true },
    };
    expect(calendarAsksFirst(action(payload))).toBe(true);
    const reasons = calendarReasons('calendar.create', payload);
    expect(reasons.join(' ')).toContain('priya@partner.example');
    expect(reasons.join(' ')).not.toContain('me@work.example');
  });

  test('inviting no one, or only the person’s own accounts, stays the person’s own', () => {
    const base = { summary: 'Focus', start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' };
    expect(calendarAsksFirst(action(base))).toBe(false);
    expect(
      calendarAsksFirst(
        action({
          ...base,
          attendees: ['me@work.example'],
          checked: { time_zone: 'UTC', outside: [], conflicts: [], read: true, names: true },
        }),
      ),
    ).toBe(false);
    // Guests with no check bound count as outside.
    expect(calendarAsksFirst(action({ ...base, attendees: ['me@work.example'] }))).toBe(true);
  });

  test('asking to double-book always asks, with the reason on the card', () => {
    const payload = {
      summary: 'Both',
      start: '2026-11-09T10:00:00Z',
      end: '2026-11-09T11:00:00Z',
      double_book: { reason: 'The person wants to drop in on both' },
      checked: {
        time_zone: 'UTC',
        outside: [],
        conflicts: [
          { title: 'Team sync', ref: 'x', start: '', end: '', status: 'busy', all_day: false },
        ],
        read: true,
        names: true,
      },
    };
    expect(calendarAsksFirst(action(payload))).toBe(true);
    expect(calendarReasons('calendar.create', payload).join(' ')).toContain(
      'It goes on top of Team sync. The reason given: The person wants to drop in on both',
    );
  });
});

describe('what a refusal and a read may tell', () => {
  const slot = { start: '2026-11-02T14:15:00Z', end: '2026-11-02T14:45:00Z' };
  const busySlot = (checked: JsonObject) =>
    ({
      summary: 'New',
      ...slot,
      description: '',
      location: '',
      checked,
    }) as JsonObject & { start: string; end: string };

  test('a job that may not read the calendar is told the time is taken, never by what', async () => {
    const refused = await clearToWrite(
      sourceOf(caldav()),
      busySlot({ time_zone: 'America/New_York', names: false }),
    );
    const reason = refused && 'reason' in refused ? refused.reason : '';
    expect(reason).toStartWith('That time is already taken, so nothing was put on the calendar.');
    expect(reason).not.toContain('Team sync');
    expect(reason).not.toContain('Holiday');
    expect(reason).not.toContain('9:00');
    expect(reason).not.toContain('calendar.freebusy');
    // The same refusal before anyone is asked.
    const { conflicts } = await conflictsAt(sourceOf(caldav()), slot, { zone: 'UTC' });
    const ahead = { conflicts: conflicts as never, complete: true };
    expect(() =>
      checkCalendarAhead(
        { kind: 'calendar.create', canonical_payload: busySlot({ names: false }) },
        { ahead, granted: ['calendar.create'] },
      ),
    ).toThrow(/^That time is already taken, so nothing/);
    expect(() =>
      checkCalendarAhead(
        { kind: 'calendar.create', canonical_payload: busySlot({ names: true }) },
        { ahead, granted: ['calendar.create', 'calendar.freebusy'] },
      ),
    ).toThrow(/“Team sync”.*calendar\.freebusy/);
  });

  test('a time written with no zone is the person’s own wall clock', async () => {
    const floating = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...vevent([
        'UID:float',
        'DTSTART:20261109T100000',
        'DTEND:20261109T110000',
        'SUMMARY:Standup',
      ]),
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const source: CalendarOccurrences = {
      occurrences: (window, options) =>
        expandIcs([floating], window, undefined, [], options?.zone ?? null),
    };
    const ny = 'America/New_York';
    // 10:00 in New York is 15:00Z; 05:00 in New York is 10:00Z.
    const atTen = await conflictsAt(
      source,
      { start: '2026-11-09T15:00:00Z', end: '2026-11-09T16:00:00Z' },
      { zone: ny },
    );
    const atFive = await conflictsAt(
      source,
      { start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' },
      { zone: ny },
    );
    expect(atTen.conflicts.map((block) => block.title)).toEqual(['Standup']);
    expect(atFive.conflicts).toEqual([]);
  });

  test('an invitation the person declined frees the time even when the account name is not their address', async () => {
    const declined = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      ...vevent([
        'UID:pitch',
        'DTSTART:20261110T150000Z',
        'DTEND:20261110T160000Z',
        'SUMMARY:Pitch',
        'ORGANIZER:mailto:vendor@example.test',
        'ATTENDEE;PARTSTAT=DECLINED:mailto:me@work.example',
      ]),
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const window = { from: '2026-11-10T00:00:00.000Z', to: '2026-11-11T00:00:00.000Z' };
    // A feed, read through the feed's own reader, with the person's addresses bound.
    const { IcsFeedConnector } = await import('./ics-feed.ts');
    const feed = new IcsFeedConnector(
      { id: 'con_f', spaceId: 'spc_test', secretRef: 'sec', allowInsecureLocalForTests: true },
      { withSecret: async (_id, _space, use) => use('https://feed.example.test/me.ics') },
      {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport: (async () => ({ status: 200, body: declined })) as never,
      },
    );
    const unknown = await freeBusy(sourceOf(feed), window, 'UTC');
    expect(unknown.busy.map((block) => block.title)).toEqual(['Pitch']);
    const known = await freeBusy(sourceOf(feed), window, 'UTC', { self: ['me@work.example'] });
    expect(known.busy).toEqual([]);
  });

  test('a CalDAV account whose name is not an address cannot send invitations', async () => {
    const connector = new CalendarConnector(
      {
        id: 'con_c',
        spaceId: 'spc_test',
        mode: 'caldav',
        calendarUrl: 'https://dav.example.test/c/',
        username: 'owner',
        secretRef: 'sec',
      },
      secret,
    );
    await expect(
      connector.prepare(
        {
          summary: 'Intro',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
          attendees: ['priya@partner.example'],
        },
        { job_id: 'job', space_id: 'spc_test', idempotency_key: '', constraints: {} as never },
        {} as never,
        'calendar.create',
      ),
    ).rejects.toThrow('cannot send invitations');
  });

  test('the card says when the calendar could not be checked before asking', () => {
    const base = { summary: 'Focus', start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' };
    expect(
      calendarReasons('calendar.create', { ...base, checked: { read: false } }).join(' '),
    ).toContain('could not check your calendar');
    expect(calendarReasons('calendar.create', { ...base, checked: { read: true } })).toEqual([]);
  });
});
