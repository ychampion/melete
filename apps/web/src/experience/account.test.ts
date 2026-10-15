import { expect, test } from 'bun:test';
import { consumingAsAnotherAccount, passwordPageWords, resetCodeFrom } from './account.ts';

const CODE = 'q3Xw9-Lk2_TfRbYp0aZcVdEeFgHhIiJjKkLlMmNnOoP';

test('a reset code is taken as pasted, or out of the whole link', () => {
  expect(resetCodeFrom(CODE)).toBe(CODE);
  expect(resetCodeFrom(`  ${CODE}\n`)).toBe(CODE);
  expect(resetCodeFrom(`https://melete.example/#/reset?token=${CODE}`)).toBe(CODE);
});

test('an invite asks for your password; a reset keeps its own words', () => {
  expect(passwordPageWords(true)).toMatchObject({
    title: 'Welcome to Melete',
    heading: 'Choose your password',
    submit: 'Continue',
  });
  expect(passwordPageWords(false)).toEqual({
    title: 'Reset your password',
    heading: 'Choose a new password',
    lead: null,
    field: 'New password',
    submit: 'Set the new password',
  });
  // An invite never talks about being signed out or about a reset.
  expect(JSON.stringify(passwordPageWords(true))).not.toMatch(/signed out|reset|new password/i);
});

test('a mistyped code is caught before a new password is asked for', () => {
  expect(resetCodeFrom('abc123')).toBeNull();
  expect(resetCodeFrom('')).toBeNull();
  expect(resetCodeFrom(`${CODE.slice(0, 20)} ${CODE.slice(20)}`)).toBeNull();
  expect(resetCodeFrom('https://melete.example/#/reset')).toBeNull();
});

test("an invite stops the old account's notifications here, and brings them back if it signs nobody in", async () => {
  const calls: string[] = [];
  const push = {
    subscribed: async () => true,
    stop: async () => void calls.push('stop'),
    restart: async () => void calls.push('restart'),
  };
  await consumingAsAnotherAccount(true, async () => ({ data: { signed_in: true } }), push);
  expect(calls).toEqual(['stop']);
  calls.length = 0;
  await consumingAsAnotherAccount(true, async () => ({ data: null }), push);
  expect(calls).toEqual(['stop', 'restart']);
  calls.length = 0;
  await consumingAsAnotherAccount(true, async () => ({ data: { signed_in: false } }), push);
  expect(calls).toEqual(['stop', 'restart']);
  calls.length = 0;
  await consumingAsAnotherAccount(false, async () => ({ data: null }), push);
  expect(calls).toEqual([]);
});
