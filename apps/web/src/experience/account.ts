/**
 * The account's way in and out on this browser: how long a new password must
 * be, what signing out does to this browser's notifications, and the shape a
 * reset code has before it is worth sending.
 */
import { adapter } from './adapter.ts';
import { enablePush, forgetThisBrowser, thisBrowserHash, thisDeviceSubscribed } from './push.ts';

/** The service refuses a shorter new password; the forms say so before asking. */
export const NEW_PASSWORD_MIN = 10;

/**
 * Stops notifications reaching this browser before it signs out: the service
 * forgets the subscription while the session still allows it, and the browser
 * forgets it too, so the next person to use it does not get them.
 */
export async function stopPushHere(): Promise<void> {
  try {
    const hash = await thisBrowserHash();
    if (hash === null) return;
    const listed = await adapter.pushDevices();
    const mine = listed.data?.subscriptions.find((device) => device.endpoint_hash === hash);
    if (mine) await adapter.removePushDevice(mine.id);
    await forgetThisBrowser();
  } catch {
    // The browser would not say; signing out goes ahead regardless.
  }
}

/**
 * Uses an invite while this browser may be signed in to another account. The
 * invite signs this browser in as the new account, and the service ends the
 * old sign-in, so the old account's notifications are stopped here first,
 * while its session can still say so; otherwise they would keep reaching the
 * new person's browser.
 */
export async function consumingAsAnotherAccount<T extends { data: { signed_in?: boolean } | null }>(
  signedInHere: boolean,
  consume: () => Promise<T>,
  push: {
    subscribed: () => Promise<boolean>;
    stop: () => Promise<void>;
    restart: () => Promise<unknown>;
  } = { subscribed: thisDeviceSubscribed, stop: stopPushHere, restart: enablePush },
): Promise<T> {
  if (!signedInHere) return consume();
  const before = await push.subscribed().catch(() => false);
  await push.stop();
  const result = await consume();
  // The browser is still the old account's when the invite was refused or
  // signed nobody in, so its notifications come back.
  if (before && !result.data?.signed_in) await push.restart().catch(() => undefined);
  return result;
}

/**
 * Runs something that ends the account's other access, which takes every
 * browser's notifications with it, and then subscribes this browser again if
 * it was subscribed before. Notifications are already allowed here, so the
 * browser does not ask again.
 */
export async function keepingPushHere<T extends { data: unknown }>(
  run: () => Promise<T>,
): Promise<T> {
  const before = await thisDeviceSubscribed().catch(() => false);
  const result = await run();
  if (before && result.data !== null) await enablePush().catch(() => undefined);
  return result;
}

/**
 * The words on the password page: a new account's invite asks the person to
 * choose their password and carries on to setting up; a reset keeps its own.
 */
export function passwordPageWords(invite: boolean) {
  return invite
    ? {
        title: 'Welcome to Melete',
        heading: 'Choose your password',
        lead: 'You’ll use it with your email to sign in. Next, a few quick questions to set things up.',
        field: 'Password',
        submit: 'Continue',
      }
    : {
        title: 'Reset your password',
        heading: 'Choose a new password',
        lead: null,
        field: 'New password',
        submit: 'Set the new password',
      };
}

/**
 * The code in what a person pasted: the code itself, or the whole link a reset
 * mail or printed command gave them. Null when it cannot be a reset code, so
 * a mistyped one is caught before a new password is chosen.
 */
export function resetCodeFrom(pasted: string): string | null {
  const text = pasted.trim();
  const fromLink = /[?&#]token=([A-Za-z0-9_-]+)/.exec(text)?.[1];
  const code = fromLink ?? text;
  return /^[A-Za-z0-9_-]{40,200}$/.test(code) ? code : null;
}
