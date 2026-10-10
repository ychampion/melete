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
import nodemailer from 'nodemailer';
import type { Env } from '../env.ts';

export type AccountMail = { to: string; subject: string; text: string };
export type AccountMailer = { send(mail: AccountMail): Promise<void> };

export function signInMail(to: string, url: string): AccountMail {
  return {
    to,
    subject: 'Melete sign-in link',
    text: `Use this link to sign in to Melete. It expires in ten minutes and can be used once.\n\n${url}\n\nIf you did not request this link, ignore this email.`,
  };
}

export function passwordResetMail(to: string, url: string, minutes: number): AccountMail {
  return {
    to,
    subject: 'Reset your Melete password',
    text: `Use this link to choose a new Melete password. It expires in ${minutes} minutes and can be used once. Choosing a new password signs you out everywhere.\n\n${url}\n\nIf you did not ask for this, ignore this email; your password stays as it is.`,
  };
}

/** An SMTP sender, opened for each message and closed after it. */
export function smtpAccountMailer(options: { smtpUrl: string; from: string }): AccountMailer {
  const domain = /@([^>\s]+)>?\s*$/.exec(options.from)?.[1] ?? 'melete.local';
  return {
    async send(mail) {
      const smtp = nodemailer.createTransport(options.smtpUrl, {
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      } as never);
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
