/**
 * The installation's own mail sender, for account mail only: sign-in links and
 * password reset links. The person who runs the installation configures it
 * with `MELETE_SMTP_URL` and `MELETE_MAIL_FROM`; a hosted installation always
 * does, so a customer who never connected a mailbox can still get back in.
 * Without it, account mail goes out from the owner's own connected mailbox, as
 * before, and only to the owner.
 *
 * It sends nothing else. What Melete sends for a person goes out from their own
 * connected accounts, through approvals, never through this sender.
 */
import { randomUUID } from 'node:crypto';
import { DEFAULT_INSTANCE_NAME } from '@melete/contracts';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { Env } from '../env.ts';

export type AccountMail = { to: string; subject: string; text: string };
export type AccountMailer = { send(mail: AccountMail): Promise<void> };

/**
 * Who account mail says it is from: the installation's name
 * (`MELETE_INSTANCE_NAME`) and the address people open it at
 * (`MELETE_PUBLIC_URL`), which closes the mail so a person can tell which
 * installation wrote to them.
 */
export type MailInstance = { name: string; publicUrl?: string | undefined };

const MELETE: MailInstance = { name: DEFAULT_INSTANCE_NAME };

const signature = (instance: MailInstance) =>
  instance.publicUrl ? `\n\n${instance.name}\n${new URL('/', instance.publicUrl).href}` : '';

export function signInMail(to: string, url: string, instance: MailInstance = MELETE): AccountMail {
  return {
    to,
    subject: `${instance.name} sign-in link`,
    text: `Use this link to sign in to ${instance.name}. It expires in ten minutes and can be used once.\n\n${url}\n\nIf you did not request this link, ignore this email.${signature(instance)}`,
  };
}

export function passwordResetMail(
  to: string,
  url: string,
  minutes: number,
  instance: MailInstance = MELETE,
): AccountMail {
  return {
    to,
    subject: `Reset your ${instance.name} password`,
    text: `Use this link to choose a new ${instance.name} password. It expires in ${minutes} minutes and can be used once. Choosing a new password signs you out everywhere.\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays as it is.${signature(instance)}`,
  };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * How the sender connects. The links it mails sign in to an account, so a
 * plain `smtp://` server must upgrade the connection with STARTTLS before the
 * sign-in and the message are sent, unless the server runs on this machine.
 * What the URL itself says wins: `?requireTLS=false` for a relay that cannot.
 */
export function smtpTransportOptions(smtpUrl: string): SMTPTransport.Options {
  let host = '';
  try {
    host = new URL(smtpUrl).hostname.toLowerCase();
  } catch {
    // Unreadable here: TLS stays required.
  }
  return {
    url: smtpUrl,
    requireTLS: !LOOPBACK.has(host),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  };
}

/** An SMTP sender, opened for each message and closed after it. */
export function smtpAccountMailer(options: { smtpUrl: string; from: string }): AccountMailer {
  const domain = /@([^>\s]+)>?\s*$/.exec(options.from)?.[1] ?? 'melete.local';
  return {
    async send(mail) {
      const smtp = nodemailer.createTransport(smtpTransportOptions(options.smtpUrl));
      try {
        await smtp.sendMail({
          from: options.from,
          to: mail.to,
          subject: mail.subject,
          text: mail.text,
          messageId: `<account.${randomUUID()}@${domain}>`,
        });
      } finally {
        smtp.close();
      }
    },
  };
}

/** The sender the environment configures, or none. */
export function accountMailerFromEnv(env: Env): AccountMailer | undefined {
  if (!env.MELETE_SMTP_URL || !env.MELETE_MAIL_FROM) return undefined;
  return smtpAccountMailer({ smtpUrl: env.MELETE_SMTP_URL, from: env.MELETE_MAIL_FROM });
}
