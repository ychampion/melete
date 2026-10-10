import { expect, test } from 'bun:test';
import { resetCodeFrom } from './account.ts';

const CODE = 'q3Xw9-Lk2_TfRbYp0aZcVdEeFgHhIiJjKkLlMmNnOoP';

test('a reset code is taken as pasted, or out of the whole link', () => {
  expect(resetCodeFrom(CODE)).toBe(CODE);
  expect(resetCodeFrom(`  ${CODE}\n`)).toBe(CODE);
  expect(resetCodeFrom(`https://melete.example/#/reset?token=${CODE}`)).toBe(CODE);
});

test('a mistyped code is caught before a new password is asked for', () => {
  expect(resetCodeFrom('abc123')).toBeNull();
  expect(resetCodeFrom('')).toBeNull();
  expect(resetCodeFrom(`${CODE.slice(0, 20)} ${CODE.slice(20)}`)).toBeNull();
  expect(resetCodeFrom('https://melete.example/#/reset')).toBeNull();
});
