import { createHmac, timingSafeEqual } from 'node:crypto';
import { type CapabilityClaims, capabilityClaims } from '@melete/contracts';

export class AuthenticationError extends Error {}

/** HS256 is fixed by the service contract; never select an algorithm from untrusted claims. */
export function verifyCapability(token: string, key: string, now = Date.now()): CapabilityClaims {
  if (Buffer.byteLength(key) < 32)
    throw new AuthenticationError('capability key is not configured');
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error();
    const [header, payload, signature] = parts as [string, string, string];
    if (![header, payload, signature].every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString());
    if (
      decoded.alg !== 'HS256' ||
      (decoded.typ !== undefined && decoded.typ !== 'JWT') ||
      decoded.crit
    ) {
      throw new Error();
    }
    const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const claims = capabilityClaims.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
    if (claims.exp <= Math.floor(now / 1000)) throw new Error();
    return claims;
  } catch {
    throw new AuthenticationError('invalid or expired attempt capability');
  }
}

/** Also exported for the attempt issuer; the wire shape is the frozen capabilityClaims schema. */
export function signCapability(claims: CapabilityClaims, key: string): string {
  if (Buffer.byteLength(key) < 32)
    throw new AuthenticationError('capability key is not configured');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(capabilityClaims.parse(claims))).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${createHmac('sha256', key).update(data).digest('base64url')}`;
}

export function matchesServiceKey(header: string | undefined, key: string): boolean {
  if (key.length < 32 || !header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
