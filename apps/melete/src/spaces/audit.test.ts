import { describe, expect, test } from 'bun:test';
import { decodeAuditCursor, encodeAuditCursor } from './audit.ts';

describe('the activity log’s page marker', () => {
  test('reads back the time and id it was made from, microseconds included', () => {
    const cursor = { at: '2026-10-15T09:00:00.123456Z', id: 'act_01' };
    const token = encodeAuditCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAuditCursor(token)).toEqual(cursor);
  });

  test('anything it did not write reads as no marker', () => {
    for (const value of [
      'nonsense',
      Buffer.from('{"at":"x"}').toString('base64url'),
      Buffer.from('["not a time","act_1"]').toString('base64url'),
      Buffer.from('["2026-10-15T09:00:00Z"]').toString('base64url'),
      Buffer.from('["2026-10-15T09:00:00Z",7]').toString('base64url'),
      // Times JavaScript reads but Postgres refuses: a forged marker is a bad
      // request, never a failed query.
      Buffer.from('["1","act_1"]').toString('base64url'),
      Buffer.from('["hello 2020","act_1"]').toString('base64url'),
      Buffer.from('["2026-02-31T09:00:00.000000Z","act_1"]').toString('base64url'),
      Buffer.from('["2026-10-15T09:00:00.123456Z",""]').toString('base64url'),
    ])
      expect(decodeAuditCursor(value)).toBeNull();
  });
});
