import { describe, expect, test } from 'bun:test';
import { evidenceHolds } from '@melete/contracts';
import { FIXTURE_REFERENCE, fixtureMessages } from './fixtures.ts';
import { messageText, type ScanMessage } from './messages.ts';
import { AWAITED_SENT_INDEXES, fixtureSentMessages } from './sent-fixtures.ts';
import { findAwaitedReplies } from './waiting.ts';

const now = new Date(FIXTURE_REFERENCE);
const DAY = 86_400_000;
const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
const SELF = 'sam@studio.example';

/** One message the person sent. */
const sent = (over: Partial<ScanMessage> & { to: string }): ScanMessage => ({
  messageId: `<${Math.random().toString(36).slice(2)}@studio.example>`,
  from: `Sam <${SELF}>`,
  fromAddresses: [SELF],
  toAddresses: [/<([^>]+)>/.exec(over.to)?.[1] ?? over.to],
  subject: 'Quote',
  text: 'Could you send the quote?',
  receivedAt: ago(5),
  ...over,
});

/** One message the person received. */
const received = (over: Partial<ScanMessage> & { from: string }): ScanMessage => ({
  messageId: `<${Math.random().toString(36).slice(2)}@elsewhere.example>`,
  fromAddresses: [/<([^>]+)>/.exec(over.from)?.[1] ?? over.from],
  to: SELF,
  subject: 'Re: Quote',
  text: 'Here it is.',
  receivedAt: ago(2),
  ...over,
});

const found = (input: { sent: ScanMessage[]; inbox?: ScanMessage[] }) =>
  findAwaitedReplies({ sent: input.sent, inbox: input.inbox ?? [], inboxComplete: true, now })
    .awaited;

