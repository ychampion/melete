import { describe, expect, test } from 'bun:test';
import { saysVerbatim } from './broker-trust.ts';

describe('a value said verbatim', () => {
  test('is found as itself, ignoring case, at the end of a sentence or in brackets', () => {
    expect(saysVerbatim('Send the notes to dana@example.test', 'dana@example.test')).toBe(true);
    expect(saysVerbatim('Send them to Dana@Example.test.', 'dana@example.test')).toBe(true);
    expect(saysVerbatim('Ask Dana <dana@example.test> first', 'dana@example.test')).toBe(true);
    expect(saysVerbatim('Pay 120 for the room', '120')).toBe(true);
  });

  test('is not found inside a longer word, address, number or path', () => {
    expect(saysVerbatim('Write to xdana@example.test', 'dana@example.test')).toBe(false);
    expect(saysVerbatim('Write to dana@example.test.evil.io', 'dana@example.test')).toBe(false);
    expect(saysVerbatim('Meet at 3pm', '3')).toBe(false);
    expect(saysVerbatim('Pay 1200', '120')).toBe(false);
    expect(saysVerbatim('See https://example.test/a/b', 'https://example.test/a')).toBe(false);
    expect(saysVerbatim('anything', '   ')).toBe(false);
  });
});
