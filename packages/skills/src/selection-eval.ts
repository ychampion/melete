/**
 * A fixed set of the requests a person makes in their first week, each with
 * the built-in skill that should reach the model for it, and the arithmetic
 * that turns a selection into precision and recall.
 *
 * Two numbers matter and they are measured separately. Selection is what the
 * trigger matcher picks. Delivery is what survives the rule that a skill is
 * offered only when every tool it names is in the catalog, which is what the
 * model actually reads.
 */
import { type SkillCandidate, selectSkills } from '@melete/contracts';
import { indexSkills, type LoadedSkill } from './loader.ts';

export type EvalRequest = {
  /** What the person typed. It is the latest message; the objective is the same words. */
  text: string;
  /** Skills that should be delivered. Empty means none should be. */
  expect: readonly string[];
  /** Skills that are reasonable too, so picking them is not counted against precision. */
  tolerate?: readonly string[];
};

export const SELECTION_REQUESTS: readonly EvalRequest[] = [
  // research with sources
  { text: 'Research the best standing desk under 500 pounds', expect: ['research-with-sources'] },
  {
    text: 'Find out when the recycling centre opens on Sundays',
    expect: ['research-with-sources'],
  },
  { text: 'Look up the warranty terms for my dishwasher', expect: ['research-with-sources'] },
  { text: 'Compare options for home insurance', expect: ['research-with-sources'] },
  {
    text: 'What do reviews say about the Kia EV3? Give me sources',
    expect: ['research-with-sources'],
  },
  {
    text: 'Which is cheaper to run, a heat pump or a gas boiler? Check a few sources',
    expect: ['research-with-sources'],
  },
  // writing
  { text: 'Write a cover letter for the design job', expect: ['write-a-draft'] },
  { text: "Draft a toast for my sister's wedding", expect: ['write-a-draft'] },
  { text: 'Rewrite this paragraph so it sounds friendlier', expect: ['write-a-draft'] },
  { text: 'Proofread my essay before I send it', expect: ['write-a-draft'] },
  { text: 'Write a short bio for my website', expect: ['write-a-draft'] },
  // email triage and replies
  { text: "What's in my inbox today?", expect: ['triage-the-inbox'] },
  {
    text: 'Go through my email and tell me what needs a reply',
    expect: ['triage-the-inbox'],
    tolerate: ['draft-follow-up'],
  },
  { text: 'Any important emails this morning?', expect: ['triage-the-inbox'] },
  { text: 'Triage my inbox', expect: ['triage-the-inbox'] },
  {
    text: 'Summarise my unread emails',
    expect: ['triage-the-inbox'],
    tolerate: ['summarize-a-source'],
  },
  { text: "Reply to Sam's email about the invoice", expect: ['draft-follow-up'] },
  { text: 'Follow up with the landlord about the boiler', expect: ['draft-follow-up'] },
  { text: 'Nudge Priya about the contract', expect: ['draft-follow-up'] },
  { text: 'Chase the plumber, he never sent the quote', expect: ['draft-follow-up'] },
  // calendar
  {
    text: 'Remind me on Friday to call the bank',
    expect: ['schedule-a-check-in'],
  },
  {
    text: 'Put the dentist appointment in my calendar for Tuesday at 3pm',
    expect: ['schedule-a-check-in'],
  },
  { text: 'Move my meeting with Alex to Thursday', expect: ['schedule-a-check-in'] },
  { text: "What's on my calendar tomorrow?", expect: ['schedule-a-check-in'] },
  {
    text: 'Schedule a check-in with the accountant next week',
    expect: ['schedule-a-check-in'],
  },
  // summarising files and pages
  { text: 'Summarise this PDF for me', expect: ['summarize-a-source'] },
  {
    text: 'Give me the gist of this article https://example.com/story',
    expect: ['summarize-a-source'],
  },
  { text: 'TL;DR of the report I uploaded', expect: ['summarize-a-source'] },
  { text: 'Summarize my notes from the meeting', expect: ['summarize-a-source'] },
  { text: 'Can you sum up this page for me?', expect: ['summarize-a-source'] },
  // planning
  { text: 'Plan the move out of the flat', expect: ['plan-a-responsibility'] },
  { text: 'Help me sort out the car insurance renewal', expect: ['plan-a-responsibility'] },
  {
    text: 'Make a plan to train for a 10k by March',
    expect: ['plan-a-responsibility'],
  },
  { text: 'Take care of registering the new car', expect: ['plan-a-responsibility'] },
  // files
  { text: 'Tidy up my downloads folder', expect: ['organize-documents'] },
  { text: 'File these receipts somewhere sensible', expect: ['organize-documents'] },
  { text: 'Organise my documents by year', expect: ['organize-documents'] },
  // memory
  { text: "Remember that I'm vegetarian", expect: ['remember-this'] },
  { text: "From now on, sign my emails 'Z'", expect: ['remember-this'] },
  { text: "Keep in mind I'm away from the 3rd to the 10th", expect: ['remember-this'] },
  // money playbooks
  { text: "I'm owed a refund from the electronics shop", expect: ['refund-owed'] },
  { text: 'They charged me twice for the streaming service', expect: ['wrong-charge'] },
  { text: 'Cancel my gym membership', expect: ['cancel-subscription'] },
  { text: 'Cancel my subscription to the meal kit', expect: ['cancel-subscription'] },
  { text: 'My broadband price is going up in April', expect: ['price-rise'] },
  { text: 'Get quotes for car insurance', expect: ['get-quotes'] },
  { text: 'My client has not paid invoice 42', expect: ['unpaid-invoice'] },
  // speech
  { text: 'Make a podcast about the history of tea', expect: ['make-a-podcast'] },
  // nothing to select
  { text: 'Thanks!', expect: [] },
  { text: 'Hi there', expect: [] },
  { text: "What's 15% of 80?", expect: [] },
  { text: 'Tell me a joke', expect: [] },
  { text: 'Translate good morning into Spanish', expect: [] },
  { text: 'Show me my purchase history', expect: [] },
  { text: 'Is this explanation of the tax rule right?', expect: [] },
  { text: 'Tell me about the planet Mars', expect: [] },
  { text: 'Which airplane seats have the most legroom?', expect: [] },
  { text: 'What does check-in time mean at a hotel?', expect: [] },
  { text: 'Book a table for two on Saturday', expect: [] },
];

