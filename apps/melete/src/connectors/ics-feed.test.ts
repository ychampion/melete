import { describe, expect, test } from 'bun:test';
import { IcsFeedConnector, icsFeedTarget } from './ics-feed.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type { SecretAccess } from './secrets.ts';
import type { ResolvedAddress, WebResponse, WebTransport } from './web.ts';

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

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 };
const PRIVATE: ResolvedAddress = { address: '10.0.0.8', family: 4 };

const sealed = (address: string): SecretAccess => ({
  withSecret: async (_id, _space, use) => use(address),
});

/** Records every address the loopback fixture path asks for, and serves the feed to all of them. */
function recording() {
  const requested: string[] = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
    requested.push(String(input));
    return new Response(FEED, { headers: { 'content-type': 'text/calendar' } });
  }) as typeof fetch;
  return { requested, fetcher };
}

/** Records where a checked request was sent: the address it names and the one it was pinned to. */
function pinnedRecording(
  response: WebResponse = { status: 200, headers: { 'content-type': 'text/calendar' }, body: FEED },
) {
  const sent: Array<{ url: string; address: string }> = [];
  const transport: WebTransport = async (url, address) => {
    sent.push({ url: url.href, address: address.address });
    return response;
  };
  return { sent, transport };
}

const names =
  (answers: Record<string, ResolvedAddress[]>) =>
  async (hostname: string): Promise<ResolvedAddress[]> => {
    const found = answers[hostname];
    if (!found) throw new Error('name not found');
    return found;
  };

const connection = { id: 'con_test', spaceId: 'spc_test', secretRef: 'sec_feed' };

describe('calendar feed addresses', () => {
  const resolve = names({
    'feeds.example.test': [PUBLIC],
    'inside.example.test': [PRIVATE],
    'mixed.example.test': [PUBLIC, PRIVATE],
    'empty.example.test': [],
    localhost: [{ address: '127.0.0.1', family: 4 }],
  });

  test('a public HTTPS address is usable and pinned to the address that was checked', async () => {
    expect(
      await icsFeedTarget('https://feeds.example.test/team.ics?token=x', false, resolve),
    ).toMatchObject({ usable: true, pinned: PUBLIC });
    expect(await icsFeedTarget('https://93.184.216.34/team.ics', false, resolve)).toMatchObject({
      usable: true,
      pinned: PUBLIC,
    });
  });

  test('plain HTTP, embedded credentials and every private or loopback destination are refused', async () => {
    for (const address of [
      'http://127.0.0.1:8080/team.ics',
      'http://localhost/team.ics',
      'http://feeds.example.test/team.ics',
      'https://owner:secret@feeds.example.test/team.ics',
      'ftp://feeds.example.test/team.ics',
      'not an address',
      'https://127.0.0.1/team.ics',
      'https://10.0.0.8/team.ics',
      'https://192.168.1.20:8443/team.ics',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/team.ics',
      'https://[fd00::1]/team.ics',
      'https://[::ffff:10.0.0.8]/team.ics',
      'https://localhost/team.ics',
      'https://inside.example.test/team.ics',
      'https://mixed.example.test/team.ics',
    ])
      expect([address, await icsFeedTarget(address, false, resolve)]).toEqual([
        address,
        { usable: false, reason: 'refused' },
      ]);
  });

  test('a name that does not resolve is unresolved rather than refused', async () => {
    for (const address of [
      'https://missing.example.test/a.ics',
      'https://empty.example.test/a.ics',
    ])
      expect(await icsFeedTarget(address, false, resolve)).toEqual({
        usable: false,
        reason: 'unresolved',
      });
  });

  test('a local fixture may be plain HTTP on loopback and nowhere else', async () => {
    const local = await icsFeedTarget('http://127.0.0.1:8080/team.ics', true, resolve);
    expect(local).toMatchObject({ usable: true });
    expect(local.usable && local.pinned).toBeUndefined();
    expect(await icsFeedTarget('http://feeds.example.test/team.ics', true, resolve)).toEqual({
      usable: false,
      reason: 'refused',
    });
    expect(await icsFeedTarget('https://10.0.0.8/team.ics', true, resolve)).toEqual({
      usable: false,
      reason: 'refused',
    });
  });
});

