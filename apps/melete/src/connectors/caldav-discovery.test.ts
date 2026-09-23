import { afterAll, describe, expect, test } from 'bun:test';
import { CalendarDiscoveryError, discoverCalendar, hopAllowed } from './caldav-discovery.ts';

const PASSWORD = 'app-password';
let homeHost = '';
let calendars = [
  { href: '/cal/owner/', type: '<d:collection/>', comps: '' },
  {
    href: '/cal/owner/tasks/',
    type: '<d:collection/><c:calendar/>',
    comps: '<c:comp name="VTODO"/>',
  },
  {
    href: '/cal/owner/home/',
    type: '<d:collection/><c:calendar/>',
    comps: '<c:comp name="VEVENT"/><c:comp name="VTODO"/>',
  },
];
const seen: string[] = [];

const multistatus = (responses: string) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${responses}</d:multistatus>`;
const ok = (href: string, prop: string) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname} ${request.headers.get('depth')}`);
    const expected = `Basic ${Buffer.from(`owner@example.test:${PASSWORD}`).toString('base64')}`;
    if (request.headers.get('authorization') !== expected) return new Response('', { status: 401 });
    if (url.pathname === '/') return Response.redirect(`${url.origin}/dav/`, 301);
    const xml = (body: string) =>
      new Response(multistatus(body), {
        status: 207,
        headers: { 'content-type': 'application/xml' },
      });
    if (url.pathname === '/dav/')
      return xml(
        ok(
          '/dav/',
          '<d:current-user-principal><d:href>/principals/owner/</d:href></d:current-user-principal>',
        ),
      );
    if (url.pathname === '/principals/owner/')
      return xml(
        ok(
          '/principals/owner/',
          `<c:calendar-home-set><d:href>${homeHost}/cal/owner/</d:href></c:calendar-home-set>`,
        ),
      );
    if (url.pathname === '/cal/owner/')
      return xml(
        calendars
          .map((entry) =>
            ok(
              entry.href,
              `<d:resourcetype>${entry.type}</d:resourcetype><d:displayname>${entry.href.split('/').at(-2)}</d:displayname>${
                entry.comps
                  ? `<c:supported-calendar-component-set>${entry.comps}</c:supported-calendar-component-set>`
                  : ''
              }`,
            ),
          )
          .join(''),
      );
    return new Response('', { status: 404 });
  },
});
afterAll(() => server.stop(true));

const base = `http://127.0.0.1:${server.port}`;
const discover = (password = PASSWORD) =>
  discoverCalendar({
    serverUrl: `${base}/`,
    username: 'owner@example.test',
    password,
    allowInsecureLocalForTests: true,
  });
const failure = (work: Promise<unknown>) =>
  work.then(
    () => 'found',
    (error: unknown) => (error instanceof CalendarDiscoveryError ? error.message : String(error)),
  );

describe('finding a calendar from the service address', () => {
  test('follows the principal and the home to the first calendar that holds events', async () => {
    expect(await discover()).toEqual({ calendar_url: `${base}/cal/owner/home/`, name: 'home' });
    expect(seen).toEqual([
      'PROPFIND / 0',
      'PROPFIND /dav/ 0',
      'PROPFIND /principals/owner/ 0',
      'PROPFIND /cal/owner/ 1',
    ]);
  });

  test('a refused password is said in plain words, and nothing is found', async () => {
    expect(await failure(discover('wrong'))).toBe(
      'The calendar service did not accept the account name and password. Use an app password where the provider offers one.',
    );
  });

  test('a service that sends the credential to another site is not followed', async () => {
    homeHost = `http://localhost:${server.port}`;
    try {
      expect(await failure(discover())).toBe(
        'The calendar service pointed somewhere outside its own address.',
      );
    } finally {
      homeHost = '';
    }
  });

  test('an account with only task lists is told so', async () => {
    const kept = calendars;
    calendars = kept.filter((entry) => !entry.href.endsWith('home/'));
    try {
      expect(await failure(discover())).toBe('This account has no calendar that holds events.');
    } finally {
      calendars = kept;
    }
  });

  test('plain HTTP to a real host is refused before any request', async () => {
    expect(
      await failure(
        discoverCalendar({
          serverUrl: 'http://caldav.example.test/',
          username: 'owner',
          password: PASSWORD,
        }),
      ),
    ).toBe('The calendar service must use HTTPS.');
  });
});

describe('where a step may take the credential', () => {
  const answers: Record<string, string> = {
    'caldav.icloud.com': '17.253.1.1',
    'p42-caldav.icloud.com': '17.253.2.2',
    'p66-caldav.icloud.com': '10.0.0.5',
    'dav.example.co.uk': '93.184.216.34',
    'evil.co.uk': '93.184.216.35',
  };
  const resolve = async (host: string) => {
    const address = answers[host];
    if (!address) throw new Error('no such host');
    return [{ address, family: 4 as const }];
  };
  const hop = (from: string, to: string) => hopAllowed(new URL(from), new URL(to), resolve);

  test('the same host always, and another host only inside a known provider', async () => {
    expect(await hop('https://dav.example.co.uk/', 'https://dav.example.co.uk/c/')).toBe(true);
    expect(await hop('https://caldav.icloud.com/', 'https://p42-caldav.icloud.com/1/')).toBe(true);
    // A shared public suffix is not a shared owner.
    expect(await hop('https://dav.example.co.uk/', 'https://evil.co.uk/')).toBe(false);
  });

  test('an address written as an IP matches only itself', async () => {
    expect(await hop('https://10.0.0.1/', 'https://10.0.0.1/c/')).toBe(true);
    expect(await hop('https://10.0.0.1/', 'https://192.168.0.1/')).toBe(false);
    expect(await hop('https://caldav.icloud.com/', 'https://17.253.2.2/')).toBe(false);
  });

  test('a service on public addresses never sends the credential to a private one', async () => {
    expect(await hop('https://caldav.icloud.com/', 'https://p66-caldav.icloud.com/')).toBe(false);
  });
});

describe('a service that answers only at its well-known address', () => {
  test('is found there', async () => {
    const wellKnown = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const answer = (body: string) => new Response(multistatus(body), { status: 207 });
        if (path === '/.well-known/caldav')
          return answer(
            ok(path, '<d:current-user-principal><d:href>/p/</d:href></d:current-user-principal>'),
          );
        if (path === '/p/')
          return answer(
            ok(path, '<c:calendar-home-set><d:href>/h/</d:href></c:calendar-home-set>'),
          );
        if (path === '/h/')
          return answer(
            ok('/h/cal/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>'),
          );
        return new Response('', { status: 404 });
      },
    });
    try {
      expect(
        await discoverCalendar({
          serverUrl: `http://127.0.0.1:${wellKnown.port}/`,
          username: 'owner',
          password: PASSWORD,
          allowInsecureLocalForTests: true,
        }),
      ).toEqual({ calendar_url: `http://127.0.0.1:${wellKnown.port}/h/cal/`, name: null });
    } finally {
      wellKnown.stop(true);
    }
  });
});