/**
 * The tools a first-week installation has: the default connections, a mailbox,
 * a CalDAV calendar, a speech provider, and the broker's own tools. These are
 * the names on main; a skill naming anything else is never offered.
 */
export const DAY_ONE_TOOLS: readonly string[] = [
  'files.list',
  'files.read',
  'files.write',
  'files.move',
  'web.fetch',
  'artifact.publish',
  'audio.synthesize',
  'email.search',
  'email.read',
  'email.draft',
  'email.send',
  'calendar.list',
  'calendar.create',
  'calendar.update',
  'calendar.delete',
  'react',
  'job.wait',
];

export type SelectionScore = {
  picked: number;
  expected: number;
  truePositives: number;
  precision: number;
  recall: number;
  misses: string[];
  wrong: string[];
};

/** Micro precision and recall over the whole set, with the failing requests named. */
export function scoreSelection(
  skills: readonly SkillCandidate[],
  requests: readonly EvalRequest[] = SELECTION_REQUESTS,
  tools?: readonly string[],
): SelectionScore {
  const available = tools ? new Set(tools) : undefined;
  const offered = available
    ? skills.filter((skill) => skill.frontmatter.tools.every((tool) => available.has(tool)))
    : skills;
  let picked = 0;
  let expected = 0;
  let truePositives = 0;
  const misses: string[] = [];
  const wrong: string[] = [];
  for (const request of requests) {
    const chosen = selectSkills(request.text, request.text, offered).map(
      (match) => match.skill.frontmatter.name,
    );
    expected += request.expect.length;
    for (const name of request.expect) {
      if (chosen.includes(name)) truePositives += 1;
      else misses.push(`${request.text} -> ${name}`);
    }
    for (const name of chosen) {
      if (request.expect.includes(name)) picked += 1;
      else if (!request.tolerate?.includes(name)) {
        picked += 1;
        wrong.push(`${request.text} -> ${name}`);
      }
    }
  }
  return {
    picked,
    expected,
    truePositives,
    precision: picked === 0 ? 1 : truePositives / picked,
    recall: expected === 0 ? 1 : truePositives / expected,
    misses,
    wrong,
  };
}

/**
 * Requests written after the triggers were last changed and never used to
 * change them. The score on this set is the one to quote as a measure of how
 * selection does on phrasings it was not fitted to.
 */
