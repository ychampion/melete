import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
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
  uid: number;
  message_id: string | null;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The Date header as an ISO instant, when the message carried a usable one. */
  date?: string | null;
};

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

export interface MailTransport {
  search(query: string, limit: number): Promise<MailMessage[]>;
  read(uid: number): Promise<MailMessage | null>;
  send(
    message: OutgoingMail,
  ): Promise<{ messageId: string; sentCopy: boolean; accepted?: string[]; rejected?: string[] }>;
  findSent(messageId: string): Promise<boolean>;
  health(): Promise<void>;
}

const MAX_MESSAGE_BYTES = 256 * 1024;
const loopback = (host: string) => ['127.0.0.1', '::1', 'localhost'].includes(host);

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
    const parsed = await simpleParser(item.source, { skipImageLinks: true });
    const to = parsed.to
      ? Array.isArray(parsed.to)
        ? parsed.to.map((v) => v.text).join(', ')
        : parsed.to.text
      : '';
    return {
      uid,
      message_id: parsed.messageId ?? null,
      from: parsed.from?.text ?? '',
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
    };
  }

  async search(query: string, limit: number): Promise<MailMessage[]> {
    return this.imap(this.config.inbox ?? 'INBOX', async (client) => {
      const uids = await client.search(query ? { text: query } : { all: true }, { uid: true });
      const messages: MailMessage[] = [];
      for (const uid of (uids || []).slice(-limit).reverse()) {
        const message = await this.message(client, uid);
        if (message) messages.push(message);
      }
      return messages;
    });
  }

  async read(uid: number): Promise<MailMessage | null> {
    return this.imap(this.config.inbox ?? 'INBOX', (client) => this.message(client, uid));
  }

  async send(
    message: OutgoingMail,
  ): Promise<{ messageId: string; sentCopy: boolean; accepted: string[]; rejected: string[] }> {
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const composed = await composer.sendMail({
      from: this.config.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      subject: message.subject,
      text: message.body,
      messageId: message.messageId,
      // Buffers only: file and URL access stay disabled, so nodemailer never
      // reads a path this process did not already read itself.
      attachments: message.attachments?.map((entry) => ({
        filename: entry.filename,
        content: entry.content,
        contentType: entry.contentType,
      })),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    if (!Buffer.isBuffer(composed.message))
      throw new Error('Mail composition did not return bytes');
    const smtp = nodemailer.createTransport({
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
    let accepted: string[];
    let rejected: string[];
    try {
      const result = await smtp.sendMail({
        envelope: { from: this.config.from, to: [...message.to, ...message.cc, ...message.bcc] },
        raw: composed.message,
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
        const raw = composed.message;
        sentCopy = await this.imap(null, async (client) =>
          Boolean(await client.append(this.config.sent ?? 'Sent', raw, ['\\Seen'])),
        );
      }
    } catch {
      sentCopy = false;
    }
    return { messageId: message.messageId, sentCopy, accepted, rejected };
  }

  async findSent(messageId: string): Promise<boolean> {
    return this.imap(this.config.sent ?? 'Sent', async (client) => {
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

  async health(): Promise<void> {
    await this.imap(this.config.inbox ?? 'INBOX', async () => {});
  }
}
