import { expect, test } from 'bun:test';
import { changeSetRejection, isOwnWords } from './commit.ts';

test("a statement rests on the person's own words: what they said, edited, or added as theirs", () => {
  expect(isOwnWords({ source_type: 'message', author: 'owner' })).toBe(true);
  expect(isOwnWords({ source_type: 'owner_edit', author: 'owner' })).toBe(true);
  expect(isOwnWords({ source_type: 'document', author: 'owner' })).toBe(true);
  // Somebody else's document, a connector's record or an assistant's note is not.
  expect(isOwnWords({ source_type: 'document', author: 'external' })).toBe(false);
  expect(isOwnWords({ source_type: 'observation', author: 'owner' })).toBe(false);
  expect(isOwnWords({ source_type: 'assistant', author: 'owner' })).toBe(false);
});

test('a refused change set is recorded with a reason the rejections list accepts', () => {
  expect(changeSetRejection('unsupported_attribution').reason).toBe('unsupported_attribution');
  const other = changeSetRejection('invalid_source_span');
  expect(other.reason).toBe('change_set_refused');
  expect(other.detail).toContain('invalid_source_span');
});
