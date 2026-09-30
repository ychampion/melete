/**
 * The questions setup asks, and what of an answer is kept. Only what the
 * person actually said, or a choice that means something about them, is
 * saved as a detail. A skip, an empty answer or a stand-in such as
 * "Somewhere else" saves nothing.
 */

export type SetupQuestion = {
  key: string;
  ask: string;
  /** Answers the person can tap. Each one is a real answer, never a placeholder. */
  suggestions: readonly string[];
  /** The hint in the answer field. */
  placeholder: string;
  reply: (answer: string) => string;
};

export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    key: 'pref.home.city',
    ask: 'Where are you based? Type your city, or skip this one.',
    suggestions: [],
    placeholder: 'Your city',
    reply: (answer) => `${answer}. Noted.`,
  },
  {
    key: 'pref.people.names',
    ask: 'Who should I know by name? A few names and who they are is plenty.',
    suggestions: [],
    placeholder: 'For example: Sam, my partner; Priya, my manager',
    reply: (answer) => `Got it. I’ll remember: ${answer}.`,
  },
  {
    key: 'pref.focus.this-month',
    ask: 'What eats your week right now?',
    suggestions: [
      'Meetings and follow-ups',
      'Email and admin',
      'A launch at work',
      'Family logistics',
    ],
    placeholder: 'Or say it in your own words',
    reply: (answer) =>
      answer === 'A launch at work'
        ? 'A launch. I’ll offer to set it up as a plan when you’re ready.'
        : 'That’s the kind of thing I take off your plate first. I’ll start there.',
  },
  {
    key: 'pref.checkins.style',
    ask: 'How should I check in?',
    suggestions: ['Morning brief at 8:30', 'Only when it matters', 'Never first'],
    placeholder: 'Or say how you’d like it',
    reply: () =>
      'Perfect, that’s plenty to start. I’ll remember these and learn the rest as we go.',
  },
];

export const SKIP_REPLY = 'No problem. Tell me whenever you like.';

/**
 * Stand-ins earlier builds offered as answers. They say nothing about the
 * person, so they are never kept, whoever types them.
 */
const NOT_FACTS = new Set(
  [
    'somewhere else',
    'my family',
    'my team at work',
    'skip',
    'skip this one',
    'not now',
    'n/a',
    '-',
  ].map((value) => value.toLowerCase()),
);

/** The answer to keep, or null when there is nothing about the person in it. */
export function keptAnswer(raw: string): string | null {
  const answer = raw.replace(/\s+/g, ' ').trim();
  if (!answer || NOT_FACTS.has(answer.toLowerCase())) return null;
  return answer.slice(0, 500);
}
