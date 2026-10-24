/**
 * Time-based one-time codes (RFC 6238 over RFC 4226), and the `otpauth://` links
 * authenticator apps share. A saved sign-in keeps the code's secret sealed; the
 * service makes the current code from it only at the moment a page asks for one.
 */
import { createHmac } from 'node:crypto';

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** What makes one account's codes. `secret` is the raw key, never shown. */
export type TotpConfig = {
  secret: Uint8Array;
  algorithm: TotpAlgorithm;
  digits: 6 | 7 | 8;
  /** Seconds each code lasts. */
  period: number;
};

/** Why a code secret or link could not be read. Never carries the secret itself. */
export class TotpInvalid extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'TotpInvalid';
  }
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Base32 as authenticator apps write it (RFC 4648): case, spaces, dashes and
 * padding are forgiven; any other character is refused.
 */
export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) throw new TotpInvalid('The code secret is empty.');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new TotpInvalid('The code secret has a character base32 does not use.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** The HOTP value of one counter (RFC 4226, section 5.3), as a zero-padded string. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits: number,
  algorithm: TotpAlgorithm = 'SHA1',
): string {
  if (!Number.isSafeInteger(counter) || counter < 0) throw new TotpInvalid('Bad counter.');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm.toLowerCase(), secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for a moment, in milliseconds since the epoch. */
export function totpAt(config: TotpConfig, at: number): string {
  return hotp(
    config.secret,
    Math.floor(at / 1000 / config.period),
    config.digits,
    config.algorithm,
  );
}

/** The current code and how many whole seconds it has left. */
export function currentCode(
  config: TotpConfig,
  now = Date.now(),
): { code: string; expires_in: number } {
  const step = config.period * 1000;
  return {
    code: totpAt(config, now),
    expires_in: Math.max(1, Math.ceil((step - (now % step)) / 1000)),
  };
}

/**
 * Whether a code someone typed is good now, allowing `window` steps either side
 * for a clock that is a little off. Compared in constant time per candidate.
 */
export function verifyTotp(
  config: TotpConfig,
  code: string,
  now = Date.now(),
  window = 1,
): boolean {
  if (!/^\d+$/.test(code) || code.length !== config.digits) return false;
  const counter = Math.floor(now / 1000 / config.period);
  let matched = false;
  for (let skew = -window; skew <= window; skew++) {
    if (counter + skew < 0) continue;
    const candidate = hotp(config.secret, counter + skew, config.digits, config.algorithm);
    let difference = 0;
    for (let index = 0; index < candidate.length; index++)
      difference |= candidate.charCodeAt(index) ^ code.charCodeAt(index);
    if (difference === 0) matched = true;
  }
  return matched;
}

const ALGORITHMS = new Set<TotpAlgorithm>(['SHA1', 'SHA256', 'SHA512']);
/** Below this a key is too short to trust; RFC 4226 asks for at least 128 bits. */
const MIN_SECRET_BYTES = 10;
const MAX_SECRET_BYTES = 128;

function checkedConfig(config: TotpConfig): TotpConfig {
  if (config.secret.length < MIN_SECRET_BYTES)
    throw new TotpInvalid('The code secret is too short to be a real one.');
  if (config.secret.length > MAX_SECRET_BYTES)
    throw new TotpInvalid('The code secret is too long.');
  if (!ALGORITHMS.has(config.algorithm))
    throw new TotpInvalid('Only SHA1, SHA256 and SHA512 codes are supported.');
  if (![6, 7, 8].includes(config.digits)) throw new TotpInvalid('Codes must be 6, 7 or 8 digits.');
  if (!Number.isInteger(config.period) || config.period < 10 || config.period > 300)
    throw new TotpInvalid('A code must last between 10 and 300 seconds.');
  return config;
}

/**
 * What a person pastes: a bare base32 secret, or an `otpauth://totp/...` link
 * from a site's set-up page (Key Uri Format). HOTP links are refused: their
 * counter would have to be kept in step with the site's.
 */
export function parseTotpInput(input: string): TotpConfig {
  const text = input.trim();
  if (!/^otpauth:/i.test(text))
    return checkedConfig({ secret: base32Decode(text), algorithm: 'SHA1', digits: 6, period: 30 });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TotpInvalid('The otpauth link could not be read.');
  }
  if (url.protocol !== 'otpauth:') throw new TotpInvalid('The otpauth link could not be read.');
  // `new URL` keeps a non-special scheme's authority as the host: `otpauth://totp/...`.
  const type = (url.host || url.pathname.replace(/^\/\//, '').split('/')[0] || '').toLowerCase();
  if (type === 'hotp') throw new TotpInvalid('Counter-based (HOTP) codes are not supported.');
  if (type !== 'totp') throw new TotpInvalid('The otpauth link is not for time-based codes.');
  const secret = url.searchParams.get('secret');
  if (!secret) throw new TotpInvalid('The otpauth link has no secret.');
  const algorithm = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '');
  const digits = Number(url.searchParams.get('digits') ?? '6');
  const period = Number(url.searchParams.get('period') ?? '30');
  return checkedConfig({
    secret: base32Decode(secret),
    algorithm: algorithm as TotpAlgorithm,
    digits: digits as TotpConfig['digits'],
    period,
  });
}

/** What is sealed for a code: the key as base32 and how codes are made from it. */
export type SealedTotp = {
  secret: string;
  algorithm: TotpAlgorithm;
  digits: number;
  period: number;
};

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export const sealableTotp = (config: TotpConfig): SealedTotp => ({
  secret: base32Encode(config.secret),
  algorithm: config.algorithm,
  digits: config.digits,
  period: config.period,
});

export const totpFromSealed = (sealed: SealedTotp): TotpConfig =>
  checkedConfig({
    secret: base32Decode(sealed.secret),
    algorithm: sealed.algorithm,
    digits: sealed.digits as TotpConfig['digits'],
    period: sealed.period,
  });
