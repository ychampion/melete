import { describe, expect, test } from 'bun:test';
import { MODEL_GUIDANCE, PRIVACY_CATEGORIES } from '@melete/contracts';
import { detect } from './detect.ts';

describe('model guidance and the privacy redactor', () => {
  test("nothing in any family's notes is taken for private detail", () => {
    const all = new Set(PRIVACY_CATEGORIES);
    for (const entry of MODEL_GUIDANCE) expect(detect(entry.text, all)).toEqual([]);
  });
});
