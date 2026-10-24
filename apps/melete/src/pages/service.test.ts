import { describe, expect, test } from 'bun:test';
import { PAGE_LIMITS } from '@melete/contracts';
import { newId } from '../ids.ts';
import {
  PageViewTokens,
  pageReportKey,
  pageTtl,
  pageWatchSpec,
  reportSigned,
  signReport,
  watchedPage,
} from './service.ts';

const SECRET = 'page-service-test-secret-0123456789abcdef';
const now = Date.UTC(2026, 9, 18, 12);
const seconds = Math.floor(now / 1000);

describe('report signatures', () => {
  const pageId = newId('cpg');
  const key = pageReportKey(SECRET, pageId);
  const body = JSON.stringify({ status: 'completed', summary: 'Done.' });
  const signed = (
    overrides: Partial<{ id: string; at: number; key: string; body: string }> = {},
  ) => ({
    id: overrides.id ?? 'msg_1',
    timestamp: String(overrides.at ?? seconds),
    signature: signReport(
      overrides.key ?? key,
      overrides.id ?? 'msg_1',
      overrides.at ?? seconds,
      overrides.body ?? body,
    ),
  });

  test('keys are per page and per installation', () => {
    expect(key).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(pageReportKey(SECRET, newId('cpg'))).not.toBe(key);
    expect(pageReportKey(`${SECRET}x`, pageId)).not.toBe(key);
  });

  test('a report signed with the page key, now, verifies', () => {
    expect(reportSigned(key, signed(), body, now)).toBe(true);
    // Several signatures, as during a key rotation: any one may match.
    const many = signed();
    many.signature = `v1,AAAA ${many.signature}`;
    expect(reportSigned(key, many, body, now)).toBe(true);
  });

  test('anything else does not', () => {
    expect(reportSigned(key, signed({ key: pageReportKey(SECRET, newId('cpg')) }), body, now)).toBe(
      false,
    );
    expect(reportSigned(key, signed({ body: '{}' }), body, now)).toBe(false);
    expect(reportSigned(key, { ...signed(), id: 'msg_2' }, body, now)).toBe(false);
    const late = seconds - PAGE_LIMITS.report_tolerance_seconds - 1;
    expect(reportSigned(key, signed({ at: late }), body, now)).toBe(false);
    const early = seconds + PAGE_LIMITS.report_tolerance_seconds + 1;
    expect(reportSigned(key, signed({ at: early }), body, now)).toBe(false);
    expect(
      reportSigned(key, { id: undefined, timestamp: undefined, signature: undefined }, body, now),
    ).toBe(false);
    expect(reportSigned(key, { ...signed(), signature: 'v2,abc' }, body, now)).toBe(false);
    expect(reportSigned(key, { ...signed(), timestamp: '12.5' }, body, now)).toBe(false);
  });

  test('random signatures never verify', () => {
    for (let index = 0; index < 500; index++) {
      const random = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
      expect(
        reportSigned(
          key,
          { id: 'msg_1', timestamp: String(seconds), signature: `v1,${random}` },
          body,
          now,
        ),
      ).toBe(false);
    }
  });
});

describe('page view tokens', () => {
  const tokens = new PageViewTokens(SECRET, () => now);
  const claims = { pageId: newId('cpg'), principalId: 'own_01', sessionTag: 'a'.repeat(32) };

  test('round-trip, and last no longer than the page', () => {
    const until = now + 60_000;
    const { token, expiresAt } = tokens.issue(claims, until);
    expect(expiresAt).toBe(Math.floor(until / 1000));
    expect(tokens.verify(token)).toMatchObject(claims);
  });

  test('a changed, foreign or expired token is refused', () => {
    const { token } = tokens.issue(claims, now + 60_000);
    const [body, mac] = token.split('.') as [string, string];
    const altered = Buffer.from(
      Buffer.from(body, 'base64url').toString().replace('own_01', 'own_02'),
    ).toString('base64url');
    expect(tokens.verify(`${altered}.${mac}`)).toBeNull();
    expect(new PageViewTokens(`${SECRET}x`, () => now).verify(token)).toBeNull();
    expect(new PageViewTokens(SECRET, () => now + 120_000).verify(token)).toBeNull();
    expect(tokens.verify(undefined)).toBeNull();
    expect(tokens.verify(`${token}.x`)).toBeNull();
  });
});

describe('page watches and times', () => {
  test('a page watch is recognised; other watches are not', () => {
    const pageId = newId('cpg');
    expect(watchedPage(pageWatchSpec(newId('conn'), pageId))).toBe(pageId);
    const other = { ...pageWatchSpec(newId('conn'), pageId), event_name: 'mail.new' };
    expect(watchedPage(other)).toBeNull();
  });

  test('a server may ask for a time within the limits', () => {
    const ask = (value: number | string) =>
      pageTtl({ _meta: { 'io.melete/page': { expires_in_seconds: value } } });
    expect(ask(900)).toBe(900);
    expect(ask(10)).toBe(PAGE_LIMITS.default_ttl_seconds);
    expect(ask(10 ** 9)).toBe(PAGE_LIMITS.max_ttl_seconds);
    expect(ask('900')).toBe(PAGE_LIMITS.default_ttl_seconds);
    expect(pageTtl({})).toBe(PAGE_LIMITS.default_ttl_seconds);
  });
});
