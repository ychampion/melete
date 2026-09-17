import { describe, expect, test } from 'bun:test';
import { IcsFeedConnector, icsFeedAddressUsable } from './ics-feed.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type { SecretAccess } from './secrets.ts';

const FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:feed-event',
  'DTSTART:20260105T090000Z',
  'DTEND:20260105T100000Z',
  'SUMMARY:Feed planning session',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

const sealed = (address: string): SecretAccess => ({
  withSecret: async (_id, _space, use) => use(address),
});

/** Records every address the connector asks for, and serves the feed to all of them. */
function recording() {
  const requested: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    requested.push(String(input));
    return new Response(FEED, { headers: { 'content-type': 'text/calendar' } });
  }) as typeof fetch;
  return { requested, fetcher };
}

const connection = { id: 'conn_feed', spaceId: 'sp_feed', secretRef: 'sec_feed' };

describe('calendar feed addresses', () => {
  test('TLS everywhere; plain HTTP only to a loopback fixture the service allows', () => {
    expect(icsFeedAddressUsable('https://feeds.example.test/team.ics?token=x', false)).toBe(true);
    expect(icsFeedAddressUsable('http://127.0.0.1:8080/team.ics', true)).toBe(true);
    for (const address of [
      'http://127.0.0.1:8080/team.ics',
      'http://localhost/team.ics',
      'http://feeds.example.test/team.ics',
      'https://owner:secret@feeds.example.test/team.ics',
      'ftp://feeds.example.test/team.ics',
      'not an address',
    ])
      expect([address, icsFeedAddressUsable(address, false)]).toEqual([address, false]);
    expect(icsFeedAddressUsable('http://feeds.example.test/team.ics', true)).toBe(false);
  });

  test('a loopback HTTP feed is never fetched unless the connection allows a local fixture', async () => {
    const address = 'http://127.0.0.1:8080/team.ics?token=private';
    const refused = recording();
    const production = new IcsFeedConnector(connection, sealed(address), refused.fetcher);
    expect((await production.health()).status).toBe('failing');
    const listed = await production.execute(
      mailAction('calendar.list', { limit: 5 }),
      mailContext(),
    );
    expect(listed).toMatchObject({ outcome: 'failed', reason: 'Calendar feed unavailable.' });
    expect(JSON.stringify(listed)).not.toContain('private');
    expect(refused.requested).toEqual([]);

    const allowed = recording();
    const fixture = new IcsFeedConnector(
      { ...connection, allowInsecureLocalForTests: true },
      sealed(address),
      allowed.fetcher,
    );
    expect((await fixture.health()).status).toBe('ok');
    expect(allowed.requested).toEqual([address]);
  });
});
