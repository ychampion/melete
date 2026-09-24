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

test('a period the email gives is a due day, counted from the day the email came', () => {
  // Received Friday 18 September 2026.
  const due = (text: string) => read(text).items.map((item) => item.due_at);
  expect(due('Your payment of GBP 534.50 will be refunded within 5 working days.')).toEqual([
    '2026-09-25',
  ]);
  // A range is kept to its far end: the company said it could take that long.
  expect(due('We will refund you GBP 49.99 within 5-7 working days.')).toEqual(['2026-09-29']);
  expect(due('We will pay the refund of GBP 640.00 within 14 days of this email.')).toEqual([
    '2026-10-02',
  ]);
  expect(due('A refund of GBP 84.40 will reach your account within ten business days.')).toEqual([
    '2026-10-02',
  ]);
  // A date the email states outright wins over any period beside it.
  expect(
    due('A refund of GBP 12.00 will be paid on 30 September 2026, within 5 working days.'),
  ).toEqual(['2026-09-30']);
});
