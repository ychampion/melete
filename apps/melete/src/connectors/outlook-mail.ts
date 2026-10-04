/**
 * The mailbox a Microsoft sign-in grants, over Microsoft Graph. It serves the
 * same email tools as IMAP and SMTP: messages are read as their MIME source
 * and parsed with the same parser and inbox hygiene, and outgoing mail is
 * composed exactly as it is for SMTP and handed to Graph as MIME. Messages are
 * addressed by Graph's own id.
 */
import { simpleParser } from 'mailparser';
import { sourceError } from '../signals/types.ts';
import {
  composeMail,
  headerBlock,
  headerMessage,
  MAX_HEADER_BYTES,
  type MailFolder,
  type MailMessage,
  type MailTransport,
  type OutgoingMail,
  RESYNC_DAYS,
  toMailMessage,
} from './mail-transport.ts';
import {
  bearerRequest,
  boundedBytes,
  boundedJson,
  ResponseTooLarge,
  type SignedInAccess,
} from './signed-in.ts';

const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_LIST_RESPONSE_BYTES = 256 * 1024;
/** Graph ids are URL-safe base64; anything else is refused before a request. */
export const GRAPH_MESSAGE_ID = /^[A-Za-z0-9=_-]{1,512}$/;
/** The action's id also travels in a header of ours, in case Graph replaces the Message-ID. */
const ACTION_HEADER = 'X-Melete-Message-Id';

/** A Graph failure with its status, so a caller can tell a refusal from an outage. */
export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly authenticationFailed = status === 401,
  ) {
    super(`graph_${status}`);
  }
}

