import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  ASSERTION_TTL_SECONDS,
  IdentitySigner,
  identityAudience,
  verifyAssertion,
} from './assertion.ts';

const SECRET = 'identity-test-secret-0123456789abcdef';
const ISSUER = 'https://melete.example.test/api';
const AUDIENCE = 'https://desk.example.test';
const now = Date.UTC(2026, 9, 18, 12);

const signer = new IdentitySigner(SECRET, ISSUER, () => now);
const issue = (principalId = 'own_01ABC', entitlements: string[] = ['verified']) =>
  signer.issue({
    audience: AUDIENCE,
    principalId,
    entitlements,
    actionId: 'act_1',
    tool: 'open_form',
  });

describe('identity assertions', () => {
  test('verify against the published key, with the claims a server needs', () => {
    const claims = verifyAssertion(
      issue(),
      signer.jwk,
      { issuer: ISSUER, audience: AUDIENCE },
      now,
    );
    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: AUDIENCE,
      ent: ['verified'],
      jti: 'act_1',
      act: 'open_form',
      exp: Math.floor(now / 1000) + ASSERTION_TTL_SECONDS,
    });
    expect(signer.jwks().keys).toEqual([signer.jwk]);
  });

  test('the same installation signs alike after a restart', () => {
    expect(new IdentitySigner(SECRET, ISSUER).jwk).toEqual(signer.jwk);
  });

  test('the subject is per audience and is not the account id', () => {
    const sub = signer.subjectFor(AUDIENCE, 'own_01ABC');
    expect(sub).not.toContain('own_01ABC');
    expect(signer.subjectFor('https://other.example.test', 'own_01ABC')).not.toBe(sub);
    expect(signer.subjectFor(AUDIENCE, 'own_01ABD')).not.toBe(sub);
    expect(new IdentitySigner(`${SECRET}x`, ISSUER).subjectFor(AUDIENCE, 'own_01ABC')).not.toBe(
      sub,
    );
  });

  test('a forged, altered, foreign, misaddressed or expired assertion does not verify', () => {
    const token = issue();
    const expect_ = { issuer: ISSUER, audience: AUDIENCE };
    const [header, body, signature] = token.split('.') as [string, string, string];
    // Claims edited to add an entitlement, with the old signature.
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
    const forged = Buffer.from(
      JSON.stringify({ ...claims, ent: ['verified'], sub: 'p_attackerattackerattacker' }),
    ).toString('base64url');
    expect(
      verifyAssertion(`${header}.${forged}.${signature}`, signer.jwk, expect_, now),
    ).toBeNull();
    // Signed by someone else's key.
    const other = new IdentitySigner('someone-else-0123456789abcdef', ISSUER, () => now);
    const theirs = other.issue({
      audience: AUDIENCE,
      principalId: 'own_01ABC',
      entitlements: ['verified'],
      actionId: 'a',
      tool: 't',
    });
    expect(verifyAssertion(theirs, signer.jwk, expect_, now)).toBeNull();
    // `alg: none`.
    const none = Buffer.from(
      JSON.stringify({ alg: 'none', typ: 'JWT', kid: signer.jwk.kid }),
    ).toString('base64url');
    expect(verifyAssertion(`${none}.${body}.`, signer.jwk, expect_, now)).toBeNull();
    expect(
      verifyAssertion(token, signer.jwk, { ...expect_, audience: 'https://other.test' }, now),
    ).toBeNull();
    expect(
      verifyAssertion(token, signer.jwk, { ...expect_, issuer: 'https://other.test' }, now),
    ).toBeNull();
    expect(
      verifyAssertion(token, signer.jwk, expect_, now + ASSERTION_TTL_SECONDS * 1000),
    ).toBeNull();
    expect(verifyAssertion('not.a.jwt', signer.jwk, expect_, now)).toBeNull();
    expect(verifyAssertion('', signer.jwk, expect_, now)).toBeNull();
  });

  test('a token signed with HMAC over the public key (alg confusion) does not verify', () => {
    const body = issue().split('.')[1] as string;
    for (const alg of ['HS256', 'EdDSA']) {
      const head = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid: signer.jwk.kid })).toString(
        'base64url',
      );
      const mac = createHmac('sha256', Buffer.from(signer.jwk.x, 'base64url'))
        .update(`${head}.${body}`)
        .digest('base64url');
      expect(
        verifyAssertion(
          `${head}.${body}.${mac}`,
          signer.jwk,
          { issuer: ISSUER, audience: AUDIENCE },
          now,
        ),
      ).toBeNull();
    }
  });

  test('the audience is the endpoint, so servers on one host do not share assertions', () => {
    expect(identityAudience('https://tools.example.test/desk/mcp/?key=secret#x')).toBe(
      'https://tools.example.test/desk/mcp',
    );
    expect(identityAudience('https://tools.example.test')).toBe('https://tools.example.test');
    const desk = identityAudience('https://tools.example.test/desk/mcp');
    const other = identityAudience('https://tools.example.test/other/mcp');
    expect(desk).not.toBe(other);
    const token = signer.issue({
      audience: desk,
      principalId: 'own_01ABC',
      entitlements: ['verified'],
      actionId: 'act_1',
      tool: 'open_form',
    });
    expect(
      verifyAssertion(token, signer.jwk, { issuer: ISSUER, audience: desk }, now),
    ).not.toBeNull();
    for (const audience of [other, 'https://tools.example.test'])
      expect(verifyAssertion(token, signer.jwk, { issuer: ISSUER, audience }, now)).toBeNull();
    expect(signer.subjectFor(desk, 'own_01ABC')).not.toBe(signer.subjectFor(other, 'own_01ABC'));
  });

  test('an entitlement Melete does not know is never issued', () => {
    expect(() => issue('own_01ABC', ['admin'])).toThrow();
  });
});
