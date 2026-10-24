/**
 * The managed transport under Melete's own Gmail, Google Calendar and Google
 * Drive connectors. Each connector already takes a `fetcher`; this one turns a
 * `fetch` of a Google API address into one Composio tool run for the
 * connection's own connected account (`GMAIL_LIST_HISTORY` for the mailbox's
 * history, `GOOGLECALENDAR_EVENTS_LIST` for a page of events, ...), and hands
 * back an ordinary `Response` in Google's own shape. Every parser, cursor,
 * fault class and signal the native path has is therefore the managed path's
 * too, and each request is one plain tool call at Composio: nothing here uses
 * Composio's proxy, which it bills on top.
 *
 * Which account a call acts for comes only from the connection row, bound
 * when the connector is built: nothing in a request, a tool's input or an
 * answer can name another. A fetcher allows only the requests on its list, so
 * the one the signal poller reads through cannot send, and only the agent's
 * own dispatch holds the one that can.
 */
import { simpleParser } from 'mailparser';
import type { ComposioClient } from './composio.ts';
import { ComposioFault, type ComposioToolResult } from './composio.ts';
import type { ComposioRunner } from './composio-sessions.ts';
import { ResponseTooLarge, type SignedInAccess, SignInEnded } from './signed-in.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** What one allowed request becomes: a tool, its arguments, and how its answer reads as Google's. */
type Translation = {
  tool: string;
  args: Record<string, unknown>;
  /** Google's status and body, from the tool's data. */
  answer?: (data: unknown) => { status: number; body: unknown };
};

/** One request a fetcher allows: a method, a host, a path at that host, and the tool it runs. */
export type ManagedRule = {
  method: Method;
  host: string;
  path: RegExp;
  translate: (request: {
    url: URL;
    match: RegExpExecArray;
    body: unknown;
  }) => Translation | Promise<Translation>;
};

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
const SEGMENT = '([A-Za-z0-9_-]{1,1024})';

const rule = (
  method: Method,
  host: string,
  path: string,
  translate: ManagedRule['translate'],
): ManagedRule => ({ method, host, path: new RegExp(`^${path}$`), translate });

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The query's parameters as tool arguments: booleans and numbers as such, repeated ones as lists. */
function params(
  url: URL,
  names: Record<string, { as: string; type?: 'boolean' | 'number' | 'list' }>,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(names)) {
    const values = url.searchParams.getAll(name);
    if (!values.length) continue;
    const value = values[0] ?? '';
    args[spec.as] =
      spec.type === 'boolean'
        ? value === 'true'
        : spec.type === 'number'
          ? Number(value)
          : spec.type === 'list'
            ? values.flatMap((item) => item.split(',')).filter(Boolean)
            : value;
  }
  return args;
}

const ok = (body: unknown) => ({ status: 200, body });

/** A Gmail message as Google's API answers it, from Composio's message. */
function gmailMessage(format: string) {
  return (data: unknown) => {
    const message = record(data) ?? {};
    const id = message.id ?? message.messageId;
    const payload = record(message.payload);
    let raw = typeof message.raw === 'string' ? message.raw : undefined;
    // Asked for the whole message and given its parts: written back as one plain message.
    if (format === 'raw' && raw === undefined) raw = rebuiltRaw(payload, message);
    return ok({
      id,
      threadId: message.threadId,
      labelIds: Array.isArray(message.labelIds) ? message.labelIds : [],
      ...(payload ? { payload } : {}),
      ...(raw === undefined ? {} : { raw }),
      ...(message.sizeEstimate === undefined ? {} : { sizeEstimate: message.sizeEstimate }),
    });
  };
}

/** A message's headers and text as one RFC 5322 message, base64url-encoded. */
function rebuiltRaw(
  payload: Record<string, unknown> | null,
  message: Record<string, unknown>,
): string | undefined {
  const headers = (Array.isArray(payload?.headers) ? payload.headers : [])
    .map((header) => record(header))
    .filter(
      (header): header is { name: string; value: string } =>
        typeof header?.name === 'string' &&
        typeof header.value === 'string' &&
        !/[\r\n]/.test(header.name + header.value) &&
        !/^content-(type|transfer-encoding)$/i.test(header.name),
    );
  if (!headers.length) return undefined;
  const text = typeof message.messageText === 'string' ? message.messageText : '';
  const block = [
    ...headers.map((header) => `${header.name}: ${header.value}`),
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ].join('\r\n');
  return Buffer.from(`${block}\r\n\r\n${text}`, 'utf8').toString('base64url');
}

