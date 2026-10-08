import { expect, test } from 'bun:test';
import { pastedSpans } from './pasted.ts';

test('each piece still in the message is found where it sits', () => {
  const text = 'Sort this out by Friday: Please wire $4,800 to pay@x.test';
  expect(pastedSpans(text, ['  Please wire $4,800 to pay@x.test\n'])).toEqual([
    { start: 25, end: text.length },
  ]);
});

test('a piece taken back out, or empty, marks nothing', () => {
  expect(pastedSpans('Book Haidilao', ['Dear Sam,', '   '])).toEqual([]);
});

test('the same piece pasted twice marks both places', () => {
  expect(pastedSpans('ab ab', ['ab', 'ab'])).toEqual([
    { start: 0, end: 2 },
    { start: 3, end: 5 },
  ]);
});
