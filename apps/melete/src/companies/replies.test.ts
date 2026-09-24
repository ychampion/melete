import { expect, test } from 'bun:test';
import { simpleParser } from 'mailparser';
import { ServiceError } from '../api/errors.ts';
import { EmailConnector } from '../connectors/email.ts';
import {
  type EmailConnection,
  type MailMessage,
  type MailTransport,
  type OutgoingMail,
  toMailMessage,
} from '../connectors/mail-transport.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import {
  connectorReplyMailbox,
  deliveryFailureCode,
  isReplyFrom,
  registrableDomain,
  replyPayload,
  senderDomain,
} from './replies.ts';

const SPACE = 'spc_test';
const CONNECTION = 'con_test';
const config: EmailConnection = {
  id: CONNECTION,
  spaceId: SPACE,
  secretRef: 'sec_private',
  username: 'me@example.test',
  from: 'me@example.test',
  imap: { host: 'imap.example.test', port: 993, secure: true },
  smtp: { host: 'smtp.example.test', port: 465, secure: true },
};
const secret: SecretAccess = { withSecret: async (_id, _space, use) => use('app-password') };

class Inbox implements MailTransport {
  constructor(readonly messages: MailMessage[]) {}
  async search(): Promise<MailMessage[]> {
    return this.messages;
  }
  async read(): Promise<MailMessage | null> {
    return null;
  }
  async send(outgoing: OutgoingMail) {
    return { messageId: outgoing.messageId, sentCopy: true };
  }
  async findSent(): Promise<boolean> {
    return false;
  }
  async health(): Promise<void> {}
}

test('a reply the mail server could not date is read as arriving now, not dropped', async () => {
  const registry = new ConnectorRegistry();
  const inbox = new Inbox([
    {
      uid: 1,
      message_id: '<undated@acme.test>',
      from: 'Acme Support <support@acme.test>',
      to: 'me@example.test',
      subject: 'Re: Refund',
      text: 'We have issued the refund.',
      html: '',
      date: null,
    },
  ]);
  registry.register(CONNECTION, new EmailConnector(config, secret, () => inbox));
  const since = new Date(Date.now() - 60_000).toISOString();
  const [message] = await connectorReplyMailbox({
    registry,
    connectionId: CONNECTION,
    spaceId: SPACE,
  }).recent(50);
  expect(message?.messageId).toBe('<undated@acme.test>');
  if (!message) return;
  expect(isReplyFrom({ domain: 'acme.test', since }, message)).toBe(true);
});

test('the sender is every address in the From header, not the last one that looks right', () => {
  // A comment after the address is not part of it.
  expect(senderDomain('billing@acme.test (Acme Billing)')).toBe('acme.test');
  expect(senderDomain('"Acme, Inc." <billing@mail.acme.test>')).toBe('acme.test');
  expect(senderDomain('Acme <a@acme.test>, b@billing.acme.test')).toBe('acme.test');
  // Two senders who are not one company are nobody's reply.
  expect(senderDomain('someone@evil.test, Acme <billing@acme.test>')).toBeNull();
  expect(senderDomain('Acme Billing')).toBeNull();
  expect(senderDomain('')).toBeNull();

  const since = '2026-09-18T09:00:00.000Z';
  const message = (from: string) => ({
    messageId: '<r@acme.test>',
    from,
    subject: 'Re: Refund',
    receivedAt: '2026-09-18T11:00:00.000Z',
  });
  expect(isReplyFrom({ domain: 'acme.test', since }, message('billing@acme.test (Acme)'))).toBe(
    true,
  );
  expect(
    isReplyFrom({ domain: 'acme.test', since }, message('x@evil.test, Acme <b@acme.test>')),
  ).toBe(false);
  // What the poller delivers names the one company the message is from.
  expect(replyPayload(message('billing@acme.test (Acme)')).sender_domain).toBe('acme.test');
  expect(replyPayload(message('x@evil.test, b@acme.test')).sender_domain).toBeNull();
});

test('a reply that could not be delivered is logged by a fixed reason, never by its text', () => {
  expect(
    deliveryFailureCode(new ServiceError('unknown_connection', 'Connection is not active.', 404)),
  ).toBe('unknown_connection');
  // Anything else may carry a server's words or a person's address.
  expect(deliveryFailureCode(new Error('IMAP said no to someone@example.test'))).toBe(
    'internal_error',
  );
  expect(deliveryFailureCode('not even an error')).toBe('internal_error');
});

test('a display name that spells out the company’s address does not make its sender the company', async () => {
  // The name decodes to `Acme" <support@acme.test> "`; the address is x@evil.test.
  const name = Buffer.from('Acme" <support@acme.test> "').toString('base64');
  const parsed = await simpleParser(
    `From: =?UTF-8?B?${name}?= <x@evil.test>\r\nMessage-ID: <r@evil.test>\r\nDate: Fri, 18 Sep 2026 11:00:00 +0000\r\nSubject: Re: Refund\r\n\r\nPaid.`,
  );
  const message = toMailMessage(1, parsed);
  expect(message.from_addresses).toEqual(['x@evil.test']);
  const registry = new ConnectorRegistry();
  registry.register(CONNECTION, new EmailConnector(config, secret, () => new Inbox([message])));
  const [read] = await connectorReplyMailbox({
    registry,
    connectionId: CONNECTION,
    spaceId: SPACE,
  }).recent(50);
  expect(read?.messageId).toBe('<r@evil.test>');
  if (!read) return;
  const since = '2026-09-18T09:00:00.000Z';
  expect(isReplyFrom({ domain: 'acme.test', since }, read)).toBe(false);
  expect(replyPayload(read).sender_domain).toBe('evil.test');
  // Reading the rendered header alone, a part that holds two addresses is nobody.
  expect(senderDomain(read.from)).toBeNull();
});

test('a company with a name outside ASCII is the same company in either spelling', () => {
  expect(registrableDomain('support@bücher.example')).toBe('xn--bcher-kva.example');
  expect(registrableDomain('support@mail.xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  expect(senderDomain('Bücher <hilfe@BÜCHER.example>')).toBe('xn--bcher-kva.example');
});

test('a message with two From headers is from nobody, whichever the parser kept', async () => {
  const parsed = await simpleParser(
    'From: x@evil.test\r\nFrom: a@acme.test\r\nMessage-ID: <two@evil.test>\r\nDate: Fri, 18 Sep 2026 11:00:00 +0000\r\nSubject: Re: Refund\r\n\r\nPaid.',
  );
  const message = toMailMessage(1, parsed);
  expect(message.from_addresses).toEqual([]);
  const registry = new ConnectorRegistry();
  registry.register(CONNECTION, new EmailConnector(config, secret, () => new Inbox([message])));
  const [read] = await connectorReplyMailbox({
    registry,
    connectionId: CONNECTION,
    spaceId: SPACE,
  }).recent(50);
  if (!read) throw new Error('Expected the message to be read');
  expect(isReplyFrom({ domain: 'acme.test', since: '2026-09-18T09:00:00.000Z' }, read)).toBe(false);
  expect(replyPayload(read).sender_domain).toBeNull();
});
