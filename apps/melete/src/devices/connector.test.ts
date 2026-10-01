import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { unreadableReply } from './connector.ts';

const malformed = () => {
  const parsed = z
    .object({ content: z.string(), content_hash: z.string().regex(/^[0-9a-f]{64}$/) })
    .safeParse({ content: 'oat milk', content_hash: 'not-a-hash' });
  if (parsed.success) throw new Error('expected a malformed reply');
  return parsed.error;
};

describe('a companion answer that does not have its promised shape', () => {
  test('a reading tool fails with a reason that names the field, never raw validator output', () => {
    const result = unreadableReply('read_file', 'Laptop', malformed());
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.reason).toBe(
      'Laptop answered in a form Melete could not read: content_hash was not what this tool returns.',
    );
    expect(result.reason).not.toContain('[');
    expect(result.reason.length).toBeLessThanOrEqual(300);
  });

  test('a tool with an effect is unknown, because the computer may already have done it', () => {
    const result = unreadableReply('write_file', 'Laptop', malformed());
    expect(result).toMatchObject({ outcome: 'unknown' });
    if (result.outcome === 'unknown') expect(result.reason).toContain('It may have happened');
  });
});
