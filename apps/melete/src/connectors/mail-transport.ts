import { ImapFlow } from 'imapflow';
import { type AddressObject, type EmailAddress, type ParsedMail, simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

export type EmailConnection = {
  id: string;
  spaceId: string;
  secretRef: string;
  username: string;
  from: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  inbox?: string;
  sent?: string;
  /** Disabled by default; only explicitly configured loopback test servers may use plaintext. */
  allowInsecureLocalForTests?: boolean;
};

export type MailMessage = {
  /** An IMAP message's UID in the inbox. */
  uid?: number;
  /** A message addressed by an opaque id instead, as the Gmail API does. */
  id?: string;
  message_id: string | null;
  from: string;
  /** The sender's addresses as the parser read them; see `toMailMessage`. */
  from_addresses?: string[];
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The Date header as an ISO instant, when the message carried a usable one. */
  date?: string | null;
  /** Every To and Cc address as the parser read them, lowercased. */
  to_addresses?: string[];
  /** The Message-ID this message answers, from In-Reply-To. */
  in_reply_to?: string | null;
  /** The thread's Message-IDs, from References. */
  references?: string[];
  /**
   * A list, bulk or auto-submitted message: List-Unsubscribe, List-Id,
   * Auto-Submitted other than `no`, or Precedence bulk, list or junk.
   */
  automated?: boolean;
};

/**
 * A parsed message in the shape the connector hands out. `from` is mailparser's
 * rendering of the header, for people; `from_addresses` is its parsed address
 * list, for code. A decoded display name can hold anything, including text
 * that looks like another address, and the rendering does not escape it, so
 * nothing that decides who sent a message may re-parse `from`.
 */
export function toMailMessage(key: number | string, parsed: ParsedMail): MailMessage {
  const to = parsed.to
    ? Array.isArray(parsed.to)
      ? parsed.to.map((v) => v.text).join(', ')
      : parsed.to.text
    : '';
  return {
    ...(typeof key === 'number' ? { uid: key } : { id: key }),
    message_id: parsed.messageId ?? null,
    from: parsed.from?.text ?? '',
    // A message with two From headers names two senders, and the parser keeps
    // only one of them. Which one is not something to decide on, so it has none.
    from_addresses:
      parsed.headerLines.filter((line) => line.key === 'from').length > 1
        ? []
        : addressesOf(parsed.from),
    to,
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    // A message nobody can date cannot be placed in a time window, so an
    // unparseable Date header is absent rather than guessed at.
    date:
      parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
        ? parsed.date.toISOString()
        : null,
    to_addresses: [...addressesOf(parsed.to), ...addressesOf(parsed.cc)],
    in_reply_to: typeof parsed.inReplyTo === 'string' ? parsed.inReplyTo : null,
    references: Array.isArray(parsed.references)
      ? parsed.references
      : typeof parsed.references === 'string'
        ? parsed.references.split(/\s+/).filter(Boolean)
        : [],
    automated: automatedMail(parsed),
  };
}

/** Whether nobody wrote this message to one person: a list, bulk or robot's mail. */
function automatedMail(parsed: ParsedMail): boolean {
  const header = (name: string) => {
    const value = parsed.headers.get(name);
    return typeof value === 'string' ? value.trim().toLowerCase() : value ? 'present' : '';
  };
  const auto = header('auto-submitted');
  // The parser gathers every List-* header into one `list` entry.
  const list = parsed.headers.get('list');
  const listed =
    list !== null && typeof list === 'object' && ('unsubscribe' in list || 'id' in list);
  return (
    listed ||
    (auto !== '' && auto !== 'no') ||
    ['bulk', 'list', 'junk'].includes(header('precedence'))
  );
}

/** Every address in a parsed header, groups included, lowercased. */
function addressesOf(header: AddressObject | AddressObject[] | undefined): string[] {
  const out: string[] = [];
  const walk = (entries: EmailAddress[]) => {
    for (const entry of entries) {
      if (entry.group) walk(entry.group);
      else if (entry.address) out.push(entry.address.toLowerCase());
    }
  };
  for (const object of header ? (Array.isArray(header) ? header : [header]) : [])
    walk(object.value);
  return out;
}

/**
 * One attachment, already read by trusted service code from a recorded
 * artifact. The bytes never come from a payload: a model names an artifact and
 * the service reads the file it recorded, so an approval that was given over a
 * file is spent on that file.
 */
export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

export type OutgoingMail = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  messageId: string;
  attachments?: MailAttachment[];
};

