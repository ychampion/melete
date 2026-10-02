import { describe, expect, test } from 'bun:test';
import { canonicalBody, requestWrite, SHOWN_BODY_CHARS, shownBody } from './generic.ts';
import type { InterceptedRequest } from './types.ts';

const request = (body: Buffer, contentType?: string): InterceptedRequest => ({
  host: 'api.creds.test',
  method: 'POST',
  path: '/x',
  query: '',
  headers: contentType ? { 'content-type': contentType } : {},
  body,
});

describe('what a card shows of a body', () => {
  test('a form or text body is shown as text, not only by its digest', () => {
    const form = request(
      Buffer.from('title=Fix+login&base=main'),
      'application/x-www-form-urlencoded',
    );
    expect(shownBody(form, canonicalBody(form))).toBe('title=Fix+login&base=main');
  });

  test('a long body says how much of it is not shown', () => {
    const long = request(
      Buffer.from(JSON.stringify({ text: 'z'.repeat(SHOWN_BODY_CHARS * 2) })),
      'application/json',
    );
    const shown = shownBody(long, canonicalBody(long));
    expect(shown.length).toBeLessThan(SHOWN_BODY_CHARS + 100);
    expect(shown).toMatch(/… \d+ more characters not shown$/);
  });

  test('a binary body is shown by its size and digest, and every body is bound by its digest', () => {
    const binary = request(Buffer.from([0, 1, 2, 255, 254]), 'application/octet-stream');
    const body = canonicalBody(binary);
    expect(shownBody(binary, body)).toStartWith('5 bytes of binary data, sha256 ');
    expect(body.sha256).toBeString();
    const json = request(Buffer.from('{"a":1}'), 'application/json');
    expect(canonicalBody(json)).toMatchObject({
      bytes: 7,
      sha256: expect.any(String),
      json: { a: 1 },
    });
  });

  test('a put is shown as replacing what was there', () => {
    expect(requestWrite({ ...request(Buffer.from('x')), method: 'PUT' })).toMatchObject({
      destructive: true,
    });
  });
});
