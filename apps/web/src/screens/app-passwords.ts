/**
 * What each mail kind needs before it can connect: an app password, why, and
 * where to make one. Kept apart from the form that draws it so the words can
 * change without touching the form.
 */

export type AppPasswordNote = { title: string; lines: string[] };

const WHY =
  'Melete connects to your mailbox over IMAP, the standard way mail apps read and send mail. Your provider lets it in with an app password: a separate password just for Melete, which you can remove at any time without changing your own.';

/** The one-screen explainer for the app password each mail kind needs, by kind id. */
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