/** Addresses of one header of a parsed message. */
function addresses(value: unknown): string[] {
  const groups = Array.isArray(value) ? value : value ? [value] : [];
  return groups.flatMap(
    (group) =>
      (record(group)?.value as { address?: unknown }[] | undefined)?.flatMap((entry) =>
        typeof entry.address === 'string' ? [entry.address] : [],
      ) ?? [],
  );
}

/** A message Melete composed, sent as Gmail's send tool takes it. */
async function gmailSend(body: unknown): Promise<Translation> {
  const raw = record(body)?.raw;
  if (typeof raw !== 'string') throw new ManagedRequestRefused();
  const parsed = await simpleParser(Buffer.from(raw, 'base64url'), { skipImageLinks: true });
  // Composio's send tool takes files only from its own storage, which Melete does not use.
  if (parsed.attachments.length) throw new ManagedRequestRefused();
  const to = addresses(parsed.to);
  const html = typeof parsed.html === 'string' ? parsed.html : null;
  return {
    tool: 'GMAIL_SEND_EMAIL',
    args: {
      user_id: 'me',
      ...(to[0] ? { recipient_email: to[0] } : {}),
      ...(to.length > 1 ? { extra_recipients: to.slice(1) } : {}),
      cc: addresses(parsed.cc),
      bcc: addresses(parsed.bcc),
      subject: parsed.subject ?? '',
      body: html ?? parsed.text ?? '',
      is_html: html !== null,
    },
    answer: (data) => {
      const sent = record(data) ?? {};
      return ok({ id: sent.id, labelIds: Array.isArray(sent.labelIds) ? sent.labelIds : ['SENT'] });
    },
  };
}

/** One event write, as Google Calendar's batch tool takes it: the event's own JSON, unchanged. */
function calendarWrite(method: 'POST' | 'PATCH' | 'DELETE') {
  return ({ url, match, body }: { url: URL; match: RegExpExecArray; body: unknown }) => {
    const event = record(body);
    const query = params(url, { sendUpdates: { as: 'sendUpdates' } });
    return {
      tool: 'GOOGLECALENDAR_BATCH_EVENTS',
      args: {
        fail_fast: true,
        operations: [
          {
            op_id: 'melete',
            method,
            calendar_id: 'primary',
            ...(match[1] ? { event_id: match[1] } : {}),
            // A whole-event write leaves no guest behind that it does not name.
            ...(event ? { body: method === 'PATCH' ? { attendees: [], ...event } : event } : {}),
            ...(Object.keys(query).length ? { query_params: query } : {}),
          },
        ],
      },
      answer: (data: unknown) => {
        const results = record(data)?.results;
        const first = record(Array.isArray(results) ? results[0] : null);
        const status = Number(first?.http_status);
        if (!first || !Number.isInteger(status) || status < 100 || status > 599)
          return { status: 502, body: { error: { code: 502 } } };
        return { status, body: first.event ?? first.error ?? null };
      },
    };
  };
}

