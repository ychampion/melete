/**
 * The mailbox a Google sign-in grants, over the Gmail API. It serves the same
 * email tools as IMAP and SMTP: the message is composed here exactly as it is
 * for SMTP, parsed with the same parser, and filtered by the same inbox
 * hygiene. Messages are addressed by Gmail's own id instead of an IMAP UID.
 */
import { simpleParser } from 'mailparser';
import {
  composeMail,
  type MailMessage,
  type MailTransport,
  type OutgoingMail,
  toMailMessage,
} from './mail-transport.ts';
import { bearerRequest, boundedJson, ResponseTooLarge, type SignedInAccess } from './signed-in.ts';

const MAX_MESSAGE_BYTES = 256 * 1024;
/** A raw message travels base64url-encoded inside JSON, a third larger than its bytes. */
const MAX_RAW_RESPONSE_BYTES = Math.ceil(MAX_MESSAGE_BYTES * 1.4) + 4096;
const MAX_LIST_RESPONSE_BYTES = 64 * 1024;
/** Gmail ids are short hexadecimal strings; anything else is refused before a request. */
export const GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Gmail may give a message sent through its API a Message-ID of its own, so
 * the action's id also travels in a header of ours, where a later check can
 * find it either way.
 */
const ACTION_HEADER = 'X-Melete-Message-Id';

/** A Gmail API failure with its status, so a caller can tell a refusal from an outage. */
export class GmailError extends Error {
  constructor(
    readonly status: number,
    readonly authenticationFailed = status === 401,
  ) {
    super(`gmail_${status}`);
  }
}

export class GmailApiTransport implements MailTransport {
  constructor(
    private readonly options: {
      /** `.../gmail/v1/users/me` */
      base: string;
      from: string;
      access: SignedInAccess;
      fetcher?: typeof fetch;
    },
  ) {}

  private async get(path: string, limit: number): Promise<unknown> {
    const response = await bearerRequest(
      this.options.access,
      `${this.options.base}${path}`,
      {},
      this.options.fetcher,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GmailError(response.status);
    }
    return boundedJson(response, limit);
  }

  private async ids(query: URLSearchParams): Promise<string[]> {
    const listed = (await this.get(`/messages?${query}`, MAX_LIST_RESPONSE_BYTES)) as {
      messages?: { id?: unknown }[];
    } | null;
    return (listed?.messages ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && GMAIL_MESSAGE_ID.test(id));
  }

  private async message(id: string): Promise<MailMessage | null> {
    if (!GMAIL_MESSAGE_ID.test(id)) return null;
    let body: { raw?: unknown; sizeEstimate?: unknown } | null;
    try {
      body = (await this.get(`/messages/${id}?format=raw`, MAX_RAW_RESPONSE_BYTES)) as typeof body;
    } catch (error) {
      // A message too large to filter safely is left out, as it is over IMAP.
      if (error instanceof ResponseTooLarge) return null;
      throw error;
    }
    if (!body || typeof body.raw !== 'string') return null;
    const source = Buffer.from(body.raw, 'base64url');
    if (source.length > MAX_MESSAGE_BYTES) return null;
    return toMailMessage(id, await simpleParser(source, { skipImageLinks: true }));
  }

  async search(query: string, limit: number): Promise<MailMessage[]> {
    const params = new URLSearchParams({ maxResults: String(limit), labelIds: 'INBOX' });
    if (query) params.set('q', query);
    const messages: MailMessage[] = [];
    for (const id of await this.ids(params)) {
      const message = await this.message(id);
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
    const response = await bearerRequest(
      this.options.access,
      `${this.options.base}/messages/send`,
      { method: 'POST', body: JSON.stringify({ raw: raw.toString('base64url') }) },
      this.options.fetcher,
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new GmailError(response.status);
    }
    const sent = (await boundedJson(response, MAX_LIST_RESPONSE_BYTES)) as {
      labelIds?: unknown;
    } | null;
    // Gmail files what its API sends under Sent itself.
    const labels = Array.isArray(sent?.labelIds) ? sent.labelIds : [];
    return { messageId: message.messageId, sentCopy: labels.includes('SENT') };
  }

  /** The exact Message-ID, or our header carrying it, on a message in Sent. */
  private async carries(id: string, messageId: string): Promise<boolean> {
    const params = new URLSearchParams({ format: 'metadata' });
    params.append('metadataHeaders', 'Message-ID');
    params.append('metadataHeaders', ACTION_HEADER);
    const found = (await this.get(`/messages/${id}?${params}`, MAX_LIST_RESPONSE_BYTES)) as {
      labelIds?: unknown;
      payload?: { headers?: { name?: unknown; value?: unknown }[] };
    } | null;
    if (!found || !Array.isArray(found.labelIds) || !found.labelIds.includes('SENT')) return false;
    return (found.payload?.headers ?? []).some(
      (header) =>
        typeof header.name === 'string' &&
        ['message-id', ACTION_HEADER.toLowerCase()].includes(header.name.toLowerCase()) &&
        header.value === messageId,
    );
  }

  async findSent(messageId: string): Promise<boolean> {
    const byId = await this.ids(
      new URLSearchParams({
        q: `in:sent rfc822msgid:${messageId.replace(/^<|>$/g, '')}`,
        maxResults: '5',
      }),
    );
    for (const id of byId) if (await this.carries(id, messageId)) return true;
    // Gmail's search matches its own Message-ID; our header is checked on recent mail instead.
    const recent = await this.ids(
      new URLSearchParams({ labelIds: 'SENT', q: 'newer_than:7d', maxResults: '50' }),
    );
    for (const id of recent)
      if (!byId.includes(id) && (await this.carries(id, messageId))) return true;
    return false;
  }

  async health(): Promise<void> {
    const profile = (await this.get('/profile', MAX_LIST_RESPONSE_BYTES)) as {
      emailAddress?: unknown;
    } | null;
    if (typeof profile?.emailAddress !== 'string') throw new Error('Gmail profile unavailable');
  }
}
