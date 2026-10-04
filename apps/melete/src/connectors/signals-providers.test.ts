/**
 * Each provider's change feed, read against recorded answers: Google Calendar
 * with `singleEvents`, Graph's `calendarView`, Gmail's history, Graph's mail
 * delta and an IMAP inbox by UID, including a server that renumbered it.
 */
import { describe, expect, test } from 'bun:test';
import { SourceError } from '../signals/types.ts';
import { CalendarConnector } from './calendar.ts';
import { EmailConnector, withheldFromSignals } from './email.ts';
import { GmailApiTransport } from './gmail.ts';
import { GoogleCalendarConnector, googleOccurrence } from './google-calendar.ts';
import { type ImapInbox, imapChanges, type MailMessage } from './mail-transport.ts';
import { graphOccurrence, OutlookCalendarConnector } from './outlook-calendar.ts';
import { OutlookMailTransport } from './outlook-mail.ts';
import type { SecretAccess } from './secrets.ts';
import type { SignedInAccess } from './signed-in.ts';

const access: SignedInAccess = { token: async () => 'token', renew: async () => 'token' };
const WINDOW = { from: '2026-10-05T12:00:00.000Z', to: '2026-10-19T12:00:00.000Z' };

type Route = (url: URL) => { status?: number; body?: unknown } | undefined;

