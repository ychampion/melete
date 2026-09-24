/**
 * The three skills for what a person asks in their first days: summarising
 * something they point at, going through the inbox, and writing in their voice.
 * Each is chosen for its own requests and stays out of the others'.
 */
import { describe, expect, test } from 'bun:test';
import { selectSkills } from '@melete/contracts';
import { loadBuiltInSkills } from './loader.ts';

const { skills } = loadBuiltInSkills();
const picks = (text: string) =>
  selectSkills(text, text, skills).map((match) => match.skill.frontmatter.name);

describe.each([
  [
    'summarize-a-source',
    [
      'Summarise this PDF for me',
      'Give me the gist of this article',
      'TL;DR of the attached report',
    ],
    ['Research the best standing desk', 'Write a cover letter', 'Thanks!', 'Plan the move'],
  ],
  [
    'triage-the-inbox',
    ["What's in my inbox today?", 'Any important emails this morning?', 'Go through my email'],
    ["From now on, sign my emails 'Z'", 'Reply to Sam about the invoice', 'Book a table'],
  ],
  [
    'write-a-draft',
    [
      'Write a cover letter for the design job',
      'Proofread my essay',
      'Rewrite this paragraph',
      'Draft an email to the landlord about the boiler',
      'Write an introduction for my talk',
    ],
    ['Summarise this PDF', 'Remind me on Friday', "What's in my inbox?", 'Tell me a joke'],
  ],
])('%s', (name, chosen, passed) => {
  test.each(chosen)('is chosen for "%s"', (text) => {
    expect(picks(text)).toContain(name);
  });
  test.each(passed)('is not chosen for "%s"', (text) => {
    expect(picks(text)).not.toContain(name);
  });
});
