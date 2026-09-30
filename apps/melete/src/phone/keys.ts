/**
 * The two secrets a phone line is checked with.
 *
 * The line key is made here, handed to ElevenLabs once as a workspace secret,
 * and kept only as a digest: ElevenLabs presents it on every turn and at the
 * start of every inbound call, and it is compared in constant time. The
 * webhook secret is ElevenLabs' own, sealed with the line's other credentials,
 * and signs the report at the end of each call.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How old a signed report may be. The official SDK allows the same thirty minutes. */
export const SIGNATURE_MAX_AGE_SECONDS = 30 * 60;
/** How far ahead of this clock a report's time may be. */
export const SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;

export function newLineKey(): string {
  return randomBytes(32).toString('base64url');
}

export function lineKeyDigest(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** Whether a presented key is the line's, compared digest to digest in constant time. */
export function lineKeyMatches(presented: string | undefined, digest: unknown): boolean {
  if (!presented || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) return false;
  const given = Buffer.from(lineKeyDigest(presented), 'hex');
  const stored = Buffer.from(digest, 'hex');
  return given.length === stored.length && timingSafeEqual(given, stored);
}

/**
 * Check an `ElevenLabs-Signature` header: `t=<seconds>,v0=<hex>`, where the hex
 * is HMAC-SHA256 over `<t>.<raw body>` with the webhook secret. The body is
 * checked as the bytes that arrived, before anything parses it.
 */
export function signatureValid(
  rawBody: string,
  header: string | undefined,
  secret: string,
  nowMs = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const fields = header.split(',').map((part) => part.trim());
  const stamp = fields.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = fields.filter((part) => part.startsWith('v0='));
  if (!stamp || !/^[0-9]{1,12}$/.test(stamp) || !signatures.length) return false;
  const age = Math.floor(nowMs / 1000) - Number(stamp);
  if (age > SIGNATURE_MAX_AGE_SECONDS || age < -SIGNATURE_MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(
    `v0=${createHmac('sha256', secret).update(`${stamp}.${rawBody}`, 'utf8').digest('hex')}`,
  );
  return signatures.some((signature) => {
    const given = Buffer.from(signature);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
