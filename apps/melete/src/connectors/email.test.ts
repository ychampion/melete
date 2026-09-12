import { describe, expect, test } from 'bun:test';
import { connectorManifest } from '@melete/contracts';
import { EmailConnector, emailManifest, emailMessageId } from './email.ts';
import { mailAction, mailContext } from './mail-fixtures.ts';
import type {
  EmailConnection,
  MailMessage,
  MailTransport,
  OutgoingMail,
} from './mail-transport.ts';
import type { SecretAccess } from './secrets.ts';

const config: EmailConnection = {
  id: 'con_test',
  spaceId: 'spc_test',
  secretRef: 'sec_private',
  username: 'owner@example.test',
  from: 'owner@example.test',
  imap: { host: 'imap.example.test', port: 993, secure: true },
  smtp: { host: 'smtp.example.test', port: 465, secure: true },
};
const secret: SecretAccess = {
  withSecret: async (_id, _space, use) => use('app-password-that-never-leaks'),
};
const message = (uid: number, subject: string, text = 'Normal message.'): MailMessage => ({
  uid,
  message_id: `<${uid}@example.test>`,
  from: 'friend@example.test',
  to: 'owner@example.test',
  subject,
  text,
  html: '',
});

class MailDouble implements MailTransport {
  messages = [
    message(1, 'Dinner on Friday'),
    message(2, 'Your OTP is 123456'),
    message(
      3,
      'Account notice',
      'Reset your password using https://example.test/reset?token=secret',
    ),
    message(4, 'Account notice', 'Your magic-link is https://example.test/signin?token=secret'),
    message(5, 'Sign-in code: 123456'),
  ];
  sent = new Map<string, OutgoingMail>();
  sends = 0;
  dropAck = false;
  fail = false;
  async search(): Promise<MailMessage[]> {
    if (this.fail) throw new Error('app-password-that-never-leaks');
    return this.messages;
  }
  async read(uid: number): Promise<MailMessage | null> {
    return this.messages.find((m) => m.uid === uid) ?? null;
  }
  async send(outgoing: OutgoingMail) {
    this.sends++;
    this.sent.set(outgoing.messageId, outgoing);
    if (this.dropAck)
      throw new Error('app-password-that-never-leaks: connection closed after accept');
    return { messageId: outgoing.messageId, sentCopy: true };
  }
  async findSent(id: string): Promise<boolean> {
    return this.sent.has(id);
  }
  async health(): Promise<void> {
    if (this.fail) throw new Error('app-password-that-never-leaks');
  }
}
const sendPayload = { to: ['friend@example.test'], subject: 'Hello', body: 'See you Friday.' };

describe('email connector', () => {
  test('cross_space_mailbox: asMailer refuses another space before opening its transport', async () => {
    const fake = new MailDouble();
    const mailer = new EmailConnector(config, secret, () => fake).asMailer();
    let refusal: unknown;
    try {
      await mailer.send(
        { ...sendPayload, messageId: '<test@example.test>', attachments: [] },
        { space_id: 'other-space', connection_id: config.id },
      );
    } catch (error) {
      refusal = error;
    }
    expect(fake.sends).toBe(0);
    expect(refusal).toBeInstanceOf(Error);
  });
  test('manifest requires approval for send and has no credential-bearing runtime fields', () => {
    expect(connectorManifest.safeParse(emailManifest).success).toBe(true);
    expect(emailManifest.tools.find((t) => t.name === 'email.send')?.requires_approval).toBe(true);
    expect(JSON.stringify(emailManifest.tools)).not.toContain('secret_ref');
  });

  test('withholds OTP, password resets and magic links from search and direct read', async () => {
    const fake = new MailDouble();
    const connector = new EmailConnector(config, secret, () => fake);
    const result = await connector.execute(mailAction('email.search'), mailContext());
    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded')
      expect(result.receipt.detail.messages).toEqual(
        [{ ...message(1, 'Dinner on Friday'), html: undefined }].map(
          ({ html: _html, ...value }) => value,
        ),
      );
    for (const uid of [2, 3, 4, 5]) {
      const withheld = await connector.execute(mailAction('email.read', { uid }), mailContext());
      expect(withheld.outcome).toBe('failed');
      expect(JSON.stringify(withheld)).not.toContain('123456');
      expect(JSON.stringify(withheld)).not.toContain('token=');
    }
    expect(
      (await connector.execute(mailAction('email.read', { uid: 1 }), mailContext())).outcome,
    ).toBe('succeeded');
  });

  test('a draft is durable local output and never loads credentials or calls SMTP', async () => {
    let loaded = false;
    const connector = new EmailConnector(config, {
      withSecret: async () => {
        loaded = true;
        throw new Error('Unexpected secret read');
      },
    });
    const result = await connector.execute(mailAction('email.draft', sendPayload), mailContext());
    expect(result.outcome).toBe('succeeded');
    expect(loaded).toBe(false);
  });

  test('accepted send with lost acknowledgement is unknown, then verified without resending', async () => {
    const fake = new MailDouble();
    fake.dropAck = true;
    const connector = new EmailConnector(config, secret, () => fake);
    const action = mailAction('email.send', sendPayload);
    const result = await connector.execute(action, mailContext());
    expect(result.outcome).toBe('unknown');
    expect(fake.sent.has(emailMessageId(action.id))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('app-password-that-never-leaks');
    expect((await connector.verify(action, mailContext())).decision).toBe('succeeded');
    expect(fake.sends).toBe(1);
    fake.sent.clear();
    expect((await connector.verify(action, mailContext())).decision).toBe('undecided');
    expect(fake.sends).toBe(1);
  });

  test('context mismatch, header injection and unapproved extra fields never reach SMTP', async () => {
    const fake = new MailDouble();
    const connector = new EmailConnector(config, secret, () => fake);
    for (const payload of [
      { ...sendPayload, subject: 'Hello\r\nBcc: stranger@example.test' },
      { ...sendPayload, from: 'stranger@example.test' },
      { ...sendPayload, attachments: [{ path: '/etc/passwd' }] },
    ]) {
      expect(
        (await connector.execute(mailAction('email.send', payload), mailContext())).outcome,
      ).toBe('failed');
    }
    expect(
      (
        await connector.execute(mailAction('email.send', sendPayload), {
          ...mailContext(),
          space_id: 'spc_other',
        })
      ).outcome,
    ).toBe('failed');
    expect(
      (
        await connector.execute(mailAction('email.send', sendPayload), {
          ...mailContext(),
          idempotency_key: 'other',
        })
      ).outcome,
    ).toBe('failed');
    expect(fake.sends).toBe(0);
  });

  test('provider errors and health never disclose passwords or secret references', async () => {
    const fake = new MailDouble();
    fake.fail = true;
    const connector = new EmailConnector(config, secret, () => fake);
    const output = JSON.stringify([
      await connector.execute(mailAction('email.search'), mailContext()),
      await connector.health(),
    ]);
    expect(output).not.toContain('app-password-that-never-leaks');
    expect(output).not.toContain('sec_private');
  });
});
