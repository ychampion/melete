import { describe, expect, test } from 'bun:test';
import { FEEDBACK_ID_ALPHABET, feedbackId } from '@melete/contracts';
import { newFeedbackId, normalizeFeedbackId, withFreshFeedbackId } from './ids.ts';

describe('feedback ids', () => {
  test('are FB- and four characters that are easy to read aloud', () => {
    for (let i = 0; i < 2000; i++) {
      const id = newFeedbackId();
      expect(id).toMatch(/^FB-[23456789ABCDEFGHJKMNPQRSTWXYZ]{4}$/);
      expect(feedbackId.safeParse(id).success).toBe(true);
    }
    // Nothing that is misread or misheard: zero and O, one, I and L, U and V.
    for (const confusable of '01OILUV') expect(FEEDBACK_ID_ALPHABET).not.toContain(confusable);
  });

  test('use every character of the alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const char of newFeedbackId().slice(3)) seen.add(char);
    expect([...seen].sort().join('')).toBe([...FEEDBACK_ID_ALPHABET].sort().join(''));
  });

  test('rarely repeat among a few thousand', () => {
    const ids = new Set(Array.from({ length: 3000 }, () => newFeedbackId()));
    // 29^4 ids: a few thousand draws collide a handful of times at most.
    expect(ids.size).toBeGreaterThan(2980);
  });

  test('are read back however a person typed them', () => {
    expect(normalizeFeedbackId(' fb-7k3q ')).toBe('FB-7K3Q');
    expect(normalizeFeedbackId('7k3q')).toBe('FB-7K3Q');
    expect(normalizeFeedbackId('FB7K3Q')).toBe('FB-7K3Q');
  });

  test('retry a taken id, then grow by one character when short ones keep colliding', async () => {
    const taken = new Set(['FB-AAAA']);
    const lengths: number[] = [];
    const id = await withFreshFeedbackId(
      async (candidate) => (taken.has(candidate) ? false : candidate),
      (length) => {
        lengths.push(length);
        return `FB-${'A'.repeat(length)}`;
      },
    );
    expect(id).toBe('FB-AAAAA');
    expect(lengths).toEqual([4, 4, 4, 4, 5]);
  });

  test('stop once one is accepted', async () => {
    let calls = 0;
    const id = await withFreshFeedbackId(async (candidate) => {
      calls++;
      return calls < 3 ? false : candidate;
    });
    expect(calls).toBe(3);
    expect(id).toMatch(/^FB-.{4}$/);
  });
});