describe('messages still waiting on a reply', () => {
  test('in the fixture Sent folder, exactly the three unanswered questions', () => {
    const sentFolder = fixtureSentMessages();
    const result = findAwaitedReplies({
      sent: sentFolder,
      inbox: fixtureMessages(),
      inboxComplete: false,
      now,
    });
    expect(result.awaited.map((entry) => entry.messageId).sort()).toEqual(
      AWAITED_SENT_INDEXES.map((index) => sentFolder[index]?.messageId ?? '').sort(),
    );
  });

  test('each one quotes the sentence that asked, at a span that holds', () => {
    const sentFolder = fixtureSentMessages();
    for (const entry of findAwaitedReplies({
      sent: sentFolder,
      inbox: fixtureMessages(),
      inboxComplete: false,
      now,
    }).awaited) {
      const message = sentFolder.find((candidate) => candidate.messageId === entry.messageId);
      if (!message) throw new Error('Expected the sent message');
      expect(evidenceHolds(messageText(message), entry)).toBe(true);
      expect(entry.quote).toMatch(/\?$|^Please confirm/);
    }
  });

  test('names the recipient and how long it has waited', () => {
    const [entry] = found({
      sent: [sent({ to: 'Deverill IT <service@deverill.example>', receivedAt: ago(6) })],
    });
    expect(entry).toMatchObject({
      to: 'service@deverill.example',
      toName: 'Deverill IT',
      subject: 'Quote',
      sentAt: ago(6),
    });
  });

  test('a question answered by the recipient is not waiting, and is named as answered', () => {
    const question = sent({ to: 'hello@joinery.example', receivedAt: ago(6) });
    const result = findAwaitedReplies({
      sent: [question],
      inbox: [received({ from: 'Joinery <hello@joinery.example>', receivedAt: ago(4) })],
      inboxComplete: true,
      now,
    });
    expect(result.awaited).toEqual([]);
    expect(result.answered).toEqual([question.messageId]);
  });

  test('mail from the recipient before the question does not answer it', () => {
    expect(
      found({
        sent: [sent({ to: 'hello@joinery.example', receivedAt: ago(6) })],
        inbox: [received({ from: 'hello@joinery.example', receivedAt: ago(8) })],
      }),
    ).toHaveLength(1);
  });

  test('a threaded reply from another address answers it', () => {
    const question = sent({ to: 'help@joinery.example' });
    expect(
      found({
        sent: [question],
        inbox: [
          received({
            from: 'Sam Reyes <sam.reyes@joinery.example>',
            subject: 'Something else entirely',
            inReplyTo: question.messageId,
          }),
        ],
      }),
    ).toEqual([]);
  });

  test("a company's colleague replying on the same subject answers it", () => {
    expect(
      found({
        sent: [sent({ to: 'help@joinery.example', subject: 'Quote' })],
        inbox: [received({ from: 'accounts@joinery.example', subject: 'RE: Quote' })],
      }),
    ).toEqual([]);
  });

  test('a stranger at the same personal mail provider does not answer it', () => {
    expect(
      found({
        sent: [sent({ to: 'tomas@gmail.com', subject: 'Quote' })],
        inbox: [received({ from: 'someone.else@gmail.com', subject: 'Re: Quote' })],
      }),
    ).toHaveLength(1);
  });

  test('too recent to be waiting yet', () => {
    expect(found({ sent: [sent({ to: 'a@b.example', receivedAt: ago(2) })] })).toEqual([]);
  });

  test('older than the window is left alone', () => {
    expect(found({ sent: [sent({ to: 'a@b.example', receivedAt: ago(45) })] })).toEqual([]);
  });

  test('a message that asks nothing is not waiting', () => {
    expect(
      found({ sent: [sent({ to: 'a@b.example', text: 'Thanks, all sorted.\nSam' })] }),
    ).toEqual([]);
  });

  test('a pleasantry is not a question', () => {
    expect(
      found({
        sent: [sent({ to: 'a@b.example', text: 'Hi Jo, how are you?\nThe files are attached.' })],
      }),
    ).toEqual([]);
  });

  test('a question only in the quoted history is not the person asking', () => {
    expect(
      found({
        sent: [
          sent({
            to: 'a@b.example',
            text: 'Sounds good.\n\nOn Tue, Jo wrote:\n> Could you send the quote?',
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      found({
        sent: [
          sent({
            to: 'a@b.example',
            text: 'Noted.\n-----Original Message-----\nFrom: Jo\nCan you send it?',
          }),
        ],
      }),
    ).toEqual([]);
  });

  test('no-reply and robot addresses are never waited on', () => {
    for (const to of [
      'noreply@air.example',
      'no-reply@air.example',
      'do-not-reply@air.example',
      'notifications@tool.example',
      'mailer-daemon@mx.example',
    ])
      expect(found({ sent: [sent({ to })] })).toEqual([]);
  });

  test('a newsletter sender is never waited on', () => {
    expect(
      found({
        sent: [sent({ to: 'letter@weekly.example' })],
        inbox: [
          received({
            from: 'letter@weekly.example',
            subject: 'Issue 9',
            receivedAt: ago(20),
            unsubscribe: true,
          }),
        ],
      }),
    ).toEqual([]);
    expect(
      found({
        sent: [sent({ to: 'digest@list.example' })],
        inbox: [received({ from: 'digest@list.example', receivedAt: ago(20), automated: true })],
      }),
    ).toEqual([]);
  });

  test("the person's own automatic replies are not waiting", () => {
    expect(found({ sent: [sent({ to: 'a@b.example', automated: true })] })).toEqual([]);
  });

  test('a message only to the person themselves is not waiting', () => {
    expect(found({ sent: [sent({ to: SELF })] })).toEqual([]);
  });

  test('a later follow-up in the same thread is the one that waits', () => {
    const first = sent({ to: 'a@b.example', subject: 'Quote', receivedAt: ago(10) });
    const again = sent({
      to: 'a@b.example',
      subject: 'Re: Quote',
      text: 'Any news on the quote?',
      receivedAt: ago(5),
    });
    expect(found({ sent: [first, again] }).map((entry) => entry.messageId)).toEqual([
      again.messageId,
    ]);
  });

  test('the same folder read twice gives the same answer', () => {
    const input = {
      sent: fixtureSentMessages(),
      inbox: fixtureMessages(),
      inboxComplete: false,
      now,
    };
    expect(findAwaitedReplies(input)).toEqual(findAwaitedReplies(input));
  });
});

describe('only what the inbox read can show is judged', () => {
  // A busy inbox: fifty messages from others in the last two days. The reply to
  // a question sent ten days ago came eight days ago, beyond what was read.
  const busyInbox = () =>
    Array.from({ length: 50 }, (_, index) =>
      received({
        from: `sender${index}@elsewhere${index}.example`,
        subject: `Update ${index}`,
        receivedAt: new Date(now.getTime() - (index + 1) * 3_600_000).toISOString(),
      }),
    );

  test('a question older than the oldest inbox message read is not reported', () => {
    const question = sent({ to: 'hello@joinery.example', receivedAt: ago(10) });
    const result = findAwaitedReplies({
      sent: [question],
      inbox: busyInbox(),
      inboxComplete: false,
      now,
    });
    expect(result.awaited).toEqual([]);
    expect(result.answered).toEqual([]);
    expect(result.counts.unobserved).toBe(1);
  });

  test('a question inside what was read is still judged', () => {
    const inbox = busyInbox();
    const oldest = inbox.at(-1)?.receivedAt ?? '';
    const question = sent({
      to: 'hello@joinery.example',
      receivedAt: new Date(Date.parse(oldest) - 1).toISOString(),
    });
    const inside = sent({
      to: 'jo@studio-two.example',
      receivedAt: new Date(Date.parse(oldest) + 60_000).toISOString(),
    });
    const result = findAwaitedReplies({
      sent: [question, inside],
      inbox,
      inboxComplete: false,
      now: new Date(Date.parse(oldest) + 4 * DAY),
    });
    expect(result.awaited.map((entry) => entry.messageId)).toEqual([inside.messageId]);
  });

  test('when the read reached the end of the inbox, an old question is still reported', () => {
    const question = sent({ to: 'hello@joinery.example', receivedAt: ago(10) });
    expect(
      findAwaitedReplies({ sent: [question], inbox: busyInbox(), inboxComplete: true, now })
        .awaited,
    ).toHaveLength(1);
  });
});

describe('routine sign-offs are not requests', () => {
  for (const text of [
    'The files are attached.\nLet me know if you have any questions.',
    'Here is the draft. Please let me know if you have any questions.',
    'Sent over the invoice. Let me know if there’s anything else.',
    'Thanks for your time. Looking forward to hearing from you.',
    'All the best, and I look forward to hearing from you!',
    'Attached the signed copy. Don’t hesitate to reach out if you need anything.',
    'Great meeting you. Let me know if I can help with anything.',
  ])
    test(JSON.stringify(text), () => {
      expect(found({ sent: [sent({ to: 'a@b.example', text })] })).toEqual([]);
    });

  for (const [text, quote] of [
    ['Let me know if the 3pm slot works.', 'Let me know if the 3pm slot works.'],
    [
      'Could you send the quote? Let me know if you have any questions.',
      'Could you send the quote?',
    ],
    [
      'Looking forward to hearing from you, and could you confirm the date?',
      'Looking forward to hearing from you, and could you confirm the date?',
    ],
  ] as const)
    test(`still asks: ${JSON.stringify(text)}`, () => {
      const [entry] = found({ sent: [sent({ to: 'a@b.example', text })] });
      expect(entry?.quote).toBe(quote);
    });
});

describe('automatic replies do not answer', () => {
  test('an out-of-office from the recipient, threaded, does not answer the question', () => {
    const question = sent({ to: 'hello@joinery.example', receivedAt: ago(6) });
    const result = findAwaitedReplies({
      sent: [question],
      inbox: [
        received({
          from: 'hello@joinery.example',
          subject: 'Automatic reply: Quote',
          inReplyTo: question.messageId,
          receivedAt: ago(6),
          automated: true,
        }),
      ],
      inboxComplete: true,
      now,
    });
    expect(result.awaited.map((entry) => entry.messageId)).toEqual([question.messageId]);
    expect(result.answered).toEqual([]);
  });

  test('an out-of-office without the automatic header is known by its subject', () => {
    const question = sent({ to: 'hello@joinery.example', receivedAt: ago(6) });
    expect(
      found({
        sent: [question],
        inbox: [
          received({
            from: 'hello@joinery.example',
            subject: 'Out of Office: Quote',
            receivedAt: ago(5),
          }),
        ],
      }),
    ).toHaveLength(1);
  });
});
