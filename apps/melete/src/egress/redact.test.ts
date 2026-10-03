import { describe, expect, test } from 'bun:test';
import { ByteRedactor } from './redact.ts';

describe('the byte redactor', () => {
  test('a secret split across chunks is still redacted, and other bytes pass unchanged', () => {
    const redactor = new ByteRedactor(['tok_secret', 'dG9rX3NlY3JldA==']);
    const input = Buffer.concat([
      Buffer.from([0, 255, 1]),
      Buffer.from('a tok_sec'),
      Buffer.from('ret b dG9rX3'),
      Buffer.from('NlY3JldA== c tok_'),
    ]);
    const chunks = [
      input.subarray(0, 7),
      input.subarray(7, 17),
      input.subarray(17, 30),
      input.subarray(30),
    ];
    const out = Buffer.concat([...chunks.map((chunk) => redactor.feed(chunk)), redactor.end()]);
    expect(out).toEqual(
      Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('a [redacted] b [redacted] c tok_')]),
    );
  });

  test('with no secret, bytes pass through untouched', () => {
    const redactor = new ByteRedactor([]);
    expect(redactor.feed(Buffer.from('abc'))).toEqual(Buffer.from('abc'));
    expect(redactor.text('Bearer x')).toBe('Bearer x');
  });
});
