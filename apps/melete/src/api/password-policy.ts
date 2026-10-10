/**
 * What a new password must not be, beyond its length (10 characters, in the
 * contract). Sign-in is limited to about one guess a minute per account, so the
 * passwords guessed first are the ones refused here: the most common ones, one
 * character repeated, a straight run of keys, and the account's own address.
 */
import { NEW_PASSWORD_MIN } from '@melete/contracts';
import { ServiceError } from './errors.ts';

/** Common passwords of the allowed length, lower-cased, from public breach lists. */
const COMMON = new Set([
  '0123456789',
  '1234567890',
  '12345678910',
  '123456789a',
  '1q2w3e4r5t',
  '1qaz2wsx3edc',
  'a123456789',
  'abc1234567',
  'abcdefghij',
  'administrator',
  'asdfghjkl1',
  'baseball123',
  'football123',
  'iloveyou12',
  'letmein123',
  'monkey1234',
  'password01',
  'password12',
  'password123',
  'password1234',
  'passwordpassword',
  'qazwsxedc123',
  'qwerty1234',
  'qwerty12345',
  'qwerty123456',
  'qwertyuiop',
  'qwertyuiop1',
  'sunshine123',
  'trustno1234',
  'welcome123',
  'welcome1234',
  'zaq12wsxcde',
  'melete1234',
  'melete12345',
]);

const RUNS = [
  '0123456789',
  '9876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];

/** Why a new password is refused, or null when it may be used. */
export function weakPasswordReason(password: string, email?: string): string | null {
  const plain = password.toLowerCase();
  if (password.length < NEW_PASSWORD_MIN)
    return `Choose a password of at least ${NEW_PASSWORD_MIN} characters.`;
  if (COMMON.has(plain)) return 'That password is one of the most common. Choose another.';
  if (new Set(plain).size === 1) return 'Choose a password that is not one character repeated.';
  if (RUNS.some((run) => run.includes(plain)))
    return 'Choose a password that is not a run of keys.';
  const address = email?.toLowerCase();
  if (address && (plain === address || plain === address.split('@')[0]))
    return 'Choose a password that is not your email address.';
  return null;
}

/** Refuses a weak new password with a 400 the forms show as it is. */
export function requireStrongPassword(password: string, email?: string): void {
  const reason = weakPasswordReason(password, email);
  if (reason) throw new ServiceError('weak_password', reason, 400);
}