export const HELD_OUT_REQUESTS: readonly EvalRequest[] = [
  {
    text: 'Can you dig into whether solar panels pay off in Leeds?',
    expect: ['research-with-sources'],
  },
  {
    text: 'I need evidence on the best baby car seats, with links',
    expect: ['research-with-sources'],
  },
  {
    text: 'Look into flights to Porto in May and tell me what is cheapest',
    expect: ['research-with-sources'],
  },
  { text: 'Help me put together a thank-you note for my neighbour', expect: ['write-a-draft'] },
  { text: 'Polish this LinkedIn post before I share it', expect: ['write-a-draft'] },
  { text: 'Could you tighten up my personal statement?', expect: ['write-a-draft'] },
  { text: 'Did anything come in from the bank today?', expect: ['triage-the-inbox'] },
  { text: 'Clear out my inbox and flag what matters', expect: ['triage-the-inbox'] },
  {
    text: 'Which emails do I still owe a reply to?',
    expect: ['triage-the-inbox'],
    tolerate: ['draft-follow-up'],
  },
  { text: 'Answer Maria and say Thursday works', expect: ['draft-follow-up'] },
  {
    text: 'Write back to the school about the trip form',
    expect: ['draft-follow-up'],
    tolerate: ['write-a-draft'],
  },
  { text: 'Ping the accountant again about my tax return', expect: ['draft-follow-up'] },
  { text: 'Book me in for a haircut next Wednesday afternoon', expect: ['schedule-a-check-in'] },
  { text: 'Am I free on Saturday morning?', expect: ['schedule-a-check-in'] },
  { text: 'Nudge me tomorrow at nine to pay the council tax', expect: ['schedule-a-check-in'] },
  { text: 'What are the main points of this contract?', expect: ['summarize-a-source'] },
  { text: 'Boil this report down to a paragraph', expect: ['summarize-a-source'] },
  { text: 'Break down the renovation into steps for me', expect: ['plan-a-responsibility'] },
  {
    text: 'Get the house ready for selling, one step at a time',
    expect: ['plan-a-responsibility'],
  },
  { text: 'Put my tax documents into folders', expect: ['organize-documents'] },
  { text: "Don't forget that my daughter is allergic to nuts", expect: ['remember-this'] },
  { text: 'My energy supplier still has not paid back the credit', expect: ['refund-owed'] },
  { text: 'I was billed for a delivery that never came', expect: ['wrong-charge'] },
  { text: 'Get me out of the magazine subscription', expect: ['cancel-subscription'] },
  { text: 'Insurance renewal came in way higher than last year', expect: ['price-rise'] },
  { text: 'Find me a cheaper quote for boiler cover', expect: ['get-quotes'] },
  {
    text: 'Chase up payment for the logo job from last month',
    expect: ['unpaid-invoice'],
    tolerate: ['draft-follow-up'],
  },
  { text: 'Turn this article into something I can listen to', expect: ['make-a-podcast'] },
  { text: 'Good morning!', expect: [] },
  { text: 'How many ounces are in a pound?', expect: [] },
  { text: 'Who won the match last night?', expect: [] },
  { text: 'Suggest a name for my cat', expect: [] },
];

export type IndexScore = {
  /** Expected skills given in full because a trigger matched. */
  preloaded: number;
  /** Expected skills the attempt can see: given in full, or named in its index. */
  visible: number;
  expected: number;
  preloadRecall: number;
  coverage: number;
};

/**
 * What the skill index changes: an expected skill no trigger matched can still
 * be named in the index for the model to read. This counts what the attempt can
 * see, not what a model then chooses to read.
 */
export function scoreIndex(
  skills: readonly LoadedSkill[],
  requests: readonly EvalRequest[],
  tools: readonly string[],
  budget: number,
): IndexScore {
  const available = new Set(tools);
  const usable = skills.filter((skill) =>
    skill.frontmatter.tools.every((tool) => available.has(tool)),
  );
  let preloaded = 0;
  let visible = 0;
  let expected = 0;
  for (const request of requests) {
    const given = selectSkills(request.text, request.text, usable).map(
      (match) => match.skill.frontmatter.name,
    );
    const index = indexSkills(
      request.text,
      request.text,
      usable.filter((skill) => !given.includes(skill.frontmatter.name)),
      budget,
    ).map((entry) => entry.name);
    for (const name of request.expect) {
      expected += 1;
      if (given.includes(name)) preloaded += 1;
      if (given.includes(name) || index.includes(name)) visible += 1;
    }
  }
  return {
    preloaded,
    visible,
    expected,
    preloadRecall: expected ? preloaded / expected : 1,
    coverage: expected ? visible / expected : 1,
  };
}
