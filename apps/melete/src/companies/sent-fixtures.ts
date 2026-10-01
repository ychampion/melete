/**
 * The demonstration studio's Sent folder: what the person wrote, beside the
 * inbox in `fixtures.ts`. It is written to exercise the "no reply" detector the
 * way a real Sent folder would: questions still waiting, one that was answered,
 * one too recent to count yet, and the things that only look like waiting —
 * a thank-you, a reply to a newsletter, a message to a no-reply address, a
 * question that sits only in the quoted history, and an automatic reply.
 *
 * Every address is under `.example`, like the inbox, and the dates are offsets
 * from the same reference instant.
 */

import { FIXTURE_MAILBOX_ADDRESS, FIXTURE_REFERENCE } from './fixtures.ts';
import type { ScanMessage } from './messages.ts';

type SentDraft = {
  /** Days before the reference instant. */
  ago: number;
  to: string;
  subject: string;
  text: string;
  automated?: boolean;
};

/** Which of the drafts below the detector should report, by index. */
export const AWAITED_SENT_INDEXES = [0, 1, 2] as const;

const SENT: readonly SentDraft[] = [
  // Still waiting.
  {
    ago: 6,
    to: 'Deverill IT <service@deverillit.example>',
    subject: 'Moving the studio server',
    text: 'We are moving the server to the new rack next month.\nCould you send a quote for the move and a day you could do it?\nThanks,\nSam',
  },
  {
    ago: 4,
    to: 'Tomas Brennan <tomas.brennan@brennanphoto.example>',
    subject: 'Pinegrove shoot proofs',
    text: 'The proofs look great.\nAre you free to go through the final selection on Thursday?\nSam',
  },
  {
    ago: 9,
    to: 'Ashgrove Studios <bookings@ashgrovestudios.example>',
    subject: 'Booking for 12 October',
    text: 'Please confirm the booking for the recording room on 12 October, 10:00 to 16:00.\nSam',
  },
  // Answered: Thornfield Joinery wrote back two days later.
  {
    ago: 14,
    to: 'Thornfield Joinery <hello@thornfieldjoinery.example>',
    subject: 'Mezzanine fit-out',
    text: 'Could you quote for the mezzanine fit-out we talked about?\nSam',
  },
  // Too recent to count as waiting.
  {
    ago: 1,
    to: 'Harrowgate Hardware <business@harrowgatehardware.example>',
    subject: 'Trade account',
    text: 'Can you open a trade account for the studio?\nSam',
  },
  // Asks nothing.
  {
    ago: 8,
    to: 'Kelburn Foods <procurement@kelburnfoods.example>',
    subject: 'Re: Catering for the launch',
    text: 'Thanks, that is all sorted on our side.\nSam',
  },
  // A reply to a newsletter.
  {
    ago: 10,
    to: 'The Longshore Letter <letter@longshoreletter.example>',
    subject: 'Re: Six things worth reading this week',
    text: 'Could you take me off this list?\nSam',
  },
  // To an address nobody reads.
  {
    ago: 12,
    to: 'Kestrel Air <noreply@kestrelair.example>',
    subject: 'Re: We are sorry about your delayed flight KA482',
    text: 'Can you pay the compensation to the card I booked with?\nSam',
  },
  // The only question is in the quoted history.
  {
    ago: 7,
    to: 'Priya Raghavan <priya@thackeraylane.example>',
    subject: 'Re: Sprint review moved',
    text: 'Thursday works for me.\n\nOn Mon, Priya Raghavan wrote:\n> Can you check the Pinegrove files before then?',
  },
  // An automatic reply the person's mail client sent.
  {
    ago: 11,
    to: 'Parcelon <claims@parcelon.example>',
    subject: 'Out of office',
    text: 'I am away until Monday. Can you resend anything urgent then?',
    automated: true,
  },
];

const at = (reference: string, ago: number): string =>
  new Date(Date.parse(reference) - ago * 86_400_000).toISOString();

const address = (to: string) => /<([^>]+)>/.exec(to)?.[1]?.toLowerCase() ?? to.toLowerCase();

/** The Sent folder, dated against a reference instant, with stable message ids. */
export function fixtureSentMessages(reference: string = FIXTURE_REFERENCE): ScanMessage[] {
  return SENT.map((draft, index) => ({
    messageId: `<sent-${String(index + 1).padStart(3, '0')}@thackeraylane.example>`,
    from: `Sam Okafor <${FIXTURE_MAILBOX_ADDRESS}>`,
    fromAddresses: [FIXTURE_MAILBOX_ADDRESS],
    to: draft.to,
    toAddresses: [address(draft.to)],
    subject: draft.subject,
    text: draft.text,
    receivedAt: at(reference, draft.ago),
    ...(draft.automated ? { automated: true } : {}),
  }));
}
