/**
 * A question the person withdrew by stopping the turn says so on its card, as
 * a withdrawn permission does, rather than showing plain disabled options.
 */
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Questionnaire } from '../chat/parts.tsx';
import { applyDecision, applyEvent, fromTurns } from './reduce.ts';
import type { Question, Turn } from './types.ts';

const AT = '2026-10-02T09:00:00.000Z';
const TURN: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'melete',
  text: 'Aisle or window?',
  answer: '',
  status: 'needs_you',
  delivery: null,
  created_at: AT,
};
const QUESTION = {
  id: 'qst_1',
  conversation_id: 'job_1',
  text: 'Aisle or window?',
  why: [],
  if_ignored: 'This waits for your answer.',
  options: [
    { id: 'choice_1', label: 'Aisle' },
    { id: 'choice_2', label: 'Window' },
  ],
  free_text: true,
  created_at: AT,
} as unknown as Question;

const asked = applyEvent(fromTurns([TURN], 'send', 'needs_you'), {
  seq: 1,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item: { type: 'question', question: QUESTION },
});
const card = (answered: string | null) =>
  renderToStaticMarkup(
    <Questionnaire
      question={QUESTION}
      answered={answered}
      active={false}
      onAnswer={() => {}}
      onOwn={() => {}}
    />,
  );

test('a stop withdraws the question, and its card says Withdrawn', () => {
  const stopped = applyDecision(asked, {
    kind: 'question',
    id: 'qst_1',
    outcome: 'withdrawn',
    answer: null,
    decided_at: AT,
  });
  const block = stopped.turns[0]?.blocks[0];
  expect(block?.type === 'question' && block.answered).toBe('withdrawn');
  expect(card('withdrawn')).toContain('Withdrawn');
});

test('an answer given elsewhere is not called withdrawn', () => {
  const answered = applyDecision(asked, {
    kind: 'question',
    id: 'qst_1',
    outcome: 'answered',
    answer: 'Window',
    decided_at: AT,
  });
  const block = answered.turns[0]?.blocks[0];
  expect(block?.type === 'question' && block.answered).toBe('choice_2');
  expect(card('choice_2')).not.toContain('Withdrawn');
  expect(card('closed')).not.toContain('Withdrawn');
});
