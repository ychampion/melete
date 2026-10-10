import { expect, test } from 'bun:test';
import { linkParam, parseHash } from './router.ts';

test('a mailed sign-in link opens the sign-in screen with its token', () => {
  const route = parseHash('#/welcome?token=Zm9v_YmFy-123');
  expect(route.parts).toEqual(['welcome']);
  expect(linkParam(route, 'token')).toBe('Zm9v_YmFy-123');
});

test('a link mailed before links took that form still signs in', () => {
  const route = parseHash('#token=Zm9v_YmFy-123');
  expect(linkParam(route, 'token')).toBe('Zm9v_YmFy-123');
});

test('the setup link carries its code, and a reset link its token', () => {
  expect(linkParam(parseHash('#/welcome?code=ABCD-EFGH-JKMN-PQRS-TVWX'), 'code')).toBe(
    'ABCD-EFGH-JKMN-PQRS-TVWX',
  );
  expect(linkParam(parseHash('#/reset?token=abc'), 'token')).toBe('abc');
});

test('a route without the value has none', () => {
  expect(linkParam(parseHash('#/welcome'), 'token')).toBeNull();
  expect(linkParam(parseHash(''), 'token')).toBeNull();
  expect(parseHash('').path).toBe('/');
});
