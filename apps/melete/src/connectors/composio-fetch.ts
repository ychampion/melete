/**
 * The managed transport under Melete's own Gmail, Google Calendar and Google
 * Drive connectors. Each connector already takes a `fetcher`; this one turns
 * a `fetch` of a Google API address into one Composio proxy call for the
 * connection's own connected account, and hands back an ordinary `Response`
 * with Google's answer. Every parser, cursor, fault class and signal the
 * native path has is therefore the managed path's too.
 *
 * Which account a call acts for comes only from the connection row, bound
 * when the connector is built: nothing in a request, a tool's input or an
 * answer can name another. A fetcher allows only the requests on its list, so
 * the one the signal poller reads through cannot send, and only the agent's
 * own dispatch holds the one that can.
 */
import type { ComposioClient, ComposioProxyRequest } from './composio.ts';
import { ComposioFault } from './composio.ts';
import { ResponseTooLarge, type SignedInAccess, SignInEnded } from './signed-in.ts';

/** One request a fetcher allows: a method, a host, and a path at that host. */
export type ProxyRule = { method: ComposioProxyRequest['method']; host: string; path: RegExp };

const GMAIL = 'gmail.googleapis.com';
const GOOGLE_APIS = 'www.googleapis.com';
const MAILBOX = '/gmail/v1/users/me';
const CALENDAR = '/calendar/v3/calendars/primary';
const DRIVE = '/drive/v3';
/**
 * One id in a path: a Gmail message, a calendar event or a Drive file. Their
 * ids never hold anything else, so no segment can carry an encoded slash, a
 * dot segment or an address that a server further on might read as a path.
 */
const SEGMENT = '[A-Za-z0-9_-]{1,1024}';

const rule = (method: ProxyRule['method'], host: string, path: string): ProxyRule => ({
  method,
  host,
  path: new RegExp(`^${path}$`),
});

