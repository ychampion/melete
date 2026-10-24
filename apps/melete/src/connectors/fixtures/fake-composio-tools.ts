/**
 * Composio's Gmail, Google Calendar and Google Drive tools, for the fake
 * Composio: each one is the Google API request it stands for, sent to the
 * account's upstream (usually `fake-google.ts`), and answered in the shape
 * Composio's tool schemas give. A Google error comes back as a failed tool
 * with Google's status in its message, as Composio reports it.
 */
import type { FakeAppTool, Upstream } from './fake-composio.ts';

export type ToolAnswer = { ok: true; data: unknown } | { ok: false; error: string };

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CALENDAR = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const DRIVE = 'https://www.googleapis.com/drive/v3';

type Call = (
  path: string,
  init?: {
    method?: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
  },
) => Promise<{ status: number; body: unknown; ok: boolean }>;

function caller(upstream: Upstream): Call {
  return async (address, init = {}) => {
    const url = new URL(address);
    for (const [name, value] of Object.entries(init.query ?? {})) {
      if (value === undefined || value === null) continue;
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(name, String(item));
    }
    const response = await upstream(url, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body, ok: response.ok };
  };
}

const failed = (status: number): ToolAnswer => ({
  ok: false,
  error: `Request failed with status ${status}${status === 404 ? ' Not Found' : ''}`,
});

/** Headers of a raw message, as Gmail's metadata answer lists them. */
function headersOf(raw: string): { name: string; value: string }[] {
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const block = text.split(/\r?\n\r?\n/, 1)[0] ?? '';
  return block
    .replace(/\r?\n[ \t]+/g, ' ')
    .split(/\r?\n/)
    .flatMap((line) => {
      const at = line.indexOf(':');
      return at > 0 ? [{ name: line.slice(0, at), value: line.slice(at + 1).trim() }] : [];
    });
}