/** The folders a search can read: where mail arrives, and where the person's own goes. */
export type MailFolder = 'inbox' | 'sent';

/**
 * A message read from its headers alone. Signals never need a body, so none is
 * fetched: the header block is parsed by the same parser as a whole message,
 * and `text` and `html` are empty.
 */
export async function headerMessage(key: number | string, block: string): Promise<MailMessage> {
  const head = block.replace(/(\r?\n)+$/, '');
  return toMailMessage(key, await simpleParser(`${head}\r\n\r\n`, { skipImageLinks: true }));
}

/** A header block from name and value pairs, one header per line whatever a value holds. */
export function headerBlock(headers: readonly { name: string; value: string }[]): string {
  return headers
    .filter((header) => /^[!-9;-~]+$/.test(header.name))
    .map((header) => `${header.name}: ${header.value.replace(/[\r\n]+/g, ' ')}`)
    .join('\r\n');
}

/** Most bytes of headers one message may carry into a signal. */
export const MAX_HEADER_BYTES = 64 * 1024;

/** How far back a mailbox the server renumbered is read again, in days. */
export const RESYNC_DAYS = 2;

/** What `imapChanges` needs of an open, read-only inbox. */
export type ImapInbox = {
  uidValidity: string;
  uidNext: number;
  /** UIDs from `first` on. IMAP answers `n:*` with the last message even below `n`. */
  uidsFrom(first: number): Promise<number[]>;
  uidsSince(since: Date): Promise<number[]>;
  headers(uid: number): Promise<MailMessage | null>;
};

/**
 * What arrived in an IMAP inbox since the cursor, by UID.
 *
 * The cursor is `<UIDVALIDITY>:<last UID read>`. A first read starts at the
 * newest message and returns nothing. When the server's UIDVALIDITY changes,
 * every UID from before means nothing any more, so the last
 * {@link RESYNC_DAYS} days are read again; a message keeps its key (its
 * Message-ID) across the renumbering, so one already delivered is not
 * delivered twice.
 */
export async function imapChanges(
  inbox: ImapInbox,
  cursor: string | null,
  options: { limit: number; now?: number },
): Promise<{ cursor: string; messages: (MailMessage & { key: string; read_key: number })[] }> {
  const top = Math.max(0, inbox.uidNext - 1);
  const parsed = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null;
  if (!parsed) return { cursor: `${inbox.uidValidity}:${top}`, messages: [] };
  let uids: number[];
  let last: number;
  if (parsed[1] !== inbox.uidValidity) {
    const since = new Date((options.now ?? Date.now()) - RESYNC_DAYS * 86_400_000);
    uids = [...new Set(await inbox.uidsSince(since))].sort((a, b) => a - b).slice(-options.limit);
    last = Math.max(top, ...uids);
  } else {
    const after = Number(parsed[2]);
    uids = [...new Set(await inbox.uidsFrom(after + 1))]
      .filter((uid) => uid > after)
      .sort((a, b) => a - b)
      .slice(0, options.limit);
    last = uids.at(-1) ?? after;
  }
  const messages: (MailMessage & { key: string; read_key: number })[] = [];
  for (const uid of uids) {
    const message = await inbox.headers(uid);
    if (!message) continue;
    messages.push({
      ...message,
      key: message.message_id ? `msgid:${message.message_id}` : `imap:${inbox.uidValidity}:${uid}`,
      read_key: uid,
    });
  }
  return { cursor: `${inbox.uidValidity}:${last}`, messages };
}

export interface MailTransport {
  /** Newest first. The inbox unless `folder` says otherwise. */
  search(query: string, limit: number, folder?: MailFolder): Promise<MailMessage[]>;
  /** By UID for IMAP, by id for a mailbox that addresses messages that way. */
  read(key: number | string): Promise<MailMessage | null>;
  send(
    message: OutgoingMail,
  ): Promise<{ messageId: string; sentCopy: boolean; accepted?: string[]; rejected?: string[] }>;
  findSent(messageId: string): Promise<boolean>;
  health(): Promise<void>;
  /**
   * What arrived in the inbox since `cursor`, headers only, oldest first; a
   * null cursor starts from now. A mailbox that cannot say leaves it out.
   */
  changes?(
    cursor: string | null,
    options: {
      limit: number;
      seen?: (key: string) => Promise<boolean>;
      now?: number;
    },
  ): Promise<{
    cursor: string;
    messages: (MailMessage & { key: string; read_key: number | string })[];
  }>;
}

