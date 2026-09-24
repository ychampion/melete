/**
 * The words of the money-back journey: connect an inbox, see what companies
 * owe you, and let Melete chase it. They live in one place so the journey can
 * be reworded without touching the screens that draw it.
 */

/** The connect step's heading and its one line. */
export const CONNECT_INBOX = {
  title: 'Connect your inbox',
  line: 'Melete reads your mail for money companies owe you, then chases it until they pay.',
  connected:
    'Your inbox is connected. Melete reads it for what companies owe you as soon as you open it.',
};

/** Mail kinds offered on the connect step, in the order they are shown. */
export const MAIL_KINDS = ['gmail', 'icloud-mail', 'fastmail', 'yahoo-mail', 'mail'] as const;

export type AppPasswordNote = { title: string; lines: string[] };

const WHY =
  'Melete connects to your mailbox over IMAP, the standard way mail apps read and send mail. Your provider lets it in with an app password: a separate password just for Melete, which you can remove at any time without changing your own.';

/** The one-screen explainer for the app password each mail kind needs. */
export const APP_PASSWORD: Record<string, AppPasswordNote> = {
  gmail: {
    title: 'Gmail uses an app password',
    lines: [
      WHY,
      'Google shows app passwords once 2-Step Verification is on for your account.',
      'Open myaccount.google.com/apppasswords, create one named Melete, and paste the 16 characters below with your Gmail address.',
    ],
  },
  'icloud-mail': {
    title: 'iCloud Mail uses an app-specific password',
    lines: [
      WHY,
      'Apple offers app-specific passwords once two-factor authentication is on for your Apple Account.',
      'Sign in at account.apple.com, open Sign-In and Security, choose App-Specific Passwords, and create one. Use your iCloud Mail address, such as you@icloud.com.',
    ],
  },
  fastmail: {
    title: 'Fastmail uses an app password',
    lines: [
      WHY,
      'In Fastmail, open Settings, then Privacy and Security, and create a new app password with access to mail (IMAP and SMTP).',
    ],
  },
  'yahoo-mail': {
    title: 'Yahoo Mail uses an app password',
    lines: [WHY, 'In your Yahoo account, open Account security and generate an app password.'],
  },
  mail: {
    title: 'Your provider’s app password',
    lines: [
      WHY,
      'Most providers offer app passwords in their security settings. Outlook.com accepts only its own sign-in, so it cannot be connected with a password.',
    ],
  },
};

/** The first scan's lead: the money owed back, and by how many companies. */
export function owedHeadline(figure: string, companies: number): string {
  return `${figure} owed to you across ${companies} ${companies === 1 ? 'company' : 'companies'}`;
}

export const OWED_LINE =
  'Each figure opens the sentence in the email it came from. Handle it, and Melete chases it until they pay.';
