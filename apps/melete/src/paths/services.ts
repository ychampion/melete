/**
 * Which service an effect reaches, as one key both paths agree on.
 *
 * A form sent from the agent's browser to `mail.google.com` and an
 * `email.send` through a connected Gmail account reach the same service, so
 * both read `google:mail`. A site no connected app speaks for is keyed by its
 * registrable name (`opentable.com`), and so is an installed MCP server, by
 * the name of the address it is reached at. A mailbox or calendar on a host
 * Melete does not recognise keeps a key of its own (`mail:<host>`), so a form
 * on the same company's website is never taken for a send from that mailbox.
 */

/** Web apps whose address says which of their parts a page belongs to. */
const WEB_APPS: ReadonlyArray<{
  hosts: readonly string[];
  key: (path: string) => string;
}> = [
  { hosts: ['mail.google.com'], key: () => 'google:mail' },
  { hosts: ['calendar.google.com'], key: () => 'google:calendar' },
  {
    hosts: [
      'outlook.live.com',
      'outlook.office.com',
      'outlook.office365.com',
      'outlook.cloud.microsoft',
    ],
    key: (path) => (path.startsWith('/calendar') ? 'microsoft:calendar' : 'microsoft:mail'),
  },
  {
    hosts: ['www.icloud.com', 'icloud.com'],
    key: (path) =>
      path.startsWith('/calendar')
        ? 'apple:calendar'
        : path.startsWith('/mail')
          ? 'apple:mail'
          : 'icloud.com',
  },
  { hosts: ['mail.yahoo.com'], key: () => 'yahoo:mail' },
  { hosts: ['calendar.yahoo.com'], key: () => 'yahoo:calendar' },
  {
    hosts: ['app.fastmail.com', 'www.fastmail.com'],
    key: (path) => (path.startsWith('/calendar') ? 'fastmail:calendar' : 'fastmail:mail'),
  },
];

/** Mail servers by the registrable name of their host. */
const MAIL_HOSTS: Readonly<Record<string, string>> = {
  'gmail.com': 'google:mail',
  'googlemail.com': 'google:mail',
  'google.com': 'google:mail',
  'office365.com': 'microsoft:mail',
  'outlook.com': 'microsoft:mail',
  'hotmail.com': 'microsoft:mail',
  'live.com': 'microsoft:mail',
  'me.com': 'apple:mail',
  'icloud.com': 'apple:mail',
  'yahoo.com': 'yahoo:mail',
  'fastmail.com': 'fastmail:mail',
};

/** Calendar servers by the registrable name of their host. */
const CALENDAR_HOSTS: Readonly<Record<string, string>> = {
  'google.com': 'google:calendar',
  'googleusercontent.com': 'google:calendar',
  'office365.com': 'microsoft:calendar',
  'outlook.com': 'microsoft:calendar',
  'icloud.com': 'apple:calendar',
  'me.com': 'apple:calendar',
  'yahoo.com': 'yahoo:calendar',
  'fastmail.com': 'fastmail:calendar',
};

/** Second-level names under which a site's own name takes three labels. */
const SECOND_LEVEL = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.jp',
  'co.in',
  'com.br',
  'com.mx',
  'co.za',
  'com.sg',
  'com.hk',
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A host's registrable name: `book.opentable.com` is `opentable.com`. */
export function registrableName(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (IPV4.test(name) || name.includes(':')) return name;
  const labels = name.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return labels.slice(SECOND_LEVEL.has(lastTwo) ? -3 : -2).join('.');
}

function hostOf(raw: string): { host: string; path: string } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { host: url.hostname.toLowerCase().replace(/\.$/, ''), path: url.pathname };
  } catch {
    return null;
  }
}

/** The service a page or form address belongs to, or null for an address that is not a web page. */
export function serviceOfUrl(raw: string): string | null {
  const at = hostOf(raw);
  if (!at) return null;
  const app = WEB_APPS.find((entry) => entry.hosts.includes(at.host));
  return app ? app.key(at.path) : registrableName(at.host);
}

/** The service a mail server reaches. */
export function serviceOfMailHost(host: string): string {
  const name = registrableName(host);
  return MAIL_HOSTS[name] ?? `mail:${host.toLowerCase()}`;
}

/** The service a calendar server reaches. */
export function serviceOfCalendarHost(host: string): string {
  const name = registrableName(host);
  return CALENDAR_HOSTS[name] ?? `calendar:${host.toLowerCase()}`;
}

type ConnectionLike = {
  provider: string;
  configuration: Record<string, unknown> | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The service a connected app's tools reach, from what was stored when it was
 * connected, never from a tool call. Null when the connection reaches no
 * outside service a browser could also reach.
 */
export function serviceOfConnection(row: ConnectionLike): string | null {
  const config = record(row.configuration);
  const kind = config?.kind;
  if (kind === 'gmail') return 'google:mail';
  if (kind === 'google_calendar') return 'google:calendar';
  if (kind === 'outlook_mail') return 'microsoft:mail';
  if (kind === 'outlook_calendar') return 'microsoft:calendar';
  if (row.provider === 'imap') {
    const host = record(record(config?.mail)?.smtp)?.host ?? record(config?.smtp)?.host;
    return typeof host === 'string' ? serviceOfMailHost(host) : null;
  }
  if (row.provider === 'caldav' && kind !== 'ics') {
    const url = record(config?.caldav)?.calendar_url ?? config?.calendar_url;
    const at = typeof url === 'string' ? hostOf(url) : null;
    return at ? serviceOfCalendarHost(at.host) : null;
  }
  if (row.provider === 'mcp') {
    const endpoint = record(record(config?.server)?.endpoint) ?? record(config?.endpoint);
    const url = endpoint?.url ?? config?.url;
    const at = typeof url === 'string' ? hostOf(url) : null;
    return at ? registrableName(at.host) : null;
  }
  return null;
}
