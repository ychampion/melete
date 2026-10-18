import { describe, expect, test } from 'bun:test';
import { saysToSend } from './told.ts';

describe('whether the person said to send', () => {
  test.each([
    'Send it',
    'send it.',
    'Ok, send it',
    'Looks good, send it!',
    'Write to Bob about Friday and send it',
    'Can you send Bob the notes?',
    'Could you forward this to Sam',
    'Please send the reply to the landlord',
    'Reply to the landlord that Tuesday works',
    'Email Ana that the meeting moved to 3',
    'Text Sam I am running late',
    'Draft a reply to Bob and send it',
    'Thanks. Now send it to manager@example.com',
  ])('"%s" asks for a send', (text) => {
    expect(saysToSend(text)).toBe(true);
  });

  test.each([
    'Draft a reply to Bob',
    'Write a reply to John',
    "Don't send it yet",
    'Draft it but do not send it',
    'Send it, but wait until I have read it',
    'Hold off on sending',
    'Should I send it?',
    'Did you send it?',
    'What did they send?',
    "I'll send it myself",
    'Let me send it from my phone',
    'Looking forward to the trip',
    'Check my email',
    'Email from Bob?',
    'Before you send it, check the date',
    'Summarise the thread',
    '',
  ])('"%s" does not', (text) => {
    expect(saysToSend(text)).toBe(false);
  });

  test('a short yes counts only after an answer that offered to send', () => {
    expect(saysToSend('Yes', 'The draft to Bob is ready. Shall I send it?')).toBe(true);
    expect(saysToSend('go ahead', 'Want me to send this now?')).toBe(true);
    expect(saysToSend('Yes', 'Do you want the summary as a list?')).toBe(false);
    expect(saysToSend('Yes')).toBe(false);
    expect(saysToSend('Yes, but change the subject first', 'Shall I send it?')).toBe(false);
  });
});
