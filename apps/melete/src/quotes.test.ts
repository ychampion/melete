import { describe, expect, test } from 'bun:test';
import { findQuote, placeQuote } from './quotes.ts';

describe('offsets a model gave', () => {
  test('are used only when whole, inside the text, and the length of the quote', () => {
    const text = 'hello abc hello';
    // Negative: slice would count from the end. The quote is found instead.
    expect(placeQuote(text, 0, { quote: 'hello', start: -5, end: 15 })).toEqual({
      start: 0,
      end: 5,
      quote: 'hello',
    });
    // Past the end.
    expect(placeQuote('abc', 0, { quote: 'bc', start: 1, end: 999 })).toEqual({
      start: 1,
      end: 3,
      quote: 'bc',
    });
    // Fractional.
    expect(placeQuote('abc', 0, { quote: 'bc', start: 1.4, end: 3.4 })).toEqual({
      start: 1,
      end: 3,
      quote: 'bc',
    });
    // Before the segment's own start.
    expect(placeQuote('abc', 100, { quote: 'bc', start: 1, end: 3 })).toEqual({
      start: 101,
      end: 103,
      quote: 'bc',
    });
    // Exact and in range: kept, even for the second occurrence.
    expect(placeQuote(text, 0, { quote: 'hello', start: 10, end: 15 })).toEqual({
      start: 10,
      end: 15,
      quote: 'hello',
    });
  });
});

describe('a loose match', () => {
  test('never bridges a blanked-out span', () => {
    // "Lisbon and work at" was forgotten and blanked to spaces in what the model saw.
    const visible = `I live in ${' '.repeat(20)}Acme`;
    expect(findQuote(visible, 'I live in Acme')).toBeNull();
    expect(placeQuote(visible, 0, { quote: 'I live in Acme' })).toBeNull();
  });

  test('still matches across ordinary spacing and line breaks', () => {
    const text = 'Keep it short.\n\nUse  bullet points, please.';
    const found = findQuote(text, 'keep it short. use bullet points');
    expect(found && text.slice(found.start, found.end)).toBe(
      'Keep it short.\n\nUse  bullet points',
    );
  });

  test('takes another occurrence when the nearest one bridges a blank', () => {
    const text = `tea ${' '.repeat(8)}time. Later: tea time.`;
    const found = findQuote(text, 'Tea time');
    expect(found && text.slice(found.start, found.end)).toBe('tea time');
    expect(found?.start).toBe(text.lastIndexOf('tea time'));
  });
});