/** What reading an account needs, by what the connection is. Never a write. */
export const MANAGED_READS = {
  mail: [
    rule('GET', GMAIL, `${MAILBOX}/profile`),
    rule('GET', GMAIL, `${MAILBOX}/history`),
    rule('GET', GMAIL, `${MAILBOX}/messages`),
    rule('GET', GMAIL, `${MAILBOX}/messages/${SEGMENT}`),
  ],
  calendar: [
    rule('GET', GOOGLE_APIS, CALENDAR),
    rule('GET', GOOGLE_APIS, `${CALENDAR}/events`),
    rule('GET', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`),
  ],
  documents: [
    rule('GET', GOOGLE_APIS, `${DRIVE}/about`),
    rule('GET', GOOGLE_APIS, `${DRIVE}/changes`),
    rule('GET', GOOGLE_APIS, `${DRIVE}/changes/startPageToken`),
    rule('GET', GOOGLE_APIS, `${DRIVE}/files/${SEGMENT}`),
  ],
} as const satisfies Record<string, ProxyRule[]>;

/** What the agent's tools may also do, each after the approval the tool asks for. */
export const MANAGED_WRITES = {
  mail: [...MANAGED_READS.mail, rule('POST', GMAIL, `${MAILBOX}/messages/send`)],
  calendar: [
    ...MANAGED_READS.calendar,
    rule('POST', GOOGLE_APIS, `${CALENDAR}/events`),
    rule('PUT', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`),
    rule('DELETE', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`),
  ],
  // A Drive connection only ever reads metadata.
  documents: [...MANAGED_READS.documents],
} as const satisfies Record<string, ProxyRule[]>;

/** The real Google addresses a managed connector is built with. */
export const MANAGED_GOOGLE_BASES = {
  gmail: `https://${GMAIL}${MAILBOX}`,
  calendar: `https://${GOOGLE_APIS}${CALENDAR}`,
  drive: `https://${GOOGLE_APIS}${DRIVE}`,
} as const;

/** A request outside the fetcher's list. It never leaves this process. */
export class ManagedRequestRefused extends Error {
  readonly code = 'managed_request_refused';
  constructor() {
    super('managed_request_refused');
    this.name = 'ManagedRequestRefused';
  }
}

/** Request headers passed on to Google; the authorization is Composio's to add. */
const FORWARDED_HEADERS = ['if-match', 'if-none-match'];

/** Composio's own trouble, as the status a connector already knows how to read. */
function faultResponse(error: ComposioFault): Response {
  // An account Composio no longer acts for: the sign-in is over.
  const status =
    error.kind === 'account_unavailable'
      ? 401
      : error.kind === 'rate_limited'
        ? 429
        : // The project key, or Composio itself: trouble at the provider, not this account.
          error.kind === 'key_refused' || error.kind === 'unavailable'
          ? 503
          : 502;
  return Response.json(
    { error: { code: status } },
    {
      status,
      headers: error.retryAfter === null ? {} : { 'retry-after': String(error.retryAfter) },
    },
  );
}

export type ManagedFetchOptions = {
  client: ComposioClient;
  connectedAccountId: string;
  rules: readonly ProxyRule[];
  /** Counts one call against the installation's monthly count; never refuses one. */
  charge?: () => Promise<void>;
};

/** A `fetch` that sends each allowed request through Composio for one connected account. */
export function composioProxyFetch(options: ManagedFetchOptions): typeof fetch {
  const proxied = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (
      init.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase() as ProxyRule['method'];
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !options.rules.some(
        (allowed) =>
          allowed.method === method && allowed.host === url.host && allowed.path.test(url.pathname),
      )
    )
      throw new ManagedRequestRefused();
    let body: unknown;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') throw new ManagedRequestRefused();
      try {
        body = JSON.parse(init.body);
      } catch {
        throw new ManagedRequestRefused();
      }
    }
    const headers = new Headers(init.headers);
    const parameters: NonNullable<ComposioProxyRequest['parameters']> = [];
    for (const [name, value] of url.searchParams) parameters.push({ name, value, type: 'query' });
    for (const name of FORWARDED_HEADERS) {
      const value = headers.get(name);
      if (value !== null) parameters.push({ name, value, type: 'header' });
    }
    await options.charge?.().catch(() => {
      process.stderr.write('managed calls: a call could not be counted\n');
    });
    let answer: Awaited<ReturnType<ComposioClient['proxy']>>;
    try {
      answer = await options.client.proxy(
        {
          connectedAccountId: options.connectedAccountId,
          endpoint: `${url.origin}${url.pathname}`,
          method,
          ...(body === undefined ? {} : { body }),
          parameters,
        },
        init.signal ?? undefined,
      );
    } catch (error) {
      // Too large to take is what reading Google directly would have found:
      // each connector leaves such an answer out as it does natively.
      if (error instanceof ComposioFault && error.kind === 'too_large')
        throw new ResponseTooLarge();
      if (error instanceof ComposioFault) return faultResponse(error);
      throw error;
    }
    const retryAfter = answer.headers['retry-after'];
    const responseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    };
    // A status that carries no body is answered without one.
    if ([204, 205, 304].includes(answer.status))
      return new Response(null, { status: answer.status, headers: responseHeaders });
    return new Response(answer.data === null ? '' : JSON.stringify(answer.data), {
      status: answer.status,
      headers: responseHeaders,
    });
  };
  return proxied as typeof fetch;
}

/**
 * The access a native connector would hold, for a managed one: Composio signs
 * every request itself, so there is no token here to keep. When Google refuses
 * a request, the account is asked again: one Composio no longer holds active
 * ends the sign-in, as a refused refresh does on the native path.
 */
export function managedAccess(client: ComposioClient, connectedAccountId: string): SignedInAccess {
  const placeholder = 'managed';
  return {
    token: async () => placeholder,
    async renew() {
      let account: Awaited<ReturnType<ComposioClient['account']>>;
      try {
        account = await client.account(connectedAccountId);
      } catch (error) {
        if (error instanceof ComposioFault && error.kind === 'account_unavailable')
          throw new SignInEnded();
        throw error;
      }
      if (account.status !== 'ACTIVE' || account.disabled) throw new SignInEnded();
      return placeholder;
    },
  };
}

/** Keys that name an account at Composio. A tool's input never carries them. */
const AUTHORITY_KEYS = new Set(['connected_account_id', 'connectedaccountid', 'user_id', 'userid']);

/** Whether a tool's input names a Composio account or user anywhere in it. */
export function namesManagedAuthority(value: unknown, depth = 0): boolean {
  if (depth > 32 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => namesManagedAuthority(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) =>
      AUTHORITY_KEYS.has(key.toLowerCase().replace(/[-\s]/g, '_').replace(/_/g, '')) ||
      AUTHORITY_KEYS.has(key.toLowerCase()) ||
      namesManagedAuthority(item, depth + 1),
  );
}
