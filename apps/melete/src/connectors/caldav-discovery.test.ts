import { afterAll, describe, expect, test } from 'bun:test';
import { CalendarDiscoveryError, discoverCalendar } from './caldav-discovery.ts';

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
