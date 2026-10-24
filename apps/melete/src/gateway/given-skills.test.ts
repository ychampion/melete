import { afterEach, expect, test } from 'bun:test';
import { skillsDone, skillsGiven, skillsSent, stillGiven } from './given-skills.ts';

const ATTEMPT = 'att_given_skills';
const BODY = 'Use the "receipts" sheet.\n\n- Café totals in €\n- Never guess a date\n';
const tools = [{ name: 'skills.read' }];

afterEach(() => skillsDone(ATTEMPT));

test('a skill is held while the agent’s latest request carries it whole', () => {
  skillsGiven(ATTEMPT, [{ name: 'receipts', body: BODY }]);
  // Nothing sent yet: nothing is assumed.
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(false);
  // Quotes, newlines and non-ASCII text are found as the request's JSON has them,
  // in a text block as well as in a plain string.
  skillsSent(ATTEMPT, {
    tools,
    system: 'You are Melete.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: `## How\n\n### receipts\n\n${BODY.trim()}` }],
      },
    ],
  });
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(true);
  // The engine's summary call carries no tools and changes nothing.
  skillsSent(ATTEMPT, { messages: [{ role: 'user', content: 'You are a summarization agent.' }] });
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(true);
  // After the compaction, the agent's request no longer has it.
  skillsSent(ATTEMPT, { tools, messages: [{ role: 'user', content: 'Summary: receipts done.' }] });
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(false);
});

test('only the version given counts, and only for the attempt given it', () => {
  skillsGiven(ATTEMPT, [{ name: 'receipts', body: BODY }]);
  skillsSent(ATTEMPT, { tools, input: [{ role: 'user', content: BODY }] });
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(true);
  expect(stillGiven(ATTEMPT, 'receipts', `${BODY}One more rule.`)).toBe(false);
  expect(stillGiven(ATTEMPT, 'refunds', BODY)).toBe(false);
  expect(stillGiven('att_other', 'receipts', BODY)).toBe(false);
  skillsDone(ATTEMPT);
  expect(stillGiven(ATTEMPT, 'receipts', BODY)).toBe(false);
});

test('an empty skill is never taken as held', () => {
  skillsGiven(ATTEMPT, [{ name: 'blank', body: '  ' }]);
  skillsSent(ATTEMPT, { tools, messages: [{ role: 'user', content: 'anything' }] });
  expect(stillGiven(ATTEMPT, 'blank', '  ')).toBe(false);
});
