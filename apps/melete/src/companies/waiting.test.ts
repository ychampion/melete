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
  findAwaitedReplies({ sent: input.sent, inbox: input.inbox ?? [], now }).awaited;

describe('messages still waiting on a reply', () => {
  test('in the fixture Sent folder, exactly the three unanswered questions', () => {
    const sentFolder = fixtureSentMessages();
    const result = findAwaitedReplies({ sent: sentFolder, inbox: fixtureMessages(), now });
    expect(result.awaited.map((entry) => entry.messageId).sort()).toEqual(
      AWAITED_SENT_INDEXES.map((index) => sentFolder[index]?.messageId ?? '').sort(),
    );
  });

  test('each one quotes the sentence that asked, at a span that holds', () => {
    const sentFolder = fixtureSentMessages();
    for (const entry of findAwaitedReplies({ sent: sentFolder, inbox: fixtureMessages(), now })
      .awaited) {
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
    const input = { sent: fixtureSentMessages(), inbox: fixtureMessages(), now };
    expect(findAwaitedReplies(input)).toEqual(findAwaitedReplies(input));
  });
});
