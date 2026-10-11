import { expect, test } from 'bun:test';
import {
  isLoopbackHost,
  newSetupCode,
  normalizeSetupCode,
  openClaimRefused,
  publicAddress,
  setupCodeHash,
  setupLink,
} from './setup-code.ts';

test('a setup code is five groups of four characters nobody misreads', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-HJKMNP-TV-Z2-9]{4}(-[A-HJKMNP-TV-Z2-9]{4}){4}$/);
    seen.add(code);
  }
  expect(seen.size).toBe(2000);
});

test('the code matches however it is typed', () => {
  const code = 'ABCD-EFGH-JKMN-PQRS-TVWX';
  expect(normalizeSetupCode(' abcd efgh-jkmn pqrs tvwx ')).toBe('ABCDEFGHJKMNPQRSTVWX');
  expect(setupCodeHash('abcdefghjkmnpqrstvwx')).toBe(setupCodeHash(code));
  expect(setupCodeHash(code)).toMatch(/^[0-9a-f]{64}$/);
});

test('the setup link opens the sign-in screen with the code, in the fragment', () => {
  const link = new URL(setupLink('https://melete.example.com/', 'ABCD-EFGH-JKMN-PQRS-TVWX'));
  expect(link.pathname).toBe('/');
  expect(link.search).toBe('');
  expect(link.hash).toBe('#/welcome?code=ABCD-EFGH-JKMN-PQRS-TVWX');
});

test('only names and addresses of this machine count as loopback', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'melete.localhost',
    '127.0.0.1',
    '127.255.3.9',
    '::1',
    '[::1]',
  ])
    expect([host, isLoopbackHost(host)]).toEqual([host, true]);
  for (const host of [
    'melete.example.test',
    'localhost.example.test',
    '127.0.0.1.nip.io',
    '128.0.0.1',
    '10.0.0.5',
    '192.168.1.20',
    '0.0.0.0',
    '[::]',
    '[::ffff:7f00:1]',
    '',
  ])
    expect([host, isLoopbackHost(host)]).toEqual([host, false]);
});

test('an address other machines reach is found in either setting, as written', () => {
  expect(publicAddress({})).toBeNull();
  expect(publicAddress({ MELETE_PUBLIC_URL: '', MELETE_WEB_ORIGIN: '  ' })).toBeNull();
  for (const local of [
    'http://127.0.0.1:3101',
    'http://localhost:3101/',
    'http://[::1]:3101',
    'http://[0:0:0:0:0:0:0:1]:3101',
    'http://127.1:3101',
  ])
    expect([local, publicAddress({ MELETE_PUBLIC_URL: local })]).toEqual([local, null]);
  expect(
    publicAddress({
      MELETE_PUBLIC_URL: 'http://127.0.0.1:3101',
      MELETE_WEB_ORIGIN: 'https://melete.tail1a2b3.ts.net',
    }),
  ).toBe('https://melete.tail1a2b3.ts.net');
  expect(publicAddress({ MELETE_PUBLIC_URL: 'https://melete.example.com' })).toBe(
    'https://melete.example.com',
  );
  // Not a URL: nothing says it stays on this machine.
  expect(publicAddress({ MELETE_WEB_ORIGIN: 'melete.example.com' })).toBe('melete.example.com');
});

test('the first visitor is refused only at a public address the operator did not open', () => {
  const exposed = { MELETE_PUBLIC_URL: 'https://melete.example.com' };
  expect(openClaimRefused(exposed)).toBe(true);
  expect(openClaimRefused({ ...exposed, MELETE_SETUP_OPEN: false })).toBe(true);
  expect(openClaimRefused({ ...exposed, MELETE_SETUP_OPEN: true })).toBe(false);
  expect(openClaimRefused({ MELETE_PUBLIC_URL: 'http://127.0.0.1:3101' })).toBe(false);
  expect(openClaimRefused({})).toBe(false);
});