/** An OData string literal: single quotes doubled. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export class OutlookMailTransport implements MailTransport {
  constructor(
    private readonly options: {
      /** `https://graph.microsoft.com/v1.0/me` */
      base: string;
      from: string;
      access: SignedInAccess;
      fetcher?: typeof fetch;
    },
  ) {}

  private request(
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) {
    return bearerRequest(
      this.options.access,
      `${this.options.base}${path}`,
      init,
      this.options.fetcher,
    );
  }

  private async json(path: string): Promise<unknown> {
    const response = await this.request(path);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GraphError(response.status);
    }
    return boundedJson(response, MAX_LIST_RESPONSE_BYTES);
  }

  private async list(path: string): Promise<Record<string, unknown>[]> {
    const answer = (await this.json(path)) as { value?: unknown } | null;
    return Array.isArray(answer?.value) ? (answer.value as Record<string, unknown>[]) : [];
  }

  private async message(id: string): Promise<MailMessage | null> {
    if (!GRAPH_MESSAGE_ID.test(id)) return null;
    const response = await this.request(`/messages/${encodeURIComponent(id)}/$value`);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GraphError(response.status);
    }
    let source: Buffer;
    try {
      source = await boundedBytes(response, MAX_MESSAGE_BYTES);
    } catch (error) {
      // A message too large to filter safely is left out, as it is over IMAP.
      if (error instanceof ResponseTooLarge) return null;
      throw error;
    }
    return toMailMessage(id, await simpleParser(source, { skipImageLinks: true }));
  }

  async search(query: string, limit: number, folder: MailFolder = 'inbox'): Promise<MailMessage[]> {
    const params = new URLSearchParams({ $top: String(limit), $select: 'id' });
    // Graph orders a search by relevance and refuses $orderby with it.
    if (query) params.set('$search', `"${query.replaceAll('"', '')}"`);
    else params.set('$orderby', 'receivedDateTime desc');
    const messages: MailMessage[] = [];
    const path = folder === 'sent' ? 'sentitems' : 'inbox';
    for (const entry of await this.list(`/mailFolders/${path}/messages?${params}`)) {
      if (typeof entry.id !== 'string') continue;
      const message = await this.message(entry.id);
      if (message) messages.push(message);
    }
    return messages;
  }

  async read(key: number | string): Promise<MailMessage | null> {
    return typeof key === 'string' ? this.message(key) : null;
  }

  /**
   * One message's headers, without its body. Mail from inside the same
   * organisation can come without its internet headers; then they are written
   * from the message's own fields.
   */
  private async headers(id: string): Promise<MailMessage | null> {
    if (!GRAPH_MESSAGE_ID.test(id)) return null;
    const params = new URLSearchParams({
      $select:
        'internetMessageHeaders,internetMessageId,from,toRecipients,ccRecipients,subject,receivedDateTime',
    });
    const response = await this.request(`/messages/${encodeURIComponent(id)}?${params}`);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GraphError(response.status);
    }
    let found: Record<string, unknown> | null;
    try {
      found = (await boundedJson(response, MAX_HEADER_BYTES)) as Record<string, unknown> | null;
    } catch (error) {
      if (error instanceof ResponseTooLarge) return null;
      throw error;
    }
    if (!found) return null;
    const given = (
      Array.isArray(found.internetMessageHeaders) ? found.internetMessageHeaders : []
    ).flatMap((header: { name?: unknown; value?: unknown }) =>
      typeof header.name === 'string' && typeof header.value === 'string'
        ? [{ name: header.name, value: header.value }]
        : [],
    );
    if (given.some((header) => header.name.toLowerCase() === 'from'))
      return headerMessage(id, headerBlock(given));
    const address = (entry: unknown) => {
      const email = (entry as { emailAddress?: { name?: unknown; address?: unknown } })
        ?.emailAddress;
      if (typeof email?.address !== 'string') return null;
      const name = typeof email.name === 'string' ? email.name.replaceAll('"', '') : '';
      return name ? `"${name}" <${email.address}>` : email.address;
    };
    const list = (value: unknown) =>
      (Array.isArray(value) ? value : []).map(address).filter(Boolean).join(', ');
    const written = [
      { name: 'From', value: address(found.from) ?? '' },
      { name: 'To', value: list(found.toRecipients) },
      { name: 'Cc', value: list(found.ccRecipients) },
      { name: 'Subject', value: typeof found.subject === 'string' ? found.subject : '' },
      {
        name: 'Message-ID',
        value: typeof found.internetMessageId === 'string' ? found.internetMessageId : '',
      },
      {
        name: 'Date',
        value:
          typeof found.receivedDateTime === 'string'
            ? new Date(found.receivedDateTime).toUTCString()
            : '',
      },
    ].filter((header) => header.value);
    return headerMessage(id, headerBlock(written));
  }

  /**
   * What arrived in the inbox since the cursor, read from Graph's delta of the
   * inbox. The cursor holds the next or delta link Graph gave, and the time
   * watching began: the first pass through the delta lists every message the
   * inbox holds, and only those received since then are news. A delta link
   * Graph no longer honours (410) starts the delta again, and messages already
   * delivered are skipped by their id.
   */
  async changes(
    cursor: string | null,
    options: { limit: number; seen?: (key: string) => Promise<boolean>; now?: number },
  ) {
    // The delta starts at the time watching began, not at the start of the
    // inbox, so a large inbox is not walked before the first news.
    const start = (since: string) =>
      `${this.options.base}/mailFolders/inbox/messages/delta?${new URLSearchParams({
        $select: 'id,receivedDateTime',
        $filter: `receivedDateTime ge ${new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')}`,
      })}`;
    const began = new Date(options.now ?? Date.now()).toISOString();
    let state: { link: string; since: string };
    try {
      const parsed = cursor ? (JSON.parse(cursor) as { link?: unknown; since?: unknown }) : null;
      state =
        parsed &&
        typeof parsed.link === 'string' &&
        parsed.link.startsWith(`${this.options.base}/`) &&
        typeof parsed.since === 'string' &&
        !Number.isNaN(Date.parse(parsed.since))
          ? { link: parsed.link, since: parsed.since }
          : { link: start(began), since: began };
    } catch {
      state = { link: start(began), since: began };
    }
    const since = Date.parse(state.since);
    const ids: string[] = [];
    let link = state.link;
    for (let page = 0; page < 10; page++) {
      const response = await bearerRequest(
        this.options.access,
        link,
        { headers: { prefer: 'odata.maxpagesize=50' } },
        this.options.fetcher,
      );
      if (response.status === 410) {
        await response.body?.cancel().catch(() => {});
        // Read again from no further back than RESYNC_DAYS: what came before
        // was read already, and its keys outlive it.
        link = start(
          new Date(
            Math.max(
              Date.parse(state.since),
              (options.now ?? Date.now()) - RESYNC_DAYS * 86_400_000,
            ),
          ).toISOString(),
        );
        continue;
      }
      if (!response.ok) throw await sourceError(response);
      const body = (await boundedJson(response, MAX_LIST_RESPONSE_BYTES)) as {
        value?: Record<string, unknown>[];
        '@odata.nextLink'?: unknown;
        '@odata.deltaLink'?: unknown;
      } | null;
      for (const entry of body?.value ?? []) {
        if (entry['@removed'] || typeof entry.id !== 'string') continue;
        const received = Date.parse(String(entry.receivedDateTime ?? ''));
        if (Number.isNaN(received) || received < since) continue;
        ids.push(entry.id);
      }
      const delta = body?.['@odata.deltaLink'];
      const following = body?.['@odata.nextLink'];
      const valid = (value: unknown): value is string =>
        typeof value === 'string' && value.startsWith(`${this.options.base}/`);
      if (valid(delta)) {
        link = delta;
        break;
      }
      if (!valid(following)) break;
      link = following;
      if (ids.length >= options.limit) break;
    }
    const messages: (MailMessage & { key: string; read_key: string })[] = [];
    for (const id of [...new Set(ids)]) {
      const key = `graph:${id}`;
      if (await options.seen?.(key)) continue;
      const message = await this.headers(id);
      if (message) messages.push({ ...message, key, read_key: id });
    }
    return { cursor: JSON.stringify({ link, since: state.since }), messages };
  }

  async send(
    message: OutgoingMail,
  ): Promise<{ messageId: string; sentCopy: boolean; accepted?: string[]; rejected?: string[] }> {
    const raw = await composeMail(this.options.from, message, {
      [ACTION_HEADER]: message.messageId,
    });
    const response = await this.request('/sendMail', {
      method: 'POST',
      body: raw.toString('base64'),
      headers: { 'content-type': 'text/plain' },
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 202 && !response.ok) throw new GraphError(response.status);
    let sentCopy = false;
    try {
      // Graph saves what it sends in Sent Items; acceptance already proves the send.
      sentCopy = await this.findSent(message.messageId);
    } catch {
      sentCopy = false;
    }
    return { messageId: message.messageId, sentCopy };
  }

  async findSent(messageId: string): Promise<boolean> {
    const exact = new URLSearchParams({
      $filter: `internetMessageId eq ${literal(messageId)}`,
      $select: 'id,internetMessageId',
      $top: '5',
    });
    const found = await this.list(`/mailFolders/sentitems/messages?${exact}`);
    if (found.some((entry) => entry.internetMessageId === messageId)) return true;
    // Graph may have given the message a Message-ID of its own; our header still names it.
    const recent = new URLSearchParams({
      $select: 'id,internetMessageHeaders',
      $orderby: 'sentDateTime desc',
      $top: '50',
    });
    return (await this.list(`/mailFolders/sentitems/messages?${recent}`)).some((entry) =>
      (Array.isArray(entry.internetMessageHeaders) ? entry.internetMessageHeaders : []).some(
        (header: { name?: unknown; value?: unknown }) =>
          typeof header.name === 'string' &&
          header.name.toLowerCase() === ACTION_HEADER.toLowerCase() &&
          header.value === messageId,
      ),
    );
  }

  async health(): Promise<void> {
    const inbox = (await this.json('/mailFolders/inbox?$select=id')) as { id?: unknown } | null;
    if (typeof inbox?.id !== 'string') throw new Error('Outlook inbox unavailable');
  }
}
