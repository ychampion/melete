import { expect, test } from 'bun:test';
import { shortTitle } from './title.ts';

test('a title keeps addresses whole and cuts on a word', () => {
  expect(shortTitle('Email sam@example.com about Thursday. Then book it.')).toBe(
    'Email sam@example.com about Thursday',
  );
  expect(
    shortTitle('Draft a short thank-you note to priya@example.com for the design review', 60),
  ).toBe('Draft a short thank-you note to priya@example.com for the…');
  expect(shortTitle('Pay the invoice')).toBe('Pay the invoice');
});