const MAX_MESSAGE_BYTES = 256 * 1024;
const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host);

/**
 * Whether a server turned the account name and password away, as opposed to
 * not answering. IMAP says so on the error it raises; SMTP answers `EAUTH`.
 */
export function credentialRefused(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const fields = error as { authenticationFailed?: unknown; code?: unknown };
  return fields.authenticationFailed === true || fields.code === 'EAUTH';
}

/** Whether the account's sign-in has ended, so only signing in again helps. */
export function signInEnded(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { signInEnded?: unknown }).signInEnded === true
  );
}

/**
 * The bytes of one outgoing message. Buffers only: file and URL access stay
 * disabled, so nodemailer never reads a path this process did not already read.
 */
export async function composeMail(
  from: string,
  message: OutgoingMail,
  headers: Record<string, string> = {},
): Promise<Buffer> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await composer.sendMail({
    from,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.body,
    messageId: message.messageId,
    headers,
    attachments: message.attachments?.map((entry) => ({
      filename: entry.filename,
      content: entry.content,
      contentType: entry.contentType,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  if (!Buffer.isBuffer(composed.message)) throw new Error('Mail composition did not return bytes');
  return composed.message;
}

/** TLS verification is always enabled; the test exception cannot target a remote host. */
export function validateMailConnection(config: EmailConnection): void {
  if (!config.username || /[\r\n]/.test(config.from)) throw new Error('Invalid mail configuration');
  for (const endpoint of [config.imap, config.smtp]) {
    if (
      !endpoint.host ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65535
    ) {
      throw new Error('Invalid mail endpoint');
    }
    if (config.allowInsecureLocalForTests && !loopback(endpoint.host)) {
      throw new Error('Plaintext mail is permitted only for loopback test servers');
    }
  }
}

/** App passwords are supplied only while the connector holds service credentials. */
export class ImapSmtpTransport implements MailTransport {
  constructor(
    private readonly config: EmailConnection,
    private readonly password: string,
  ) {
    validateMailConnection(config);
  }

  private client(): ImapFlow {
    return new ImapFlow({
      ...this.config.imap,
      doSTARTTLS: this.config.allowInsecureLocalForTests ? false : !this.config.imap.secure,
      auth: { user: this.config.username, pass: this.password },
      logger: false,
      emitLogs: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
  }

  private async imap<T>(
    mailbox: string | null,
    work: (client: ImapFlow) => Promise<T>,
  ): Promise<T> {
    const client = this.client();
    // Socket errors are surfaced by commands; never log errors with credentials.
    client.on('error', () => {});
    try {
      await client.connect();
      if (mailbox) await client.mailboxOpen(mailbox, { readOnly: true });
      return await work(client);
    } finally {
      client.close();
    }
  }

  private async message(client: ImapFlow, uid: number): Promise<MailMessage | null> {
    const metadata = await client.fetchOne(uid, { size: true }, { uid: true });
    // A truncated message cannot be filtered safely. Omit it rather than expose
    // a harmless prefix while an authentication link sits beyond the limit.
    if (!metadata) return null;
    if (!metadata.size || metadata.size > MAX_MESSAGE_BYTES) return null;
    const item = await client.fetchOne(uid, { source: true }, { uid: true });
    if (!item) return null;
    if (!item.source || item.source.length > MAX_MESSAGE_BYTES) return null;
    return toMailMessage(uid, await simpleParser(item.source, { skipImageLinks: true }));
  }

  async changes(cursor: string | null, options: { limit: number; now?: number }) {
    return this.imap(null, async (client) => {
      const opened = await client.mailboxOpen(this.config.inbox ?? 'INBOX', { readOnly: true });
      const search = async (query: Record<string, unknown>) => {
        const found = await client.search(query, { uid: true });
        return Array.isArray(found) ? found : [];
      };
      return imapChanges(
        {
          uidValidity: String(opened.uidValidity),
          uidNext: Number(opened.uidNext),
          uidsFrom: (first) => search({ uid: `${first}:*` }),
          uidsSince: (since) => search({ since }),
          headers: async (uid) => {
            const item = await client.fetchOne(uid, { headers: true }, { uid: true });
            const raw = item ? item.headers : undefined;
            if (!raw || raw.length > MAX_HEADER_BYTES) return null;
            return headerMessage(uid, raw.toString('utf8'));
          },
        },
        cursor,
        options,
      );
    });
  }

  async search(query: string, limit: number, folder: MailFolder = 'inbox'): Promise<MailMessage[]> {
    const mailbox = folder === 'sent' ? await this.sentFolder() : (this.config.inbox ?? 'INBOX');
    return this.imap(mailbox, async (client) => {
      const uids = await client.search(query ? { text: query } : { all: true }, { uid: true });
      const messages: MailMessage[] = [];
      for (const uid of (uids || []).slice(-limit).reverse()) {
        const message = await this.message(client, uid);
        if (message) messages.push(message);
      }
      return messages;
    });
  }

  private smtp() {
    return nodemailer.createTransport({
      ...this.config.smtp,
      auth: { user: this.config.username, pass: this.password },
      requireTLS: !this.config.allowInsecureLocalForTests,
      ignoreTLS: this.config.allowInsecureLocalForTests ?? false,
      logger: false,
      debug: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
  }

  async read(uid: number | string): Promise<MailMessage | null> {
    if (typeof uid !== 'number') return null;
    return this.imap(this.config.inbox ?? 'INBOX', (client) => this.message(client, uid));
  }

  async send(
    message: OutgoingMail,
  ): Promise<{ messageId: string; sentCopy: boolean; accepted: string[]; rejected: string[] }> {
    const raw = await composeMail(this.config.from, message);
    const smtp = this.smtp();
    let accepted: string[];
    let rejected: string[];
    try {
      const result = await smtp.sendMail({
        envelope: { from: this.config.from, to: [...message.to, ...message.cc, ...message.bcc] },
        raw,
      });
      accepted = result.accepted.map(String);
      rejected = result.rejected.map(String);
    } finally {
      smtp.close();
    }
    let sentCopy = false;
    try {
      // SMTP acceptance already proves the send. A failed Sent-folder append
      // must not turn that fact into a failure that encourages a resend.
      sentCopy = await this.findSent(message.messageId);
      if (!sentCopy) {
        const folder = await this.sentFolder();
        sentCopy = await this.imap(null, async (client) =>
          Boolean(await client.append(folder, raw, ['\\Seen'])),
        );
      }
    } catch {
      sentCopy = false;
    }
    return { messageId: message.messageId, sentCopy, accepted, rejected };
  }

  private sent?: Promise<string>;

  /**
   * The folder sent mail lands in. Providers name it their own way ("Sent
   * Messages", "[Gmail]/Sent Mail", a translated name), so unless the person
   * named one, the folder the server flags as sent is used, and "Sent" only
   * when it flags none. Without it a send could never be confirmed.
   */
  private sentFolder(): Promise<string> {
    if (this.config.sent) return Promise.resolve(this.config.sent);
    this.sent ??= this.imap(null, async (client) => {
      const flagged = (await client.list()).find((mailbox) => mailbox.specialUse === '\\Sent');
      return flagged?.path ?? 'Sent';
    }).catch((error: unknown) => {
      // A failed lookup is asked again next time rather than remembered.
      this.sent = undefined;
      throw error;
    });
    return this.sent;
  }

  async findSent(messageId: string): Promise<boolean> {
    return this.imap(await this.sentFolder(), async (client) => {
      const uids = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      // IMAP HEADER searches are substring matches. Confirm the parsed header
      // before treating a search hit as evidence for this exact action.
      for (const uid of (uids || []).slice(-50)) {
        const message = await client.fetchOne(uid, { envelope: true }, { uid: true });
        if (message && message.envelope?.messageId === messageId) return true;
      }
      return false;
    });
  }

  /**
   * Both halves: a mailbox that reads but cannot send would otherwise pass its
   * test and fail at the first message the person approved. The SMTP check
   * signs in and sends nothing.
   */
  async health(): Promise<void> {
    await this.imap(this.config.inbox ?? 'INBOX', async () => {});
    const smtp = this.smtp();
    try {
      await smtp.verify();
    } finally {
      smtp.close();
    }
  }
}
