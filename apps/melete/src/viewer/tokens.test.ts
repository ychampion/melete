import { describe, expect, test } from 'bun:test';
import { sessionTag, VIEW_TTL_SECONDS, ViewTokens } from './tokens.ts';

const VERSION = 'a'.repeat(64);
const claims = {
  principalId: 'own_01ABC',
  appId: 'app_0123abcd',
  versionId: VERSION,
  grantGeneration: 3,
  sessionTag: sessionTag('d'.repeat(64)),
};

describe('view tokens', () => {
  test('name the person, app, version and grant generation they were issued for', () => {
    const tokens = new ViewTokens('k'.repeat(64));
    const { token, expiresAt } = tokens.issue(claims);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(tokens.verify(token)).toEqual({ ...claims, expiresAt });
  });

  test('end twelve hours after they are issued', () => {
    let now = 1_800_000_000_000;
    const tokens = new ViewTokens('k'.repeat(64), () => now);
    const { token } = tokens.issue(claims);
    now += (VIEW_TTL_SECONDS - 1) * 1000;
    expect(tokens.verify(token)).not.toBeNull();
    now += 1000;
    expect(tokens.verify(token)).toBeNull();
  });

  test('are refused when changed, or signed by another installation', () => {
    const tokens = new ViewTokens('k'.repeat(64));
    const { token } = tokens.issue(claims);
    const [body, signature] = token.split('.') as [string, string];
    const forged = Buffer.from(
      Buffer.from(body, 'base64url').toString().replace('.3.', '.4.'),
    ).toString('base64url');
    expect(tokens.verify(`${forged}.${signature}`)).toBeNull();
    expect(new ViewTokens('j'.repeat(64)).verify(token)).toBeNull();
    expect(new ViewTokens().verify(token)).toBeNull();
    for (const bad of ['', '.', `${body}.`, `${token}.x`, `${body}.${'A'.repeat(43)}`, 'a b.c'])
      expect(tokens.verify(bad)).toBeNull();
  });

  test("name the session by a tag that is not the session's own digest", () => {
    const digest = 'd'.repeat(64);
    expect(sessionTag(digest)).toMatch(/^[0-9a-f]{32}$/);
    expect(digest.startsWith(sessionTag(digest))).toBe(false);
    expect(sessionTag('e'.repeat(64))).not.toBe(sessionTag(digest));
  });

  test('without a master key, last as long as the process that signed them', () => {
    const tokens = new ViewTokens();
    expect(tokens.verify(tokens.issue(claims).token)).not.toBeNull();
    expect(new ViewTokens().verify(tokens.issue(claims).token)).toBeNull();
  });
});
