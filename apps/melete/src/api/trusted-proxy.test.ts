import { describe, expect, test } from 'bun:test';
import { trustedProxy } from './listener.ts';

describe('trusted web proxy', () => {
  test('nothing is trusted until the deployment names its proxy', async () => {
    const trusts = trustedProxy(undefined);
    expect(await trusts('172.20.0.5')).toBe(false);
    expect(await trusts('127.0.0.1')).toBe(false);
  });

  test('a literal address trusts exactly that peer', async () => {
    const trusts = trustedProxy('172.20.0.5');
    expect(await trusts('172.20.0.5')).toBe(true);
    expect(await trusts('::ffff:172.20.0.5')).toBe(true);
    expect(await trusts('172.20.0.50')).toBe(false);
    expect(await trusts('172.20.0.1')).toBe(false);
  });

  test('a service name follows the address it currently resolves to', async () => {
    let now = 0;
    let address: string | null = null;
    let lookups = 0;
    const trusts = trustedProxy(
      'web',
      async (name) => {
        lookups++;
        expect(name).toBe('web');
        if (!address) throw new Error('ENOTFOUND');
        return [address];
      },
      () => now,
    );
    // The proxy starts after the API, so an unresolved name trusts nobody and is retried soon.
    expect(await trusts('172.20.0.5')).toBe(false);
    expect(await trusts('172.20.0.5')).toBe(false);
    expect(lookups).toBe(1);
    address = '172.20.0.5';
    now = 5_000;
    expect(await trusts('172.20.0.5')).toBe(true);
    expect(await trusts('172.20.0.9')).toBe(false);
    expect(lookups).toBe(2);
    // A recreated proxy gets a new address; the old one stops being trusted within the cache life.
    address = '172.20.0.7';
    now = 34_999;
    expect(await trusts('172.20.0.5')).toBe(true);
    now = 35_000;
    expect(await trusts('172.20.0.5')).toBe(false);
    expect(await trusts('172.20.0.7')).toBe(true);
    expect(lookups).toBe(3);
  });
});
