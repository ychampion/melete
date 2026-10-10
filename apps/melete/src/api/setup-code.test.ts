import { expect, test } from 'bun:test';
import { newSetupCode, normalizeSetupCode, setupCodeHash, setupLink } from './setup-code.ts';

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