describe('reading a calendar feed', () => {
  test('a loopback HTTP feed is never fetched unless the connection allows a local fixture', async () => {
    const address = 'http://127.0.0.1:8080/team.ics?token=private';
    const refused = recording();
    const checked = pinnedRecording();
    const production = new IcsFeedConnector(connection, sealed(address), {
      fetcher: refused.fetcher,
      transport: checked.transport,
    });
    expect((await production.health()).status).toBe('failing');
    const listed = await production.execute(
      mailAction('calendar.list', { limit: 5 }),
      mailContext(),
    );
    expect(listed).toMatchObject({ outcome: 'failed', reason: 'Calendar feed unavailable.' });
    expect(JSON.stringify(listed)).not.toContain('private');
    expect(refused.requested).toEqual([]);
    expect(checked.sent).toEqual([]);

    const allowed = recording();
    const fixture = new IcsFeedConnector(
      { ...connection, allowInsecureLocalForTests: true },
      sealed(address),
      { fetcher: allowed.fetcher },
    );
    expect((await fixture.health()).status).toBe('ok');
    expect(allowed.requested).toEqual([address]);
  });

  test('a feed whose name answers with a private address is never requested', async () => {
    for (const address of [
      'https://inside.example.test/team.ics?token=private',
      'https://10.0.0.8/team.ics?token=private',
      'https://127.0.0.1:8443/team.ics?token=private',
    ]) {
      const direct = recording();
      const checked = pinnedRecording();
      const connector = new IcsFeedConnector(connection, sealed(address), {
        fetcher: direct.fetcher,
        transport: checked.transport,
        resolve: names({ 'inside.example.test': [PRIVATE] }),
      });
      expect((await connector.health()).status).toBe('failing');
      const listed = await connector.execute(
        mailAction('calendar.list', { limit: 5 }),
        mailContext(),
      );
      expect(listed).toMatchObject({ outcome: 'failed', reason: 'Calendar feed unavailable.' });
      expect(JSON.stringify(listed)).not.toContain('private');
      expect(direct.requested).toEqual([]);
      expect(checked.sent).toEqual([]);
    }
  });

  test('a public feed is requested at the address that was checked, on every read', async () => {
    const address = 'https://feeds.example.test/team.ics?token=private';
    const direct = recording();
    const checked = pinnedRecording();
    let answers = [PUBLIC];
    const connector = new IcsFeedConnector(connection, sealed(address), {
      fetcher: direct.fetcher,
      transport: checked.transport,
      resolve: async () => answers,
    });
    expect((await connector.health()).status).toBe('ok');
    const listed = await connector.execute(
      mailAction('calendar.list', { limit: 5 }),
      mailContext(),
    );
    expect(listed.outcome).toBe('succeeded');
    expect(JSON.stringify(listed)).toContain('Feed planning session');
    expect(JSON.stringify(listed)).not.toContain('private');
    expect(checked.sent).toEqual([
      { url: address, address: PUBLIC.address },
      { url: address, address: PUBLIC.address },
    ]);
    expect(direct.requested).toEqual([]);

    // The name is checked again each time, so a later private answer stops the next read.
    answers = [PRIVATE];
    expect((await connector.health()).status).toBe('failing');
    expect(checked.sent).toHaveLength(2);
  });

  test('a redirect is not followed and an error status is not a feed', async () => {
    const answers: WebResponse[] = [
      { status: 302, headers: { location: 'https://10.0.0.8/team.ics' }, body: '' },
      { status: 404, headers: {}, body: 'missing' },
    ];
    for (const response of answers) {
      const checked = pinnedRecording(response);
      const connector = new IcsFeedConnector(
        connection,
        sealed('https://feeds.example.test/team.ics'),
        { transport: checked.transport, resolve: async () => [PUBLIC] },
      );
      expect((await connector.health()).status).toBe('failing');
      expect(checked.sent).toHaveLength(1);
    }
  });
});