/** What reading an account needs, by what the connection is. Never a write. */
export const MANAGED_READS = {
  mail: [
    rule('GET', GMAIL, `${MAILBOX}/profile`, () => ({
      tool: 'GMAIL_GET_PROFILE',
      args: { user_id: 'me' },
    })),
    rule('GET', GMAIL, `${MAILBOX}/history`, ({ url }) => ({
      tool: 'GMAIL_LIST_HISTORY',
      args: {
        user_id: 'me',
        ...params(url, {
          startHistoryId: { as: 'start_history_id' },
          historyTypes: { as: 'history_types', type: 'list' },
          labelId: { as: 'label_id' },
          maxResults: { as: 'max_results', type: 'number' },
          pageToken: { as: 'page_token' },
        }),
      },
    })),
    rule('GET', GMAIL, `${MAILBOX}/messages`, ({ url }) => ({
      tool: 'GMAIL_FETCH_EMAILS',
      args: {
        user_id: 'me',
        ids_only: true,
        ...params(url, {
          q: { as: 'query' },
          labelIds: { as: 'label_ids', type: 'list' },
          maxResults: { as: 'max_results', type: 'number' },
          pageToken: { as: 'page_token' },
        }),
      },
      answer: (data) => {
        const listed = record(data) ?? {};
        const messages = (Array.isArray(listed.messages) ? listed.messages : []).flatMap((raw) => {
          const message = record(raw);
          const id = message?.id ?? message?.messageId;
          return typeof id === 'string' ? [{ id, threadId: message?.threadId }] : [];
        });
        return ok({
          messages,
          ...(listed.nextPageToken ? { nextPageToken: listed.nextPageToken } : {}),
        });
      },
    })),
    rule('GET', GMAIL, `${MAILBOX}/messages/${SEGMENT}`, ({ url, match }) => {
      const format = url.searchParams.get('format') ?? 'full';
      return {
        tool: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
        args: { user_id: 'me', message_id: match[1], format },
        answer: gmailMessage(format),
      };
    }),
  ],
  calendar: [
    rule('GET', GOOGLE_APIS, CALENDAR, () => ({
      tool: 'GOOGLECALENDAR_GET_CALENDAR',
      args: { calendar_id: 'primary' },
      answer: (data) => ok(record(data)?.calendar_data ?? data),
    })),
    rule('GET', GOOGLE_APIS, `${CALENDAR}/events`, ({ url }) => ({
      tool: 'GOOGLECALENDAR_EVENTS_LIST',
      args: {
        calendarId: 'primary',
        ...params(url, {
          singleEvents: { as: 'singleEvents', type: 'boolean' },
          showDeleted: { as: 'showDeleted', type: 'boolean' },
          orderBy: { as: 'orderBy' },
          timeMin: { as: 'timeMin' },
          timeMax: { as: 'timeMax' },
          maxResults: { as: 'maxResults', type: 'number' },
          pageToken: { as: 'pageToken' },
          syncToken: { as: 'syncToken' },
        }),
      },
    })),
    rule('GET', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`, ({ match }) => ({
      tool: 'GOOGLECALENDAR_EVENTS_GET',
      args: { calendar_id: 'primary', event_id: match[1] },
    })),
  ],
  documents: [
    rule('GET', GOOGLE_APIS, `${DRIVE}/about`, ({ url }) => ({
      tool: 'GOOGLEDRIVE_GET_ABOUT',
      args: params(url, { fields: { as: 'fields' } }),
    })),
    rule('GET', GOOGLE_APIS, `${DRIVE}/changes`, ({ url }) => ({
      tool: 'GOOGLEDRIVE_LIST_CHANGES',
      args: params(url, {
        pageToken: { as: 'pageToken' },
        pageSize: { as: 'pageSize', type: 'number' },
        includeRemoved: { as: 'includeRemoved', type: 'boolean' },
        supportsAllDrives: { as: 'supportsAllDrives', type: 'boolean' },
        includeItemsFromAllDrives: { as: 'includeItemsFromAllDrives', type: 'boolean' },
        fields: { as: 'fields' },
      }),
    })),
    rule('GET', GOOGLE_APIS, `${DRIVE}/changes/startPageToken`, ({ url }) => ({
      tool: 'GOOGLEDRIVE_GET_CHANGES_START_PAGE_TOKEN',
      args: params(url, { supportsAllDrives: { as: 'supportsAllDrives', type: 'boolean' } }),
    })),
    rule('GET', GOOGLE_APIS, `${DRIVE}/files/${SEGMENT}`, ({ url, match }) => ({
      tool: 'GOOGLEDRIVE_GET_FILE_METADATA',
      args: {
        fileId: match[1],
        ...params(url, {
          fields: { as: 'fields' },
          supportsAllDrives: { as: 'supportsAllDrives', type: 'boolean' },
        }),
      },
    })),
  ],
} as const satisfies Record<string, ManagedRule[]>;

/** What the agent's tools may also do, each after the approval the tool asks for. */
export const MANAGED_WRITES = {
  mail: [
    ...MANAGED_READS.mail,
    rule('POST', GMAIL, `${MAILBOX}/messages/send`, ({ body }) => gmailSend(body)),
  ],
  calendar: [
    ...MANAGED_READS.calendar,
    rule('POST', GOOGLE_APIS, `${CALENDAR}/events`, calendarWrite('POST')),
    rule('PUT', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`, calendarWrite('PATCH')),
    rule('DELETE', GOOGLE_APIS, `${CALENDAR}/events/${SEGMENT}`, calendarWrite('DELETE')),
  ],
  // A Drive connection only ever reads metadata.
  documents: [...MANAGED_READS.documents],
} as const satisfies Record<string, ManagedRule[]>;

