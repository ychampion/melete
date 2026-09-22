/**
 * Finding a person's calendar from the address of their calendar service.
 *
 * A CalDAV service says where an account's calendars live in three steps: the
 * service names the account's principal, the principal names its calendar
 * home, and the home lists the calendars. A person who knows only
 * `https://caldav.icloud.com/`, their account name and an app password is
 * therefore enough; the first calendar that holds events is the one used.
 *
 * Every request carries the credential, so it only goes over TLS, and a step
 * may move to another host only inside the service's own domain (iCloud keeps
 * each account's calendars on a numbered host of its own).
 */
import { XMLParser } from 'fast-xml-parser';

export type DiscoveredCalendar = { calendar_url: string; name: string | null };

/** Why nothing was found, in words a person can act on. */
export class CalendarDiscoveryError extends Error {}

const MAX_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const LOOPBACK = ['127.0.0.1', '[::1]', 'localhost'];

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined ? [] : [value];
const text = (value: unknown): string | null =>
  typeof value === 'string'
    ? value.trim() || null
    : typeof object(value)['#text'] === 'string'
      ? String(object(value)['#text']).trim() || null
      : null;

/** The last two labels of a host: `p42-caldav.icloud.com` and `caldav.icloud.com` share `icloud.com`. */
const site = (host: string) => host.split('.').slice(-2).join('.');

export type DiscoveryOptions = {
  serverUrl: string;
  username: string;
  password: string;
  fetcher?: typeof fetch;
  /** Plain HTTP to a loopback fixture, for tests only. */
  allowInsecureLocalForTests?: boolean;
};

export async function discoverCalendar(options: DiscoveryOptions): Promise<DiscoveredCalendar> {
  const fetcher = options.fetcher ?? fetch;
  const origin = new URL(options.serverUrl);
  const allowed = (url: URL) =>
    !url.username &&
    !url.password &&
    (url.protocol === 'https:' ||
      (options.allowInsecureLocalForTests === true &&
        url.protocol === 'http:' &&
        LOOPBACK.includes(url.hostname))) &&
    site(url.hostname) === site(origin.hostname);
  if (!allowed(origin)) throw new CalendarDiscoveryError('The calendar service must use HTTPS.');
  const authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`;

  async function propfind(start: URL, depth: '0' | '1', body: string) {
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowed(url))
        throw new CalendarDiscoveryError(
          'The calendar service pointed somewhere outside its own address.',
        );
      const response = await fetcher(url, {
        method: 'PROPFIND',
        headers: { authorization, depth, 'content-type': 'application/xml; charset=utf-8' },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
      if ([301, 302, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) break;
        url = new URL(location, url);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new CalendarDiscoveryError(
          'The calendar service did not accept the account name and password. Use an app password where the provider offers one.',
        );
      }
      if (response.status !== 207) {
        await response.body?.cancel();
        throw new CalendarDiscoveryError('The calendar service did not answer as CalDAV.');
      }
      const xml = await response.text();
      if (xml.length > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml))
        throw new CalendarDiscoveryError('The calendar service did not answer as CalDAV.');
      const parsed = new XMLParser({
        removeNSPrefix: true,
        ignoreAttributes: false,
        attributeNamePrefix: '',
      }).parse(xml);
      return { url, responses: array(object(object(parsed).multistatus).response) };
    }
    throw new CalendarDiscoveryError('The calendar service redirected too many times.');
  }

  /** The first href a property holds, on any response that answered 200 for it. */
  const hrefOf = (responses: unknown[], property: string): string | null => {
    for (const response of responses)
      for (const propstat of array(object(response).propstat)) {
        if (!/\s200\s/.test(String(object(propstat).status))) continue;
        const value = object(object(propstat).prop)[property];
        const href = text(array(object(value).href)[0]);
        if (href) return href;
      }
    return null;
  };

  const step = async (from: URL, property: string, missing: string) => {
    const found = await propfind(
      from,
      '0',
      `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><${property === 'calendar-home-set' ? 'c' : 'd'}:${property}/></d:prop></d:propfind>`,
    );
    const href = hrefOf(found.responses, property);
    if (!href) throw new CalendarDiscoveryError(missing);
    return new URL(href, found.url);
  };

  const principal = await step(
    origin,
    'current-user-principal',
    'The calendar service did not say which account this is.',
  );
  const home = await step(
    principal,
    'calendar-home-set',
    'The calendar service did not say where this account keeps its calendars.',
  );
  const listing = await propfind(
    home,
    '1',
    '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/></d:prop></d:propfind>',
  );
  for (const response of listing.responses) {
    const href = text(array(object(response).href)[0]);
    if (!href) continue;
    for (const propstat of array(object(response).propstat)) {
      if (!/\s200\s/.test(String(object(propstat).status))) continue;
      const prop = object(object(propstat).prop);
      if (!('calendar' in object(prop.resourcetype))) continue;
      const components = array(object(prop['supported-calendar-component-set']).comp).map((comp) =>
        String(object(comp).name ?? '').toUpperCase(),
      );
      // A collection that says nothing about what it holds is taken to hold events.
      if (components.length && !components.includes('VEVENT')) continue;
      const url = new URL(href, listing.url);
      if (!allowed(url)) continue;
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return { calendar_url: url.toString(), name: text(prop.displayname) };
    }
  }
  throw new CalendarDiscoveryError('This account has no calendar that holds events.');
}
