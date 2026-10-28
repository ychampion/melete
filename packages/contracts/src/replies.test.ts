import { describe, expect, test } from 'bun:test';
import { quoteOf, REPLY_QUOTE_MAX_CHARS, withReplyQuote } from './replies.ts';

describe('the quote a reply carries', () => {
  test('keeps a short message whole, on one line', () => {
    expect(quoteOf('  Book the\n second   one. ')).toBe('Book the second one.');
  });

  test('is capped, cut where a word ends', () => {
    const long = Array.from({ length: 200 }, (_, index) => `w${index}`).join(' ');
    const quote = quoteOf(long);
    expect(quote.length).toBeLessThanOrEqual(REPLY_QUOTE_MAX_CHARS);
    expect(quote.endsWith('…')).toBe(true);
    const words = quote.slice(0, -1).split(' ');
    expect(long.split(' ').slice(0, words.length)).toEqual(words);
  });

  test('cuts one very long word where the cap falls', () => {
    const quote = quoteOf('x'.repeat(1000));
    expect(quote).toBe(`${'x'.repeat(REPLY_QUOTE_MAX_CHARS - 1)}…`);
  });

  test('says whose message it was, and leaves a plain message as it is', () => {
    expect(withReplyQuote('Yes.', { message_id: '7', by: 'assistant', text: 'Shall I?' })).toBe(
      '[Replying to something you said earlier:]\n> Shall I?\n\nYes.',
    );
    expect(withReplyQuote('Shorter.', { message_id: '3', by: 'person', text: 'A plan' })).toBe(
      '[Replying to an earlier message of theirs:]\n> A plan\n\nShorter.',
    );
    expect(withReplyQuote('Yes.', undefined)).toBe('Yes.');
  });
});
