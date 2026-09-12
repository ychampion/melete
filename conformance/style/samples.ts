/**
 * The samples the style check is argued over.
 *
 * Every bad sample names the exact codes it must trip, and every good sample
 * asserts silence. Adding a rule means adding a bad sample that only the new
 * rule catches, which is the cheapest way to stop a check from quietly widening
 * into taste.
 */
import type { ReplyClass, StyleViolationCode } from '@melete/contracts';

export type StyleSample = {
  name: string;
  reply_class: ReplyClass;
  text: string;
  /** Sorted by the order `checkStyle` reports them. */
  expect: StyleViolationCode[];
};

export const GOOD_SAMPLES: readonly StyleSample[] = [
  {
    name: 'a one-sentence answer',
    reply_class: 'casual',
    text: 'The engineer is booked for Thursday the 18th.',
    expect: [],
  },
  {
    name: 'three sentences with one question',
    reply_class: 'casual',
    text:
      'The building manager replied. He offered Thursday or the following Tuesday, and needs an ' +
      'answer today. Which do you want?',
    expect: [],
  },
  {
    name: 'a contraction and a matched register',
    reply_class: 'casual',
    text: "It's done. I sent it at 14:02 and the receipt is act_01J9.",
    expect: [],
  },
  {
    name: 'a long deliverable note carries no sentence budget',
    reply_class: 'deliverable',
    text:
      'The brief is at /work/brief.md. It covers the three suppliers you named. Each section cites ' +
      'the page it came from. Prices are as of this morning. Two suppliers would not quote without ' +
      'an employer name. I left those blank rather than guessing. The last section lists what I could ' +
      'not confirm.',
    expect: [],
  },
  {
    name: 'detail was asked for, so twelve sentences are inside budget',
    reply_class: 'detailed',
    text: Array.from({ length: 12 }, (_, i) => `Point ${i + 1} is settled.`).join(' '),
    expect: [],
  },
  {
    name: 'a question mark inside a code span is not a question',
    reply_class: 'casual',
    text: 'Run `curl -s "https://example.com/?q=1"` and paste what comes back.',
    expect: [],
  },
  {
    name: 'the word "certainly" mid-sentence is prose, not a preamble',
    reply_class: 'casual',
    text: 'That is certainly possible, but the calendar says otherwise.',
    expect: [],
  },
];

export const BAD_SAMPLES: readonly StyleSample[] = [
  {
    name: 'a canned opener',
    reply_class: 'casual',
    text: 'Certainly! The engineer is booked for Thursday.',
    expect: ['banned_opener'],
  },
  {
    name: 'an eager offer to help',
    reply_class: 'casual',
    text: "I'd be happy to look into that for you.",
    expect: ['banned_opener'],
  },
  {
    name: 'a markdown-decorated opener still opens',
    reply_class: 'casual',
    text: '**Great question!** The answer is Thursday.',
    expect: ['banned_opener'],
  },
  {
    name: 'a wall of chat in a casual reply',
    reply_class: 'casual',
    text:
      'I looked at the thread. The manager wrote on Monday. He mentioned a contractor. The ' +
      'contractor has not confirmed. I will chase them tomorrow.',
    expect: ['sentence_budget'],
  },
  {
    name: 'two questions in one reply',
    reply_class: 'casual',
    text: 'Should I send it to the flat? Or would you rather I used the office?',
    expect: ['multiple_questions'],
  },
  {
    name: 'naming yourself as a machine',
    reply_class: 'casual',
    text: 'As an AI, I cannot open the door for the engineer.',
    expect: ['banned_opener', 'ai_self_reference'],
  },
  {
    name: 'a language-model disclaimer mid-reply',
    reply_class: 'casual',
    text: 'The date is Thursday, though as a language model I cannot verify the calendar.',
    expect: ['ai_self_reference'],
  },
  {
    name: 'everything at once',
    reply_class: 'casual',
    text:
      'Of course! I looked at the thread for you. The manager wrote on Monday. He mentioned a ' +
      'contractor who has not confirmed. As an AI I cannot call them. Shall I email instead? Or ' +
      'would you rather call?',
    expect: ['banned_opener', 'sentence_budget', 'multiple_questions', 'ai_self_reference'],
  },
];

export const ALL_SAMPLES: readonly StyleSample[] = [...GOOD_SAMPLES, ...BAD_SAMPLES];