/** A fetcher answering from routes, recording every address it was asked for. */
function provider(route: Route) {
  const asked: URL[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input : input.url,
    );
    asked.push(url);
    const answer = route(url) ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe('Google Calendar occurrences', () => {
  const page1 = {
    items: [
      {
        id: 'abc_20261006T160000Z',
        iCalUID: 'abc@google.com',
        recurringEventId: 'abc',
        status: 'confirmed',
        summary: 'Standup',
        location: 'Room 1',
        start: { dateTime: '2026-10-06T09:00:00-07:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-10-06T09:15:00-07:00', timeZone: 'America/Los_Angeles' },
        originalStartTime: { dateTime: '2026-10-06T09:00:00-07:00' },
        attendees: [{ email: 'me@example.test', self: true }, { email: 'a@example.test' }],
        updated: '2026-10-01T10:00:00.000Z',
      },
      {
        // A cancelled instance carries only its identity.
        id: 'abc_20261007T160000Z',
        recurringEventId: 'abc',
        iCalUID: 'abc@google.com',
        status: 'cancelled',
        originalStartTime: { dateTime: '2026-10-07T09:00:00-07:00' },
      },
    ],
    nextPageToken: 'p2',
  };
  const page2 = {
    items: [
      {
        id: 'offsite',
        iCalUID: 'offsite@google.com',
        status: 'tentative',
        summary: 'Offsite',
        start: { date: '2026-10-09' },
        end: { date: '2026-10-10' },
      },
    ],
  };

  test('instances of a series carry the series and their original start; a cancelled one is placed at it', async () => {
    const google = provider((url) =>
      url.pathname.endsWith('/events')
        ? { body: url.searchParams.get('pageToken') === 'p2' ? page2 : page1 }
        : undefined,
    );
    const connector = new GoogleCalendarConnector({
      id: 'conn_google0001',
      spaceId: 'sp_test0001',
      base: 'https://calendar.example/calendar/v3/calendars/primary',
      access,
      fetcher: google.fetcher,
    });
    if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    const read = await connector.signals.occurrences(WINDOW);
    expect(read.complete).toBe(true);
    expect(
      read.items.map((item) => [item.uid, item.occurrence, item.start, item.status, item.all_day]),
    ).toEqual([
      [
        'abc@google.com',
        '2026-10-06T16:00:00.000Z',
        '2026-10-06T16:00:00.000Z',
        'confirmed',
        false,
      ],
      [
        'abc@google.com',
        '2026-10-07T16:00:00.000Z',
        '2026-10-07T16:00:00.000Z',
        'cancelled',
        false,
      ],
      ['offsite@google.com', null, '2026-10-09', 'tentative', true],
    ]);
    expect(read.items[0]).toMatchObject({ attendees: 1, time_zone: 'America/Los_Angeles' });
    const first = google.asked[0];
    expect(first?.searchParams.get('singleEvents')).toBe('true');
    expect(first?.searchParams.get('showDeleted')).toBe('true');
    expect(first?.searchParams.get('timeMin')).toBe(WINDOW.from);
  });

  test('an event with neither a start nor an original start is left out', () => {
    expect(googleOccurrence({ id: 'x', status: 'cancelled' })).toBeNull();
  });
});

describe('Graph calendarView occurrences', () => {
  const base = 'https://graph.example/v1.0/me';
  const series = {
    id: 'AAMk-occ-1',
    type: 'occurrence',
    seriesMasterId: 'AAMk-master',
    originalStart: '2026-10-06T16:00:00Z',
    subject: 'Standup',
    start: { dateTime: '2026-10-06T16:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-06T16:15:00.0000000', timeZone: 'UTC' },
    location: { displayName: 'Room 1' },
    attendees: [{ emailAddress: { address: 'a@example.test' } }],
    originalStartTimeZone: 'Pacific Standard Time',
  };
  const moved = {
    ...series,
    id: 'AAMk-exc-2',
    type: 'exception',
    originalStart: '2026-10-07T16:00:00Z',
    start: { dateTime: '2026-10-07T18:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-10-07T18:15:00.0000000', timeZone: 'UTC' },
  };
  const cancelled = {
    ...series,
    id: 'AAMk-occ-3',
    originalStart: '2026-10-08T16:00:00Z',
    isCancelled: true,
  };

  test('a series instance is named by the series and its original start; a moved one keeps it', async () => {
    const graph = provider((url) => {
      if (!url.pathname.endsWith('/calendarView')) return undefined;
      return url.searchParams.get('$skip')
        ? { body: { value: [cancelled] } }
        : { body: { value: [series, moved], '@odata.nextLink': `${base}/calendarView?$skip=2` } };
    });
    const connector = new OutlookCalendarConnector({
      id: 'conn_outlook001',
      spaceId: 'sp_test0001',
      base,
      access,
      fetcher: graph.fetcher,
    });
    if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    const read = await connector.signals.occurrences(WINDOW);
    expect(read.complete).toBe(true);
    expect(read.items.map((item) => [item.uid, item.occurrence, item.start, item.status])).toEqual([
      ['AAMk-master', '2026-10-06T16:00:00.000Z', '2026-10-06T16:00:00.000Z', 'confirmed'],
      ['AAMk-master', '2026-10-07T16:00:00.000Z', '2026-10-07T18:00:00.000Z', 'confirmed'],
      ['AAMk-master', '2026-10-08T16:00:00.000Z', '2026-10-06T16:00:00.000Z', 'cancelled'],
    ]);
    expect(graph.asked[0]?.searchParams.get('startDateTime')).toBe(WINDOW.from);
  });

  test('a next page on another host is not followed, and the read says it is incomplete', async () => {
    const graph = provider((url) =>
      url.pathname.endsWith('/calendarView')
        ? { body: { value: [series], '@odata.nextLink': 'https://elsewhere.example/steal' } }
        : undefined,
    );
    const connector = new OutlookCalendarConnector({
      id: 'conn_outlook001',
      spaceId: 'sp_test0001',
      base,
      access,
      fetcher: graph.fetcher,
    });
    if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    const read = await connector.signals.occurrences(WINDOW);
    expect(read.complete).toBe(false);
    expect(graph.asked.every((url) => url.hostname === 'graph.example')).toBe(true);
  });

  test('an all-day event keeps its date and a single event has no occurrence id', () => {
    expect(
      graphOccurrence({
        id: 'AAMk-day',
        iCalUId: 'day@example.test',
        type: 'singleInstance',
        isAllDay: true,
        subject: 'Holiday',
        start: { dateTime: '2026-10-09T00:00:00.0000000', timeZone: 'UTC' },
        end: { dateTime: '2026-10-10T00:00:00.0000000', timeZone: 'UTC' },
      }),
    ).toMatchObject({
      uid: 'day@example.test',
      occurrence: null,
      start: '2026-10-09',
      all_day: true,
    });
  });
});

const headers = (id: string, subject: string, from = 'Shop <orders@shop.example>') => ({
  id,
  payload: {
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: 'me@example.test' },
      { name: 'Subject', value: subject },
      { name: 'Message-ID', value: `<${id}@mail.example>` },
      { name: 'Date', value: 'Mon, 05 Oct 2026 11:00:00 +0000' },
    ],
  },
});

