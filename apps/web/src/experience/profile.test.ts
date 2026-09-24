import { expect, test } from 'bun:test';
import { givenName } from './profile.ts';

test('the service default is not a name, so the field starts empty', () => {
  expect(givenName({ name: 'there' })).toBe('');
  expect(givenName(null)).toBe('');
  expect(givenName(undefined)).toBe('');
});

test('a name the person gave comes back as they wrote it', () => {
  expect(givenName({ name: 'Sam Rivera' })).toBe('Sam Rivera');
  expect(givenName({ name: '  Sam ' })).toBe('Sam');
});
