import { expect, test } from 'bun:test';
import { EmailConnector } from '../connectors/email.ts';
import type {
  EmailConnection,
  MailMessage,
  MailTransport,
  OutgoingMail,
} from '../connectors/mail-transport.ts';
import { ConnectorRegistry } from '../connectors/registry.ts';
import type { SecretAccess } from '../connectors/secrets.ts';
import { connectorReplyMailbox, isReplyFrom } from './replies.ts';

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
