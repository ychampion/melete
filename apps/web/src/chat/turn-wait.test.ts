/** Which words join a running turn, and which wait for their own. */
import { expect, test } from 'bun:test';
import { joinsRunningTurn, waitsForTurn } from './turn-wait.ts';

test('plain words join a running turn', () => {
  expect(joinsRunningTurn('Wireless only.', true, 0)).toBe(true);
  expect(waitsForTurn('Wireless only.', true)).toBe(false);
});

test('words naming an agent wait for the turn, with or without a space after the @', () => {
  for (const text of [
    '@Scout check reviews',
    '@ Scout check reviews',
    '  @scout',
    '@Nobody here',
  ]) {
    expect(joinsRunningTurn(text, true, 0)).toBe(false);
    expect(waitsForTurn(text, true)).toBe(true);
  }
});

test('nothing waits when no turn runs, and files never join a turn', () => {
  expect(waitsForTurn('@Scout check reviews', false)).toBe(false);
  expect(joinsRunningTurn('Wireless only.', false, 0)).toBe(false);
  expect(joinsRunningTurn('Wireless only.', true, 1)).toBe(false);
});
