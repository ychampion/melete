/**
 * The stream says which way a decision went, so a conversation read again
 * after a reload shows "Allowed once" or the chosen answer, not only that the
 * turn moved on.
 */
import { expect, test } from 'bun:test';
import { applyEvents, fromTurns } from './reduce.ts';
import type { ExperienceEvent, Permission, Question, Turn } from './types.ts';

const AT = '2026-09-25T09:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'nova',
  text: 'Book dinner with Sam at seven',
  answer: '',
  status: 'done',
  delivery: null,
  created_at: AT,
};
const PERMISSION: Permission = {
  id: 'permission_1',
  conversation_id: 'job_1',
  what: 'Send this draft to Sam',
  why: ['You asked to send this reviewed draft.'],
  options: ['allow_once', 'always', 'deny'],
  version: 'v_1',
  preview: null,
  created_at: AT,
};
const QUESTION: Question = {
  id: 'q_1',
  conversation_id: 'job_1',
  text: 'Want me to hold the ryokan?',
  why: ['Your answer decides the next step.'],
  if_ignored: 'This conversation waits for your answer.',
  options: [
    { id: 'hold', label: 'Hold it · Ask before paying the deposit' },
    { id: 'later', label: 'Not yet · Come back to it next week' },
  ],
  created_at: AT,
};

let seq = 0;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});
const decided = (
  kind: 'permission' | 'question',
  id: string,
  outcome: 'allow_once' | 'always' | 'deny' | 'answered' | 'withdrawn',
  answer: string | null = null,
) => event({ type: 'decision', decision: { kind, id, outcome, answer, decided_at: AT } });

const blocks = (events: ExperienceEvent[]) =>
  applyEvents(fromTurns([TURN], 'send', 'done'), events).turns[0]?.blocks ?? [];

test('a permission read again after a reload shows how it was decided', () => {
  const [block] = blocks([
    event({ type: 'permission', permission: PERMISSION }),
    decided('permission', 'permission_1', 'allow_once'),
  ]);
  expect(block?.type === 'permission' && block.decided).toBe('allow_once');
});

test('the decision names the outcome even after the turn moved on', () => {
  const [block] = blocks([
    event({ type: 'permission', permission: PERMISSION }),
    event({ type: 'say', text: 'Sent.' }),
    decided('permission', 'permission_1', 'always'),
  ]);
  expect(block?.type === 'permission' && block.decided).toBe('always');
});

test('an answered question shows the option whose words were chosen', () => {
  const [block] = blocks([
    event({ type: 'question', question: QUESTION }),
    decided('question', 'q_1', 'answered', 'Hold it'),
  ]);
  expect(block?.type === 'question' && block.answered).toBe('hold');
});

test('a withdrawn question, or one answered in the person’s own words, closes without an option', () => {
  const [withdrawn] = blocks([
    event({ type: 'question', question: QUESTION }),
    decided('question', 'q_1', 'withdrawn'),
  ]);
  expect(withdrawn?.type === 'question' && withdrawn.answered).toBe('closed');
  const [own] = blocks([
    event({ type: 'question', question: { ...QUESTION, id: 'q_2' } }),
    decided('question', 'q_2', 'answered', 'Only if it has a garden'),
  ]);
  expect(own?.type === 'question' && own.answered).toBe('closed');
});
