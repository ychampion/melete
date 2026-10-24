import { describe, expect, test } from 'bun:test';
import { ACK_FORMAT, ackBody, readAck } from './ack.ts';

const said = (line: string) => JSON.stringify({ say: line });

describe('reading an acknowledgement', () => {
  test('a plain line about what comes next is shown, ending in a full stop', () => {
    expect(readAck(said('Checking the ECB rate now'), 'euro rate?')).toBe(
      'Checking the ECB rate now.',
    );
    expect(readAck('```json\n{"say":"Looking at flights to Lisbon."}\n```', 'Lisbon flights')).toBe(
      'Looking at flights to Lisbon.',
    );
  });

  test('anything that is not a plain line is dropped', () => {
    const message = 'What is the euro rate on 3 May?';
    for (const reply of [
      'Checking the rate now.', // not the JSON asked for
      said(''),
      said('Want me to check the ECB too?'), // a question
      said('Sure, checking the rate now.'), // filler
      said('I booked the table for you.'), // a claim
      said('The rate is 1.08 dollars.'), // a number not in the message: a guessed answer
      said('Checking **the** rate.'), // markup
      said(
        'Checking the rate from several different sources and then comparing them all very carefully for you today.',
      ),
    ])
      expect(readAck(reply, message)).toBeNull();
  });

  test('a line a few words over the twelve asked for is still shown', () => {
    // Written by the model for a writing turn; dropped at 14 words before.
    const message =
      'Write a short reply to Sam declining the planning meeting on Thursday the 23rd and offering two other times next week. Sign it Riya. Keep it under 120 words.';
    const line =
      "Drafting a short reply to Sam declining Thursday's meeting and offering two other times.";
    expect(readAck(said(line), message)).toBe(line);
  });

  test('a number the person wrote may be repeated', () => {
    expect(readAck(said('Checking the rate for 3 May.'), 'What is the euro rate on 3 May?')).toBe(
      'Checking the rate for 3 May.',
    );
  });

  test('the request has no tools and asks for the structured line', () => {
    const body = ackBody({ provider: 'anthropic', model: 'claude-haiku-5-5' }, 'euro rate?');
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body)).toContain('euro rate?');
    expect(ACK_FORMAT.name).toBe('acknowledgement');
  });
});
