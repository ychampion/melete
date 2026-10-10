import { expect, test } from 'bun:test';
import { weakPasswordReason } from './password-policy.ts';

test('the passwords guessed first are refused, with the reason', () => {
  expect(weakPasswordReason('short-pw')).toContain('at least 10');
  expect(weakPasswordReason('Password123')).toContain('most common');
  expect(weakPasswordReason('aaaaaaaaaaaa')).toContain('repeated');
  expect(weakPasswordReason('3456789012')).toBeNull();
  expect(weakPasswordReason('2345678901'.slice(0, 10))).toBeNull();
  expect(weakPasswordReason('abcdefghijkl')).toContain('run of keys');
  expect(weakPasswordReason('asdfghjklz')).toContain('run of keys');
  expect(weakPasswordReason('9876543210')).toContain('run of keys');
  expect(weakPasswordReason('sam.jones1', 'Sam.Jones1@example.com')).toContain('email');
  expect(weakPasswordReason('sam.jones1@example.com', 'sam.jones1@example.com')).toContain('email');
});

test('an ordinary long password is accepted', () => {
  for (const password of ['a-good-long-password', 'correct horse battery', 'Tr0ub4dor&3x'])
    expect(weakPasswordReason(password, 'sam@example.com')).toBeNull();
});