describe('Gmail history', () => {
  const base = 'https://gmail.example/gmail/v1/users/me';

  test('a first read starts at the current history; later reads take what was added to the inbox', async () => {
    let expired = false;
    const gmail = provider((url) => {
      if (url.pathname.endsWith('/profile')) return { body: { historyId: '5000' } };
      if (url.pathname.endsWith('/history')) {
        if (expired) return { status: 404, body: {} };
        return {
          body: {
            history: [
              {
                id: '5001',
                messagesAdded: [{ message: { id: 'm1', labelIds: ['INBOX', 'UNREAD'] } }],
              },
              { id: '5002', messagesAdded: [{ message: { id: 'd1', labelIds: ['DRAFT'] } }] },
              { id: '5003', messagesAdded: [{ message: { id: 'm2', labelIds: ['INBOX'] } }] },
            ],
            historyId: '5010',
          },
        };
      }
      if (url.pathname.endsWith('/messages') && url.searchParams.get('q') === 'newer_than:2d')
        return { body: { messages: [{ id: 'm3' }, { id: 'm2' }] } };
      const id = /\/messages\/([^/]+)$/.exec(url.pathname)?.[1];
      if (id && url.searchParams.get('format') === 'metadata')
        return { body: headers(id, `Order ${id}`) };
      return undefined;
    });
    const transport = new GmailApiTransport({
      base,
      from: 'me@example.test',
      access,
      fetcher: gmail.fetcher,
    });
    expect(await transport.changes(null, { limit: 50 })).toEqual({ cursor: '5000', messages: [] });
    const read = await transport.changes('5000', { limit: 50 });
    expect(read.cursor).toBe('5010');
    expect(read.messages.map((message) => [message.key, message.subject, message.text])).toEqual([
      ['gmail:m1', 'Order m1', ''],
      ['gmail:m2', 'Order m2', ''],
    ]);
    expect(read.messages[0]?.from_addresses).toEqual(['orders@shop.example']);
    // Bodies are never asked for.
    expect(gmail.asked.some((url) => url.searchParams.get('format') === 'raw')).toBe(false);

    // A history id Gmail no longer keeps: the last two days are read again,
    // and what was delivered already is skipped without being fetched.
    expired = true;
    const seen = new Set(['gmail:m1', 'gmail:m2']);
    const again = await transport.changes('5010', {
      limit: 50,
      seen: async (key) => seen.has(key),
    });
    expect(again.cursor).toBe('5000');
    expect(again.messages.map((message) => message.key)).toEqual(['gmail:m3']);
  });
});

