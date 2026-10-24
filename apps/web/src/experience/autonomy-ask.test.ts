/**
 * The card that asks once how much the agent does on its own is drawn where
 * it was asked, and a choice made later, on it or in Settings, is drawn in
 * its place. It never waits, so it does not settle a question still open.
 */
import { expect, test } from 'bun:test';
import { applyEvents, fromTurns } from './reduce.ts';
import type { AutonomyAsk, ExperienceEvent, Turn } from './types.ts';

const AT = '2026-10-04T09:00:00.000Z';
const turn = (id: string): Turn => ({
  id,
  conversation_id: 'job_1',
  agent_id: 'melete',
  text: 'Tell Alex seven',
  answer: '',
  status: 'done',
  delivery: null,
  created_at: AT,
});
const ask = (fields: Partial<AutonomyAsk> = {}): AutonomyAsk => ({
  id: 'ask_1',
  task: 'chat_message',
  title: 'Messages to other people (Slack, texts and similar)',
  explanation: 'Choose how much it does on its own for this kind of task.',
  level: 'when_confident',
  chosen: null,
  choices: [
    { level: 'draft', label: 'Draft it for me', means: 'It drafts.' },
    { level: 'when_confident', label: 'Send when confident', means: 'It sends when confident.' },
    { level: 'always', label: 'Always send', means: 'It sends.' },
  ],
  ...fields,
});
let seq = 0;
const event = (turnId: string, item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turnId,
  created_at: AT,
  item,
});

test('a later choice is drawn in the card that asked, wherever it arrives', () => {
  const transcript = applyEvents(fromTurns([turn('turn_1'), turn('turn_2')], 'send', 'done'), [
    event('turn_1', { type: 'autonomy', autonomy: ask() }),
    event('turn_2', { type: 'autonomy', autonomy: ask({ level: 'always', chosen: 'always' }) }),
  ]);
  const cards = transcript.turns.flatMap((t) =>
    t.blocks.flatMap((block) => (block.type === 'autonomy' ? [[t.id, block.autonomy]] : [])),
  );
  expect(cards).toEqual([['turn_1', ask({ level: 'always', chosen: 'always' })]]);
});

test('the card does not settle a question still waiting for the person', () => {
  const transcript = applyEvents(
    fromTurns([{ ...turn('turn_1'), status: 'needs_you' }], 'send', 'needs_you'),
    [
      event('turn_1', {
        type: 'question',
        question: {
          id: 'q_1',
          conversation_id: 'job_1',
          text: 'Which day?',
          why: ['It decides the booking.'],
          if_ignored: 'This waits.',
          free_text: false,
          created_at: AT,
          options: [{ id: 'option-1', label: 'Friday' }],
        },
      } as ExperienceEvent['item']),
      event('turn_1', { type: 'autonomy', autonomy: ask() }),
    ],
  );
  const question = transcript.turns[0]?.blocks.find((block) => block.type === 'question');
  expect(question).toMatchObject({ answered: null });
});
