import { createHmac, timingSafeEqual } from 'node:crypto';
import { type CapabilityClaims, capabilityClaims } from '@melete/contracts';
import { z } from 'zod';

export const CAPABILITY_TTL_SECONDS = 30 * 60;

const headerSchema = z.object({ alg: z.literal('HS256'), typ: z.literal('JWT') }).strict();
const claimsSchema = capabilityClaims
  .extend({ budget: capabilityClaims.shape.budget.strict() })
  .strict();
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export class InvalidCapabilityError extends Error {
  override name = 'InvalidCapabilityError';
}

function assertKey(key: string): void {
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new Error('capability signing key must contain at least 32 bytes');
  }
}

/** The service sets exp from its clock plus CAPABILITY_TTL_SECONDS at admission. */
export function signCapability(claims: CapabilityClaims, key: string): string {
  assertKey(key);
  const parsed = claimsSchema.safeParse(claims);
  if (!parsed.success) throw new InvalidCapabilityError('invalid capability claims');
  const payload = Buffer.from(JSON.stringify(parsed.data)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = createHmac('sha256', key).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new InvalidCapabilityError('invalid capability encoding');
  }
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) {
    throw new InvalidCapabilityError('invalid capability encoding');
  }
  return decoded;
}

function parseJson(segment: string): unknown {
  try {
    return JSON.parse(decode(segment).toString('utf8')) as unknown;
  } catch {
    throw new InvalidCapabilityError('invalid capability JSON');
  }
}

/**
 * Authentication only: callers must also check the persisted job revision and
 * epoch before admitting work. A valid signature cannot make a stale lease current.
 */
export function verifyCapability(
  token: string,
  key: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): CapabilityClaims {
  assertKey(key);
  if (!Number.isFinite(nowSeconds)) throw new InvalidCapabilityError('invalid verification time');
  if (token.length > 16_384) throw new InvalidCapabilityError('capability is too large');
  const segments = token.split('.');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (segments.length !== 3 || !encodedHeader || !encodedPayload || !encodedSignature) {
    throw new InvalidCapabilityError('invalid capability format');
  }
  if (!headerSchema.safeParse(parseJson(encodedHeader)).success) {
    throw new InvalidCapabilityError('unsupported capability header');
  }
  const supplied = decode(encodedSignature);
  const expected = createHmac('sha256', key).update(`${encodedHeader}.${encodedPayload}`).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new InvalidCapabilityError('invalid capability signature');
  }
  const parsed = claimsSchema.safeParse(parseJson(encodedPayload));
  if (!parsed.success) throw new InvalidCapabilityError('invalid capability claims');
  if (parsed.data.exp <= nowSeconds) throw new InvalidCapabilityError('capability expired');
  return parsed.data;
}
