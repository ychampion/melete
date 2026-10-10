import { afterAll, expect, test } from 'bun:test';
import { plainSmtpAvailable, plainSmtpServer } from '../../test/helpers/plain-smtp.ts';
import { signInMail, smtpAccountMailer, smtpTransportOptions } from './account-mail.ts';

test('a mail server elsewhere must upgrade to TLS; one on this machine need not', () => {
  expect(smtpTransportOptions('smtp://user:pw@smtp.example.com:587').requireTLS).toBe(true);
  expect(smtpTransportOptions('smtp://10.0.0.5:25').requireTLS).toBe(true);
  expect(smtpTransportOptions('smtp://127.0.0.1:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('smtp://localhost:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('smtp://[::1]:25').requireTLS).toBe(false);
  expect(smtpTransportOptions('not a url').requireTLS).toBe(true);
  const options = smtpTransportOptions('smtps://user:pw@smtp.example.com:465');
  expect(options.url).toBe('smtps://user:pw@smtp.example.com:465');
  expect(options.connectionTimeout).toBe(10_000);
});

/** A server that offers no STARTTLS; see the helper for why it is on 127.0.0.2. */
const server = plainSmtpServer();
const received = server.received;
afterAll(() => server.stop());

test.skipIf(!plainSmtpAvailable)(
  'a link is never sent to a server that cannot take TLS, unless its URL allows that',
  async () => {
    const at = server.url;
    const from = 'Melete <melete@example.test>';
    const mail = signInMail('person@example.test', 'https://melete.example.test/#/welcome?token=x');
    await expect(smtpAccountMailer({ smtpUrl: at, from }).send(mail)).rejects.toThrow(/TLS/);
    expect(received).toEqual([]);
    await smtpAccountMailer({ smtpUrl: `${at}?requireTLS=false`, from }).send(mail);
    expect(received).toContain('Subject: Melete sign-in link');
  },
);
