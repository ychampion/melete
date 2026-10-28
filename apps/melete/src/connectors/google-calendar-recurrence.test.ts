import { describe, expect, test } from 'bun:test';
import { GoogleCalendarConnector } from './google-calendar.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';

async function list(recurrence: string[], now = '2026-10-28T12:00:00Z') {
  const connector = new GoogleCalendarConnector({
    id: 'con_test',
    spaceId: 'spc_test',
    base: 'https://calendar.example.test',
    access: { token: async () => 'fixture', renew: async () => 'fixture' },
    now: () => Date.parse(now),
    fetcher: (async (_input: string | URL | Request) =>
      Response.json({
        items: [
          {
            id: 'series',
            iCalUID: 'series@example.test',
            summary: 'Planning',
            start: { dateTime: '2026-09-08T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
            end: { dateTime: '2026-09-08T10:00:00-07:00', timeZone: 'America/Los_Angeles' },
            recurrence,
          },
        ],
      })) as typeof fetch,
  });
  return connector.execute(mailAction('calendar.list'), mailContext());
}

describe('Google Calendar series dates', () => {
  test('a master is projected across DST and EXDATE before it reaches the agent', async () => {
    expect(
      await list(['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261103T090000']),
    ).toMatchObject({
      outcome: 'succeeded',
      receipt: {
        detail: {
          events: [
            {
              start: '2026-11-10T17:00:00.000Z',
              end: '2026-11-10T18:00:00.000Z',
              recurrence_summary: 'Every Tuesday at 9:00',
              recurrence_status: 'active',
            },
          ],
        },
      },
    });
  });

  test('an exhausted series says ended rather than returning its original start', async () => {
    expect(await list(['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3'])).toMatchObject({
      outcome: 'succeeded',
      receipt: {
        detail: {
          events: [
            {
              start: '',
              end: '',
              recurrence_status: 'ended',
            },
          ],
        },
      },
    });
  });
});
