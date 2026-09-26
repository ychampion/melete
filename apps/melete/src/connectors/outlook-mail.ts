/**
 * The mailbox a Microsoft sign-in grants, over Microsoft Graph. It serves the
 * same email tools as IMAP and SMTP: messages are read as their MIME source
 * and parsed with the same parser and inbox hygiene, and outgoing mail is
 * composed exactly as it is for SMTP and handed to Graph as MIME. Messages are
 * addressed by Graph's own id.
 */
import { simpleParser } from 'mailparser';
import {
  composeMail,
  type MailMessage,
  type MailTransport,
  type OutgoingMail,
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

  async search(query: string, limit: number): Promise<MailMessage[]> {
    const params = new URLSearchParams({ $top: String(limit), $select: 'id' });
    // Graph orders a search by relevance and refuses $orderby with it.
    if (query) params.set('$search', `"${query.replaceAll('"', '')}"`);
    else params.set('$orderby', 'receivedDateTime desc');
    const messages: MailMessage[] = [];
    for (const entry of await this.list(`/mailFolders/inbox/messages?${params}`)) {
      if (typeof entry.id !== 'string') continue;
      const message = await this.message(entry.id);
      if (message) messages.push(message);
    }
    return messages;
  }

  async read(key: number | string): Promise<MailMessage | null> {
    return typeof key === 'string' ? this.message(key) : null;
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
