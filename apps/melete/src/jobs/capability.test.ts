import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { CapabilityClaims } from '@melete/contracts';
import {
  CAPABILITY_TTL_SECONDS,
  InvalidCapabilityError,
  signCapability,
  verifyCapability,
} from './capability.ts';

const key = 'test-capability-key-at-least-32-bytes';
const now = 1_789_113_600;
const claims: CapabilityClaims = {
  job_id: 'job_01J00000000000000000000000',
  attempt_id: 'att_01J00000000000000000000000',
  space_id: 'sp_01J00000000000000000000000',
  epoch: 2,
  revision: 3,
  scopes: ['files.read', 'web.fetch'],
  budget: { max_actions: 4, max_output_tokens: 1200, max_usd_est: 0.5 },
  exp: now + CAPABILITY_TTL_SECONDS,
};

function rawToken(payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }): string {
  const unsigned = [header, payload]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`;
}

describe('attempt capabilities', () => {
  test('round-trips the frozen claims, including space, scopes, budget and 30 minute expiry', () => {
    expect(CAPABILITY_TTL_SECONDS).toBe(1800);
    const token = signCapability(claims, key);
    expect(verifyCapability(token, key, now)).toEqual(claims);
    expect(JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
  });

  test('rejects a changed payload and a changed signing key', () => {
    const token = signCapability(claims, key);
    const pieces = token.split('.');
    pieces[1] = Buffer.from(JSON.stringify({ ...claims, epoch: 99 })).toString('base64url');
    expect(() => verifyCapability(pieces.join('.'), key, now)).toThrow('signature');
    expect(() => verifyCapability(token, 'a-different-key-of-at-least-32-bytes', now)).toThrow(
      'signature',
    );
  });

  test('rejects an invalid signature without a length-dependent comparison exception', () => {
    const token = signCapability(claims, key);
    const unsigned = token.slice(0, token.lastIndexOf('.'));
    expect(() => verifyCapability(`${unsigned}.eA`, key, now)).toThrow(InvalidCapabilityError);
  });

  test('expires at the exact exp boundary', () => {
    const token = signCapability(claims, key);
    expect(verifyCapability(token, key, claims.exp - 1).epoch).toBe(2);
    expect(() => verifyCapability(token, key, claims.exp)).toThrow('expired');
  });

  test.each(['none', 'RS256', 'HS512'])('rejects algorithm %s even with a valid HMAC', (alg) => {
    expect(() => verifyCapability(rawToken(claims, { alg, typ: 'JWT' }), key, now)).toThrow(
      'header',
    );
  });

  test('rejects unsupported header parameters and token types', () => {
    expect(() =>
      verifyCapability(rawToken(claims, { alg: 'HS256', typ: 'JWT', crit: ['b64'] }), key, now),
    ).toThrow('header');
    expect(() =>
      verifyCapability(rawToken(claims, { alg: 'HS256', typ: 'other' }), key, now),
    ).toThrow('header');
  });

  test.each([
    { ...claims, space_id: undefined },
    { ...claims, attempt_id: 'att_invalid' },
    { ...claims, epoch: -1 },
    { ...claims, revision: 1.5 },
    { ...claims, exp: 'tomorrow' },
    { ...claims, scopes: [7] },
    { ...claims, budget: { ...claims.budget, max_actions: -1 } },
    { ...claims, extra: true },
    { ...claims, budget: { ...claims.budget, unbounded: true } },
  ])('rejects signed claims outside the frozen schema: %j', (invalid) => {
    expect(() => verifyCapability(rawToken(invalid), key, now)).toThrow('claims');
  });

  test.each(['', 'a.b', 'a.b.c.d', 'a=.b.c', 'a.b.###'])(
    'rejects malformed compact JWT %j',
    (token) => {
      expect(() => verifyCapability(token, key, now)).toThrow(InvalidCapabilityError);
    },
  );

  test('requires a signing key of at least 32 bytes for signing and verification', () => {
    expect(() => signCapability(claims, 'short')).toThrow('32 bytes');
    expect(() => verifyCapability(rawToken(claims), 'short', now)).toThrow('32 bytes');
  });

  test('rejects an invalid verification clock and oversized tokens', () => {
    expect(() => verifyCapability(rawToken(claims), key, Number.NaN)).toThrow('time');
    expect(() => verifyCapability('a'.repeat(16_385), key, now)).toThrow('large');
  });
});
