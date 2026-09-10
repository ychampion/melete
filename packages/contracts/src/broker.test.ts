import { describe, expect, test } from 'bun:test';
import {
  ACTION_STATUSES,
  canonicalizePayload,
  canonicalJson,
  isTerminalAction,
  normalizeEmailAddress,
  payloadHash,
  proposeActionRequest,
} from './broker.ts';

describe('canonicalizePayload', () => {
  test('key order does not change the hash', () => {
    const a = canonicalizePayload({ subject: 'Invoice', to: 'zara@example.com', body: 'hello' });
    const b = canonicalizePayload({ body: 'hello', to: 'zara@example.com', subject: 'Invoice' });
    expect(a.hash).toBe(b.hash);
    expect(a.json).toBe(b.json);
  });

  test('nested key order does not change the hash either', () => {
    const a = canonicalizePayload({ headers: { b: '2', a: '1' }, to: 'z@example.com' });
    const b = canonicalizePayload({ to: 'z@example.com', headers: { a: '1', b: '2' } });
    expect(a.hash).toBe(b.hash);
  });

  test('one byte of body changes the hash', () => {
    const a = canonicalizePayload({ to: 'z@example.com', body: 'See you at 3pm.' });
    const b = canonicalizePayload({ to: 'z@example.com', body: 'See you at 4pm.' });
    expect(a.hash).not.toBe(b.hash);
  });

  test('a changed recipient changes the hash', () => {
    const a = canonicalizePayload({ to: 'zara@example.com', body: 'hi' });
    const b = canonicalizePayload({ to: 'zora@example.com', body: 'hi' });
    expect(a.hash).not.toBe(b.hash);
  });

  test('surrounding whitespace is not part of the meaning', () => {
    const a = canonicalizePayload({ subject: '  Invoice  ', body: 'hello ' });
    const b = canonicalizePayload({ subject: 'Invoice', body: 'hello' });
    expect(a.hash).toBe(b.hash);
  });

  test('display names and case in addresses are normalized away', () => {
    const a = canonicalizePayload({ to: 'Zara Zhang <ZARA@Example.COM>', body: 'hi' });
    const b = canonicalizePayload({ to: 'zara@example.com', body: 'hi' });
    expect(a.hash).toBe(b.hash);
  });

  test('recipient lists are sets: order and duplicates carry no meaning', () => {
    const a = canonicalizePayload({ to: ['b@example.com', 'a@example.com', 'b@example.com'] });
    const b = canonicalizePayload({ to: ['a@example.com', 'b@example.com'] });
    expect(a.hash).toBe(b.hash);
    expect(a.canonical.to).toEqual(['a@example.com', 'b@example.com']);
  });

  test('a non-recipient array keeps its order, because order is content there', () => {
    const a = canonicalizePayload({ attachments: ['b.pdf', 'a.pdf'] });
    const b = canonicalizePayload({ attachments: ['a.pdf', 'b.pdf'] });
    expect(a.hash).not.toBe(b.hash);
  });

  test('adding a recipient to cc changes the hash', () => {
    const a = canonicalizePayload({ to: ['a@example.com'], cc: [] });
    const b = canonicalizePayload({ to: ['a@example.com'], cc: ['spy@example.com'] });
    expect(a.hash).not.toBe(b.hash);
  });

  test('undefined fields are dropped and null fields are kept', () => {
    const withUndefined = canonicalizePayload({ to: 'a@example.com', cc: undefined });
    const without = canonicalizePayload({ to: 'a@example.com' });
    expect(withUndefined.hash).toBe(without.hash);

    const withNull = canonicalizePayload({ to: 'a@example.com', cc: null });
    expect(withNull.hash).not.toBe(without.hash);
  });

  test('the hash is a lowercase hex sha256 and is stable across calls', () => {
    const first = canonicalizePayload({ to: 'a@example.com', body: 'x' });
    const second = canonicalizePayload({ to: 'a@example.com', body: 'x' });
    expect(first.hash).toBe(second.hash);
    expect(payloadHash.safeParse(first.hash).success).toBe(true);
  });

  test('the canonical json is what was hashed', () => {
    const result = canonicalizePayload({ b: 2, a: 1 });
    expect(result.json).toBe(canonicalJson(result.canonical));
    expect(result.json).toBe('{"a":1,"b":2}');
  });

  test('a non-object payload is refused rather than silently coerced', () => {
    expect(() => canonicalizePayload([] as unknown as Record<string, unknown>)).toThrow();
    expect(() => canonicalizePayload({ n: Number.NaN })).toThrow();
  });
});

describe('normalizeEmailAddress', () => {
  test('pulls the address out of an angle-bracket form', () => {
    expect(normalizeEmailAddress('Zara Zhang <zara@example.com>')).toBe('zara@example.com');
  });
  test('trims and lowercases a bare address', () => {
    expect(normalizeEmailAddress('  ZARA@Example.com ')).toBe('zara@example.com');
  });
});

describe('action status', () => {
  test('unknown and unresolved are both real statuses', () => {
    expect(ACTION_STATUSES).toContain('unknown');
    expect(ACTION_STATUSES).toContain('unresolved');
  });

  test('an unknown or unresolved action is never treated as finished', () => {
    expect(isTerminalAction('unknown')).toBe(false);
    expect(isTerminalAction('unresolved')).toBe(false);
    expect(isTerminalAction('succeeded')).toBe(true);
    expect(isTerminalAction('denied')).toBe(true);
  });
});

describe('propose request validation', () => {
  test('accepts a well formed proposal', () => {
    const parsed = proposeActionRequest.safeParse({
      kind: 'email.send',
      connection_id: 'conn_01J8ZP3QWABCDEFGHJKMNPQRST',
      payload: { to: 'a@example.com', subject: 'hi', body: 'there' },
    });
    expect(parsed.success).toBe(true);
  });

  test('refuses a connection id that is not a prefixed ULID', () => {
    const parsed = proposeActionRequest.safeParse({
      kind: 'email.send',
      connection_id: 'conn_not_a_ulid',
      payload: {},
    });
    expect(parsed.success).toBe(false);
  });
});
