import { describe, expect, test } from 'bun:test';
import { headerBlock, headerMessage } from '../connectors/mail-transport.ts';
import { parseAuthenticationResults, senderAuthentication } from './sender-auth.ts';

const GMAIL_PASS =
  'mx.google.com; dkim=pass header.i=@acme.test header.s=s1 header.b=AbCd; spf=pass (google.com: domain of ana@acme.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=ana@acme.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=acme.test';
const EXCHANGE_PASS =
  'spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=mail.acme.test; dkim=pass (signature was verified) header.d=acme.test;dmarc=pass action=none header.from=acme.test;compauth=pass reason=100';

describe('Authentication-Results', () => {
  test('reads results with or without an authserv-id, comments removed', () => {
    expect(parseAuthenticationResults(GMAIL_PASS).map((r) => [r.method, r.result])).toEqual([
      ['dkim', 'pass'],
      ['spf', 'pass'],
      ['dmarc', 'pass'],
    ]);
    const exchange = parseAuthenticationResults(EXCHANGE_PASS);
    expect(exchange.map((r) => r.method)).toEqual(['spf', 'dkim', 'dmarc', 'compauth']);
    expect(exchange[0]?.props['smtp.mailfrom']).toBe('mail.acme.test');
  });

  test('a sender passes only when a result aligns with the From domain', () => {
    expect(senderAuthentication(GMAIL_PASS, ['ana@acme.test'])).toBe('pass');
    expect(senderAuthentication(EXCHANGE_PASS, ['bo@billing.acme.test'])).toBe('pass');
    // Every result passes, but for another domain than the From address.
    expect(senderAuthentication(GMAIL_PASS, ['ana@other.test'])).toBe('fail');
    // Only an aligned SPF pass.
    expect(
      senderAuthentication('mx.example; spf=pass smtp.mailfrom=bounce@acme.test', [
        'ana@acme.test',
      ]),
    ).toBe('pass');
    expect(
      senderAuthentication('mx.example; spf=pass smtp.mailfrom=bounce@relay.test', [
        'ana@acme.test',
      ]),
    ).toBe('fail');
  });

  test('a DMARC failure fails, and no header or no result is none', () => {
    expect(
      senderAuthentication(
        'mx.google.com; dkim=pass header.d=acme.test; dmarc=fail (p=NONE) header.from=acme.test',
        ['ana@acme.test'],
      ),
    ).toBe('fail');
    expect(senderAuthentication(null, ['ana@acme.test'])).toBe('none');
    expect(senderAuthentication('mx.google.com; none', ['ana@acme.test'])).toBe('none');
    expect(senderAuthentication(GMAIL_PASS, [])).toBe('none');
    expect(senderAuthentication(GMAIL_PASS, ['ana@acme.test', 'eve@other.test'])).toBe('none');
  });

  test('a header the sender wrote below the receiving server’s own is ignored', async () => {
    const forged = await headerMessage(
      1,
      headerBlock([
        { name: 'Received', value: 'by mx.example.net; Fri, 2 Oct 2026 09:00:00 +0000' },
        {
          name: 'Authentication-Results',
          value:
            'mx.example.net; spf=fail smtp.mailfrom=acme.test; dmarc=fail header.from=acme.test',
        },
        { name: 'Received', value: 'from attacker.test; Fri, 2 Oct 2026 08:59:00 +0000' },
        {
          name: 'Authentication-Results',
          value: 'mx.example.net; dkim=pass header.d=acme.test; dmarc=pass header.from=acme.test',
        },
        { name: 'From', value: 'Ana <ana@acme.test>' },
        { name: 'Subject', value: 'Re: Quote for October' },
        { name: 'X-Spam-Flag', value: 'YES' },
      ]),
    );
    expect(forged.authentication_results).toContain('dmarc=fail');
    expect(senderAuthentication(forged.authentication_results, forged.from_addresses ?? [])).toBe(
      'fail',
    );
    expect(forged.spam).toBe(true);
    // With no header from the receiving server, nothing is authenticated.
    const bare = await headerMessage(
      2,
      headerBlock([
        { name: 'From', value: 'ana@acme.test' },
        { name: 'Subject', value: 'Hello' },
      ]),
    );
    expect(bare.authentication_results).toBeNull();
    expect(bare.spam).toBe(false);
  });
});
