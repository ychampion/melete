import { expect, test } from 'bun:test';
import { messageText } from './messages.ts';
import { isCandidate } from './prefilter.ts';
import { scriptedItems } from './scripted.ts';

const RECEIVED = '2026-09-18T09:00:00.000Z';

/** What the scripted extractor reads out of one short message. */
function read(text: string, receivedAt = RECEIVED) {
  const message = {
    messageId: '<m@acme.example>',
    from: 'Acme <billing@acme.example>',
    to: 'studio@example.test',
    subject: 'About your account',
    text,
    receivedAt,
  };
  return {
    candidate: isCandidate(message),
    items: scriptedItems({
      messageId: message.messageId,
      companyName: 'Acme',
      domain: 'acme.example',
      from: message.from,
      subject: message.subject,
      receivedAt,
      text: messageText(message),
    }),
  };
}

test('an overcharge is read, and read as a charge that looks wrong', () => {
  for (const text of [
    'We overcharged you by GBP 12.00 on your last bill.',
    'You were over-charged GBP 12.00 in August.',
    'We charged too much on your September invoice of GBP 12.00.',
  ]) {
    const { candidate, items } = read(text);
    expect(candidate).toBe(true);
    expect(items.map((item) => [item.kind, item.direction, item.amount_minor])).toEqual([
      ['wrong_charge', 'owed_to_you', 1200],
    ]);
  }
});
