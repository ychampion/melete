import { describe, expect, test } from 'bun:test';
import { SENSITIVE_TOPICS } from '@melete/contracts';
import { classify, classifyParts } from './classify.ts';

const all = [...SENSITIVE_TOPICS];

// Sentences from public pages a research chat read: news and trade press, not the person.
const PAGES = [
  'Europe is ending its addiction to a toxic, costly drug from dodgy suppliers',
  'A relapse into gas dependence would push bills up again this winter.',
  'The study followed HIV patients after a CT scan and a biopsy.',
  'Bankruptcy filings fell for the third quarter in a row.',
  'Mental health services report more panic attacks among students.',
];

describe('only a phrase about the person makes a conversation sensitive', () => {
  test.each(PAGES)('a single topic word is not enough: %s', (text) => {
    expect(classify(text, all)).toBeNull();
    expect(classifyParts([text], all, new Map())).toBeNull();
  });

  test.each([
    ['Summarise my therapy session notes from Tuesday.', 'therapy'],
    ['My therapist says I should rest', 'therapy'],
    ['I have been struggling with addiction since the spring', 'therapy'],
    ["I'm feeling depressed this week", 'therapy'],
    ['I was diagnosed with type 2 diabetes last year', 'health'],
    ['Can you read these lab results and tell me what they mean?', 'health'],
    ['My doctor wants another blood test', 'health'],
    ['What is my bank account number again?', 'finance'],
    ['Can you go through my bank statements for last year?', 'finance'],
    ['Help me fill in my tax return', 'finance'],
  ] as const)('%s', (text, topic) => {
    expect(classify(text, all)).toBe(topic);
  });

  test.each([
    'Book a table for two',
    'Please research residential heat pump adoption in Europe',
    'anxiety about the trip',
    'I have a meeting about diabetes research',
    'What is a good credit score?',
    'Read me the news about HIV treatment',
  ])('ordinary requests stay ordinary: %s', (text) => {
    expect(classify(text, all)).toBeNull();
  });

  test.each([
    ['I attempted suicide last year and my new job asks about it', 'therapy'],
    ['My daughter tried suicide on Friday, what do I tell her school', 'therapy'],
    ['I think about suicide every day', 'therapy'],
    ['I self-harm when I am stressed', 'therapy'],
    ['Since the accident I struggle with PTSD', 'therapy'],
    ['I struggle with an eating disorder', 'therapy'],
    ['My brother is in rehab for alcohol addiction', 'therapy'],
    ['Rehab for my sister starts Monday, book the train', 'therapy'],
    ['Finding a psychiatric hospital for my dad', 'therapy'],
    ['We are declaring bankruptcy', 'finance'],
    ['Our net worth is 2.3 million, how should we split it in the divorce', 'finance'],
  ] as const)(
    "a crisis, a condition or a household in the person's own words counts: %s",
    (text, topic) => {
      expect(classify(text, all)).toBe(topic);
      expect(classifyParts([text], all, new Map())).toBe(topic);
    },
  );

  test('three different topic words in what the person wrote still count', () => {
    expect(classify('I feel anxious, my mood is low and journaling my feelings helps', all)).toBe(
      'therapy',
    );
  });

  test('a topic the person turned off is never found', () => {
    expect(classify('My therapist says I should rest', ['health', 'finance'])).toBeNull();
  });
});