/** A plain message from the send tool's fields, as Gmail sends it. */
function composed(args: Record<string, unknown>): string {
  const to = [args.recipient_email, ...((args.extra_recipients as string[] | undefined) ?? [])]
    .filter((address): address is string => typeof address === 'string')
    .join(', ');
  const list = (value: unknown) => (Array.isArray(value) ? value.join(', ') : '');
  const lines = [
    `To: ${to}`,
    ...(list(args.cc) ? [`Cc: ${list(args.cc)}`] : []),
    ...(list(args.bcc) ? [`Bcc: ${list(args.bcc)}`] : []),
    `Subject: ${String(args.subject ?? '')}`,
    `Content-Type: ${args.is_html ? 'text/html' : 'text/plain'}; charset=utf-8`,
  ];
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${String(args.body ?? '')}`).toString(
    'base64url',
  );
}

/** Adds every Google tool the managed connectors use. */
export function addGoogleTools(
  tools: Map<string, FakeAppTool>,
  upstreamOf: (account: string) => Upstream | undefined,
): void {
  const add = (
    slug: string,
    toolkit: string,
    readOnly: boolean,
    run: (call: Call, args: Record<string, unknown>) => Promise<ToolAnswer>,
  ) =>
    tools.set(slug, {
      slug,
      toolkit,
      description: slug.toLowerCase().replace(/_/g, ' '),
      readOnly,
      run: async (args, account) => {
        const upstream = upstreamOf(account);
        if (!upstream) return { ok: false, error: 'no upstream' };
        return run(caller(upstream), args);
      },
    });
  const passthrough = async (
    reply: Promise<{ status: number; body: unknown; ok: boolean }>,
    shape: (body: unknown) => unknown = (body) => body,
  ): Promise<ToolAnswer> => {
    const answer = await reply;
    return answer.ok ? { ok: true, data: shape(answer.body) } : failed(answer.status);
  };

  add('GMAIL_GET_PROFILE', 'gmail', true, (call) => passthrough(call(`${GMAIL}/profile`)));
  add('GMAIL_LIST_HISTORY', 'gmail', true, (call, args) =>
    passthrough(
      call(`${GMAIL}/history`, {
        query: {
          startHistoryId: args.start_history_id,
          historyTypes: args.history_types,
          labelId: args.label_id,
          maxResults: args.max_results,
          pageToken: args.page_token,
        },
      }),
    ),
  );
  add('GMAIL_FETCH_EMAILS', 'gmail', true, (call, args) =>
    passthrough(
      call(`${GMAIL}/messages`, {
        query: {
          q: args.query,
          labelIds: args.label_ids,
          maxResults: args.max_results,
          pageToken: args.page_token,
        },
      }),
      // Composio names each message's id `messageId`.
      (body) => {
        const listed = (body ?? {}) as { messages?: { id: string; threadId?: string }[] };
        return {
          messages: (listed.messages ?? []).map((message) => ({
            messageId: message.id,
            threadId: message.threadId,
          })),
        };
      },
    ),
  );
  add('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', 'gmail', true, async (call, args) => {
    const at = `${GMAIL}/messages/${String(args.message_id)}`;
    const format = typeof args.format === 'string' ? args.format : 'full';
    let answer = await call(at, { query: { format } });
    if (!answer.ok) return failed(answer.status);
    let message = answer.body as {
      id: string;
      threadId?: string;
      labelIds?: string[];
      raw?: string;
      sizeEstimate?: number;
      payload?: { headers?: { name: string; value: string }[] };
    };
    // Composio's metadata answer carries every header; an upstream that lists
    // only those asked for is read whole instead, and its headers taken.
    if (format === 'metadata' && !message.payload?.headers?.length) {
      answer = await call(at, { query: { format: 'raw' } });
      if (!answer.ok) return failed(answer.status);
      const whole = answer.body as typeof message;
      message = {
        ...whole,
        payload: { headers: whole.raw ? headersOf(whole.raw) : [] },
        raw: undefined,
      };
    }
    // Composio names the message's id `messageId`.
    const { id, raw, ...rest } = message;
    return {
      ok: true,
      data: { ...rest, messageId: id, ...(format === 'raw' && raw !== undefined ? { raw } : {}) },
    };
  });
  add('GMAIL_SEND_EMAIL', 'gmail', false, (call, args) =>
    passthrough(call(`${GMAIL}/messages/send`, { method: 'POST', body: { raw: composed(args) } })),
  );

  add('GOOGLECALENDAR_GET_CALENDAR', 'googlecalendar', true, (call) =>
    passthrough(call(CALENDAR), (body) => ({ calendar_data: body })),
  );
  add('GOOGLECALENDAR_EVENTS_LIST', 'googlecalendar', true, (call, args) => {
    const { calendarId: _calendar, ...query } = args;
    return passthrough(call(`${CALENDAR}/events`, { query }));
  });
  add('GOOGLECALENDAR_EVENTS_GET', 'googlecalendar', true, (call, args) =>
    passthrough(call(`${CALENDAR}/events/${String(args.event_id)}`)),
  );
  add('GOOGLECALENDAR_BATCH_EVENTS', 'googlecalendar', false, async (call, args) => {
    const results = [];
    for (const op of (args.operations ?? []) as {
      op_id: string;
      method: string;
      event_id?: string;
      body?: Record<string, unknown>;
      query_params?: Record<string, unknown>;
    }[]) {
      const at = `${CALENDAR}/events${op.event_id ? `/${op.event_id}` : ''}`;
      let answer: { status: number; body: unknown; ok: boolean };
      if (op.method === 'POST')
        answer = await call(at, {
          method: 'POST',
          body: op.body ?? {},
          query: op.query_params ?? {},
        });
      else {
        // Google's PATCH and DELETE need no precondition; the fake takes the current etag.
        const current = await call(at);
        const etag = (current.body as { etag?: string } | null)?.etag ?? '';
        answer = !current.ok
          ? current
          : op.method === 'DELETE'
            ? await call(at, { method: 'DELETE', headers: { 'if-match': etag } })
            : await call(at, {
                method: 'PUT',
                headers: { 'if-match': etag },
                body: { ...(current.body as object), ...op.body },
              });
      }
      results.push({
        op_id: op.op_id,
        http_status: answer.status,
        ...(answer.ok ? { event: answer.body } : { error: answer.body }),
      });
    }
    return { ok: true, data: { results } };
  });

  add('GOOGLEDRIVE_GET_ABOUT', 'googledrive', true, (call, args) =>
    passthrough(call(`${DRIVE}/about`, { query: { fields: args.fields } })),
  );
  add('GOOGLEDRIVE_GET_CHANGES_START_PAGE_TOKEN', 'googledrive', true, (call, args) =>
    passthrough(call(`${DRIVE}/changes/startPageToken`, { query: args })),
  );
  add('GOOGLEDRIVE_LIST_CHANGES', 'googledrive', true, (call, args) =>
    passthrough(call(`${DRIVE}/changes`, { query: args })),
  );
  add('GOOGLEDRIVE_GET_FILE_METADATA', 'googledrive', true, (call, args) => {
    const { fileId, ...query } = args;
    return passthrough(call(`${DRIVE}/files/${String(fileId)}`, { query }));
  });
}
