import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { lineKeyDigest, lineKeyMatches, newLineKey, signatureValid } from './keys.ts';

const sign = (secret: string, body: string, at: number) =>
  `t=${at},v0=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`;

describe('the line key', () => {
  test("only the line's own key matches its digest", () => {
    const key = newLineKey();
    const other = newLineKey();
    const digest = lineKeyDigest(key);
    expect(lineKeyMatches(key, digest)).toBe(true);
    expect(lineKeyMatches(other, digest)).toBe(false);
    expect(lineKeyMatches(undefined, digest)).toBe(false);
    expect(lineKeyMatches('', digest)).toBe(false);
    expect(lineKeyMatches(key, undefined)).toBe(false);
    expect(lineKeyMatches(key, 'not-a-digest')).toBe(false);
    // The digest itself is not the key.
    expect(lineKeyMatches(digest, digest)).toBe(false);
  });
});

describe('the end-of-call signature', () => {
  const secret = 'wsec_line_secret';
  const body = '{"type":"post_call_transcription","data":{}}';
  const now = 1_790_000_000_000;
  const at = Math.floor(now / 1000);

  test('a report signed with the line secret over the exact bytes is accepted', () => {
    expect(signatureValid(body, sign(secret, body, at), secret, now)).toBe(true);
    // Whitespace between fields, and a second signature beside it, are both read.
    expect(
      signatureValid(
        body,
        `t=${at}, v0=00ff, ${sign(secret, body, at).split(',')[1]}`,
        secret,
        now,
      ),
    ).toBe(true);
  });

  test('a missing, malformed, foreign, altered, stale or future signature is refused', () => {
    expect(signatureValid(body, undefined, secret, now)).toBe(false);
    expect(signatureValid(body, 'garbage', secret, now)).toBe(false);
    expect(signatureValid(body, `t=${at}`, secret, now)).toBe(false);
    expect(signatureValid(body, sign('another-secret', body, at), secret, now)).toBe(false);
    expect(signatureValid(`${body} `, sign(secret, body, at), secret, now)).toBe(false);
    expect(signatureValid(body, sign(secret, body, at - 31 * 60), secret, now)).toBe(false);
    expect(signatureValid(body, sign(secret, body, at + 6 * 60), secret, now)).toBe(false);
    expect(signatureValid(body, sign(secret, body, at - 29 * 60), secret, now)).toBe(true);
    expect(signatureValid(body, sign(secret, body, at), '', now)).toBe(false);
  });
});