describe('Graph mail delta', () => {
  const base = 'https://graph.example/v1.0/me';

  test('the first pass through the delta delivers only what arrived since watching began', async () => {
    let gone = false;
    const graph = provider((url) => {
      if (url.pathname.endsWith('/inbox/messages/delta')) {
        if (gone) return { status: 410, body: {} };
        if (url.searchParams.get('$deltatoken') === 'd1')
          return {
            body: {
              value: [
                { id: 'new-2', receivedDateTime: '2026-10-05T12:05:00Z' },
                { id: 'old-1', '@removed': { reason: 'deleted' } },
              ],
              '@odata.deltaLink': `${base}/mailFolders/inbox/messages/delta?$deltatoken=d2`,
            },
          };
        if (url.searchParams.get('$skiptoken') === 's1')
          return {
            body: {
              value: [{ id: 'new-1', receivedDateTime: '2026-10-05T12:01:00Z' }],
              '@odata.deltaLink': `${base}/mailFolders/inbox/messages/delta?$deltatoken=d1`,
            },
          };
        return {
          body: {
            value: [{ id: 'old-1', receivedDateTime: '2026-09-01T09:00:00Z' }],
            '@odata.nextLink': `${base}/mailFolders/inbox/messages/delta?$skiptoken=s1`,
          },
        };
      }
      const id = /\/messages\/([^/?]+)$/.exec(url.pathname)?.[1];
      if (id)
        return {
          body: {
            internetMessageHeaders: [
              { name: 'From', value: 'Billing <billing@vendor.example>' },
              { name: 'Subject', value: `Invoice ${id}` },
              { name: 'Message-ID', value: `<${id}@vendor.example>` },
            ],
          },
        };
      return undefined;
    });
    const transport = new OutlookMailTransport({
      base,
      from: 'me@example.test',
      access,
      fetcher: graph.fetcher,
    });
    const now = Date.parse('2026-10-05T12:00:00Z');
    const first = await transport.changes(null, { limit: 50, now });
    expect(first.messages.map((message) => message.key)).toEqual(['graph:new-1']);
    expect(JSON.parse(first.cursor)).toEqual({
      link: `${base}/mailFolders/inbox/messages/delta?$deltatoken=d1`,
      since: '2026-10-05T12:00:00.000Z',
    });
    const second = await transport.changes(first.cursor, { limit: 50, now });
    expect(second.messages.map((message) => [message.key, message.subject])).toEqual([
      ['graph:new-2', 'Invoice new-2'],
    ]);
    expect(second.messages[0]?.from_addresses).toEqual(['billing@vendor.example']);

    // Graph no longer honours the delta link: the delta starts again from the
    // inbox, and what was delivered already is skipped.
    gone = true;
    const seen = new Set(['graph:new-1', 'graph:new-2']);
    const restarted = await transport.changes(second.cursor, {
      limit: 50,
      now,
      seen: async (key) => seen.has(key),
    });
    expect(restarted.messages).toEqual([]);
  });

  test('a cursor naming another host is not followed', async () => {
    const graph = provider((url) =>
      url.pathname.endsWith('/inbox/messages/delta')
        ? {
            body: {
              value: [],
              '@odata.deltaLink': `${base}/mailFolders/inbox/messages/delta?$deltatoken=x`,
            },
          }
        : undefined,
    );
    const transport = new OutlookMailTransport({
      base,
      from: 'me@example.test',
      access,
      fetcher: graph.fetcher,
    });
    await transport.changes(
      JSON.stringify({ link: 'https://elsewhere.example/x', since: '2026-10-05T12:00:00Z' }),
      {
        limit: 50,
      },
    );
    expect(graph.asked.every((url) => url.hostname === 'graph.example')).toBe(true);
  });
});

describe('IMAP inbox by UID', () => {
  const message = (uid: number, id: string | null): MailMessage => ({
    uid,
    message_id: id,
    from: 'a@example.test',
    from_addresses: ['a@example.test'],
    to: 'me@example.test',
    subject: `Message ${uid}`,
    text: '',
    html: '',
  });
  function inbox(state: {
    validity: string;
    uids: number[];
    ids: Record<number, string>;
  }): ImapInbox {
    return {
      uidValidity: state.validity,
      uidNext: Math.max(0, ...state.uids) + 1,
      // As IMAP does: `n:*` always answers with the last message, even below n.
      uidsFrom: async (first) => {
        const above = state.uids.filter((uid) => uid >= first);
        return above.length ? above : state.uids.slice(-1);
      },
      uidsSince: async () => state.uids,
      headers: async (uid) => message(uid, state.ids[uid] ?? null),
    };
  }

  test('a first read starts at the newest message; later reads take the new UIDs only', async () => {
    const state = { validity: '7', uids: [1, 2, 3], ids: { 3: '<c@x>', 4: '<d@x>', 5: '<e@x>' } };
    expect(await imapChanges(inbox(state), null, { limit: 50 })).toEqual({
      cursor: '7:3',
      messages: [],
    });
    // Nothing new: the last message IMAP hands back for `4:*` is not new.
    expect((await imapChanges(inbox(state), '7:3', { limit: 50 })).messages).toEqual([]);
    state.uids.push(4, 5);
    const read = await imapChanges(inbox(state), '7:3', { limit: 1 });
    expect(read.messages.map((entry) => [entry.key, entry.read_key])).toEqual([['msgid:<d@x>', 4]]);
    expect(read.cursor).toBe('7:4');
    const rest = await imapChanges(inbox(state), read.cursor, { limit: 50 });
    expect(rest.messages.map((entry) => entry.key)).toEqual(['msgid:<e@x>']);
    expect(rest.cursor).toBe('7:5');
  });

  test('when the server renumbers the inbox, recent mail is read again under keys that do not change', async () => {
    // UIDVALIDITY 7 became 9: the same two messages now have UIDs 1 and 2.
    const state = { validity: '9', uids: [1, 2], ids: { 1: '<d@x>', 2: '<e@x>' } };
    const read = await imapChanges(inbox(state), '7:5', { limit: 50 });
    expect(read.cursor).toBe('9:2');
    // The same keys as before the renumbering, so delivery dedupes them.
    expect(read.messages.map((entry) => [entry.key, entry.read_key])).toEqual([
      ['msgid:<d@x>', 1],
      ['msgid:<e@x>', 2],
    ]);
    // A message with no Message-ID is keyed by validity and UID.
    const bare = await imapChanges(
      inbox({ validity: '9', uids: [1, 2, 3], ids: { 1: '<d@x>', 2: '<e@x>' } }),
      '9:2',
      { limit: 50 },
    );
    expect(bare.messages.map((entry) => entry.key)).toEqual(['imap:9:3']);
  });
});

