import { expect, test } from 'bun:test';
import { plainReference } from './activity.ts';

test('an activity row shows a reference a person can look up, and never a hash or an id of ours', () => {
  expect(plainReference('msg-4411')).toBe('msg-4411');
  expect(plainReference('ddf52893'.repeat(8))).toBeNull();
  expect(plainReference(`sha256:${'a'.repeat(64)}`)).toBeNull();
  expect(plainReference('bsess_01M3Y75DJYNQEVHKAJ6E6TZBC3')).toBeNull();
  expect(plainReference('brws_8fcafb00-6d06-4213-9a4e-0c1d2e3f4a5b')).toBeNull();
  expect(plainReference('del_1791582295515_ecebc01dfea9')).toBeNull();
  expect(plainReference(null)).toBeNull();
  expect(plainReference('  ')).toBeNull();
  expect(plainReference(`<${'a'.repeat(40)}@mail.example.test>`)).toBe(`<${'a'.repeat(23)}…`);
});