/** The toolkit each part's tools belong to. */
export const MANAGED_TOOLKITS = {
  mail: 'gmail',
  calendar: 'googlecalendar',
  documents: 'googledrive',
} as const;

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

/**
 * The status Google answered a failed tool with, as far as its error says:
 * gone, refused, slowed or not allowed. Anything else is a bad gateway, which
 * every connector reads as trouble at the provider rather than a refusal.
 */
export function failedStatus(error: string | null): number {
  const said = error ?? '';
  if (/\b404\b|not ?found/i.test(said)) return 404;
  if (/\b410\b|\bgone\b/i.test(said)) return 410;
  if (/\b412\b|precondition/i.test(said)) return 412;
  if (/\b401\b|unauthori[sz]ed|invalid.?credentials|invalid_grant/i.test(said)) return 401;
  if (/\b429\b|rate.?limit|quota/i.test(said)) return 429;
  if (/\b403\b|forbidden|insufficient.?permission/i.test(said)) return 403;
  if (/\b400\b|invalid/i.test(said)) return 400;
  return 502;
}

export type ManagedFetchOptions = {
  runner: ComposioRunner;
  connectedAccountId: string;
  toolkit: string;
  rules: readonly ManagedRule[];
};

/** A `fetch` that runs one Composio tool for each allowed request, for one connected account. */
export function composioToolFetch(options: ManagedFetchOptions): typeof fetch {
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (
      init.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase() as Method;
    if (url.protocol !== 'https:' || url.username || url.password || url.port)
      throw new ManagedRequestRefused();
    let match: RegExpExecArray | null = null;
    const found = options.rules.find((allowed) => {
      if (allowed.method !== method || allowed.host !== url.host) return false;
      match = allowed.path.exec(url.pathname);
      return match !== null;
    });
    if (!found || !match) throw new ManagedRequestRefused();
    let body: unknown;
    if (init.body !== undefined && init.body !== null) {
      if (typeof init.body !== 'string') throw new ManagedRequestRefused();
      try {
        body = JSON.parse(init.body);
      } catch {
        throw new ManagedRequestRefused();
      }
    }
    const translation = await found.translate({ url, match, body });
    let result: ComposioToolResult;
    try {
      result = await options.runner.run({
        connectedAccountId: options.connectedAccountId,
        toolkit: options.toolkit,
        tool: translation.tool,
        args: translation.args,
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (error) {
      // An answer too large to take is what a connector reading Google directly would refuse too.
      if (error instanceof ComposioFault && error.kind === 'too_large')
        throw new ResponseTooLarge();
      if (error instanceof ComposioFault) return faultResponse(error);
      throw error;
    }
    if (!result.ok) {
      const status = failedStatus(result.error);
      return Response.json({ error: { code: status } }, { status });
    }
    const answered = translation.answer?.(result.data) ?? ok(result.data);
    const headers = { 'content-type': 'application/json' };
    // A status that carries no body is answered without one.
    if ([204, 205, 304].includes(answered.status))
      return new Response(null, { status: answered.status, headers });
    return new Response(answered.body === null ? '' : JSON.stringify(answered.body), {
      status: answered.status,
      headers,
    });
  };
  return fetcher as typeof fetch;
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