describe('mail signals keep the inbox hygiene', () => {
  test('a sign-in code message is never an observation', async () => {
    const connector = new EmailConnector({
      kind: 'api',
      id: 'conn_mail00001',
      spaceId: 'sp_test0001',
      from: 'me@example.test',
      session: async (work) =>
        work({
          search: async () => [],
          read: async () => null,
          send: async () => ({ messageId: 'x', sentCopy: false }),
          findSent: async () => false,
          health: async () => {},
          changes: async () => ({
            cursor: 'next',
            messages: [
              { ...message('Your verification code is 123456'), key: 'k1', read_key: 'k1' },
              { ...message('Lunch on Friday?'), key: 'k2', read_key: 'k2' },
            ],
          }),
        }),
    });
    if (connector.signals?.stream !== 'mail') throw new Error('expected a mailbox');
    const read = await connector.signals.changes('cursor', { limit: 50 });
    expect(read.messages.map((entry) => entry.key)).toEqual(['k2']);
  });
});

function message(subject: string): MailMessage {
  return {
    id: 'x',
    message_id: null,
    from: 'a@example.test',
    to: 'me@example.test',
    subject,
    text: '',
    html: '',
  };
}

describe('one-time codes never become observations', () => {
  const CODE_SUBJECTS = [
    '482910 is your Instagram code',
    'Your Amazon code: 482910',
    'Your code is 123456',
    'Confirm your login: 123456',
    'Your Uber code 4821',
    'Your temporary PIN: 8812',
    'G-482910 is your Google verification code',
    'Your verification code',
    'Your one-time passcode',
    'Sign-in attempt: 553 120',
    'Your 2FA token 90817263',
    'Use 7741 to log in',
  ];
  const KEPT_SUBJECTS = [
    'Invoice 7731 is overdue',
    'Lunch on Friday?',
    'Q3 planning notes',
    'Your order has shipped',
  ];

  test('every code-shaped subject is withheld, and ordinary mail is not', () => {
    for (const subject of CODE_SUBJECTS)
      expect([subject, withheldFromSignals(message(subject))]).toEqual([subject, true]);
    for (const subject of KEPT_SUBJECTS)
      expect([subject, withheldFromSignals(message(subject))]).toEqual([subject, false]);
  });
});

