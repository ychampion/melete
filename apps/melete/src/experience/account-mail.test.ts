import { afterAll, expect, test } from 'bun:test';
import { plainSmtpAvailable, plainSmtpServer } from '../../test/helpers/plain-smtp.ts';
import {
  passwordResetMail,
  signInMail,
  smtpAccountMailer,
  smtpTransportOptions,
} from './account-mail.ts';

test('account mail carries the installation name and closes with its public address', () => {
  const plain = signInMail('person@example.test', 'https://x.test/#/welcome?token=x');
  expect(plain.subject).toBe('Melete sign-in link');
  expect(plain.text).toContain('sign in to Melete.');
  expect(plain.text.endsWith('ignore this email.')).toBe(true);

  const riverside = { name: 'Riverside Assistant', publicUrl: 'https://help.riverside.test/app' };
  const link = signInMail('person@example.test', 'https://x.test/#/welcome?token=x', riverside);
  expect(link.subject).toBe('Riverside Assistant sign-in link');
  expect(link.text).toContain('sign in to Riverside Assistant.');
  expect(link.text).not.toContain('Melete');
  expect(link.text.endsWith('\n\nRiverside Assistant\nhttps://help.riverside.test/')).toBe(true);

  const reset = passwordResetMail('person@example.test', 'https://x.test/#/r', 30, riverside);
  expect(reset.subject).toBe('Reset your Riverside Assistant password');
  expect(reset.text).toContain('choose a new Riverside Assistant password. It expires in 30');
  expect(reset.text).not.toContain('Melete');
});

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
