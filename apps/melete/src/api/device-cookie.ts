import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DEVICE_COOKIE = 'melete_device';
export const DEVICE_TTL_SECONDS = 90 * 24 * 60 * 60;

export type KnownDevice = { account: string; nonce: string };

const encoded = /^[A-Za-z0-9_-]+$/;

/**
 * A browser that has signed in to an account before carries proof of it. The
 * proof never authenticates anybody: it only moves that browser's password
 * attempts out of the limiter strangers share for the account, so a stranger
 * who exhausts that limiter cannot keep a known browser from signing in.
 *
 * The value is `v1.<account>.<nonce>.<expiry>.<signature>`. The account is a
 * keyed digest of the email, so the cookie names no address; the nonce gives
 * each issued cookie its own attempt budget; the signature covers all of it.
 */
export class DeviceCookies {
  private readonly key: Buffer;

  /**
   * With a deployment secret the key survives a restart. Without one the key
   * lives as long as the process, and known browsers start over after it.
   */
  constructor(
    secret?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.key = secret
      ? createHmac('sha256', secret).update('melete device cookie v1').digest()
      : randomBytes(32);
  }

  private mac(value: string): Buffer {
    return createHmac('sha256', this.key).update(value).digest();
  }

  /** Names an account without storing its email. The input is already lower case. */
  account(email: string): string {
    return this.mac(`account\0${email}`).subarray(0, 16).toString('base64url');
  }

  issue(email: string): string {
    const expires = Math.floor(this.now() / 1000) + DEVICE_TTL_SECONDS;
    const body = `v1.${this.account(email)}.${randomBytes(16).toString('base64url')}.${expires}`;
    return `${body}.${this.mac(body).toString('base64url')}`;
  }

  /** Null for anything absent, malformed, expired or not signed by this installation. */
  verify(value: string | undefined): KnownDevice | null {
    if (!value || value.length > 256) return null;
    const parts = value.split('.');
    const [version, account, nonce, expires, signature] = parts;
    if (parts.length !== 5 || version !== 'v1' || !account || !nonce || !expires || !signature)
      return null;
    if (![account, nonce, signature].every((part) => encoded.test(part))) return null;
    if (!/^\d{1,12}$/.test(expires) || Number(expires) * 1000 <= this.now()) return null;
    const expected = this.mac(parts.slice(0, 4).join('.'));
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return { account, nonce };
  }
}