describe('reading less of each provider', () => {
  test('the first Graph mail delta starts at the time watching began', async () => {
    const base = 'https://graph.example/v1.0/me';
    const graph = provider((url) =>
      url.pathname.endsWith('/inbox/messages/delta')
        ? {
            body: {
              value: [],
              '@odata.deltaLink': `${base}/mailFolders/inbox/messages/delta?$deltatoken=x`,
            },
          }
        : undefined,
    );
    const transport = new OutlookMailTransport({
      base,
      from: 'me@example.test',
      access,
      fetcher: graph.fetcher,
    });
    await transport.changes(null, { limit: 50, now: Date.parse('2026-10-05T12:00:00Z') });
    expect(graph.asked[0]?.searchParams.get('$filter')).toBe(
      'receivedDateTime ge 2026-10-05T12:00:00Z',
    );
  });

  test('CalDAV is asked only for the window, or for one event by its UID', async () => {
    const bodies: string[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ''));
      return new Response('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>', {
        status: 207,
      });
    }) as typeof fetch;
    const connector = new CalendarConnector(
      {
        id: 'conn_caldav0001',
        spaceId: 'sp_test0001',
        mode: 'caldav',
        calendarUrl: 'https://dav.example/cal/',
        username: 'me',
        secretRef: 'sec_1',
      },
      { withSecret: async (_ref, _space, work) => work('password') } as SecretAccess,
      fetcher,
    );
    if (connector.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    expect(await connector.signals.occurrences(WINDOW)).toEqual({ items: [], complete: true });
    expect(bodies[0]).toContain('<c:time-range start="20261005T120000Z" end="20261019T120000Z"/>');
    expect(
      await connector.signals.confirm?.({ uid: 'a&b@example.test', occurrence: null, ref: null }),
    ).toBe('gone');
    expect(bodies[1]).toContain(
      '<c:text-match collation="i;octet">a&amp;b@example.test</c:text-match>',
    );
  });

  test('Google and Graph look an instance up by its own id: gone, or where it moved', async () => {
    const google = provider((url) => {
      if (url.pathname.endsWith('/events/deleted_20261006')) return { status: 410 };
      if (url.pathname.endsWith('/events/moved_20261006'))
        return {
          body: {
            id: 'moved_20261006',
            iCalUID: 'moved@google.com',
            recurringEventId: 'moved',
            status: 'confirmed',
            summary: 'Standup',
            originalStartTime: { dateTime: '2026-10-06T16:00:00Z' },
            start: { dateTime: '2026-11-30T16:00:00Z' },
            end: { dateTime: '2026-11-30T16:15:00Z' },
          },
        };
      return undefined;
    });
    const calendar = new GoogleCalendarConnector({
      id: 'conn_google0001',
      spaceId: 'sp_test0001',
      base: 'https://calendar.example/calendar/v3/calendars/primary',
      access,
      fetcher: google.fetcher,
    });
    if (calendar.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    expect(
      await calendar.signals.confirm?.({ uid: 'x', occurrence: null, ref: 'deleted_20261006' }),
    ).toBe('gone');
    expect(
      await calendar.signals.confirm?.({ uid: 'x', occurrence: null, ref: 'moved_20261006' }),
    ).toMatchObject({ start: '2026-11-30T16:00:00.000Z', occurrence: '2026-10-06T16:00:00.000Z' });

    const base = 'https://graph.example/v1.0/me';
    const graph = provider((url) =>
      url.pathname.endsWith('/events/AAMk-gone') ? { status: 404 } : undefined,
    );
    const outlook = new OutlookCalendarConnector({
      id: 'conn_outlook001',
      spaceId: 'sp_test0001',
      base,
      access,
      fetcher: graph.fetcher,
    });
    if (outlook.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    expect(await outlook.signals.confirm?.({ uid: 'x', occurrence: null, ref: 'AAMk-gone' })).toBe(
      'gone',
    );
  });

  test('a provider asking for time says how long, and a listing that fails says its status', async () => {
    const gmail = new GmailApiTransport({
      base: 'https://gmail.example/gmail/v1/users/me',
      from: 'me@example.test',
      access,
      fetcher: (async () =>
        new Response('{}', {
          status: 429,
          headers: { 'retry-after': '900' },
        })) as unknown as typeof fetch,
    });
    expect(
      await gmail.changes('5000', { limit: 50 }).catch((error: unknown) => error),
    ).toMatchObject({ status: 429, retryAfter: 900 });
    const google = new GoogleCalendarConnector({
      id: 'conn_google0001',
      spaceId: 'sp_test0001',
      base: 'https://calendar.example/calendar/v3/calendars/primary',
      access,
      fetcher: (async () =>
        new Response('{}', {
          status: 503,
          headers: { 'retry-after': '120' },
        })) as unknown as typeof fetch,
    });
    if (google.signals?.stream !== 'calendar') throw new Error('expected a calendar');
    const failed = await google.signals.occurrences(WINDOW).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SourceError);
    expect(failed).toMatchObject({ status: 503, retryAfter: 120 });
  });
});
