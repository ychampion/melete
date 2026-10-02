/**
 * Opening a chat replays its history over the saved turns. The saved turns and
 * the conversation say where things stand now; the statuses the history passes
 * through ("working" on the way to "needs you") are history, and an old turn
 * never reads as working while it replays, nor the composer as stoppable.
 */
import { expect, test } from 'bun:test';
import { adoptSaved, applyEvent, applyHistory, fromTurns } from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-10-02T09:00:00.000Z';
const asked: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'melete',
  text: 'Plan dinner',
  answer: 'Asked you one thing before I plan anything.',
  status: 'needs_you',
  delivery: null,
  created_at: AT,
};
const later: Turn = {
  ...asked,
  id: 'turn_2',
  text: 'You chose: Eating out',
  answer: 'Sawaan Thai, 7:30.',
  status: 'done',
};
let seq = 0;
const on = (turnId: string, item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turnId,
  created_at: AT,
  item,
});
const working = { type: 'status', status: 'working', composer: 'pause' } as const;

test('a history page that stops mid-turn leaves the saved statuses showing', () => {
  const opened = fromTurns([asked, later], 'send', 'needs_you');
  // The first page ends while each turn was still working.
  const page = [
    on('turn_1', working),
    on('turn_1', { type: 'say', text: 'Looking at what is near you.' }),
    on('turn_2', working),
  ];
  const shown = applyHistory(opened, page);
  expect(shown.turns.map((turn) => turn.status)).toEqual(['needs_you', 'done']);
  expect(shown.composer).toBe('send');
  expect(shown.status).toBe('needs_you');
  // What else the history says is kept, and the stream resumes after it.
  expect(shown.turns[0]?.trail).toHaveLength(1);
  expect(shown.lastSeq).toBe(page[2]?.seq ?? -1);
});

test('a turn the saved copy did not have follows its replayed statuses', () => {
  const opened = fromTurns([asked], 'send', 'needs_you');
  const shown = applyHistory(opened, [on('turn_9', working)]);
  expect(shown.turns.find((turn) => turn.id === 'turn_9')?.status).toBe('working');
});

test('a question the history shows was answered elsewhere is still closed', () => {
  const opened = fromTurns([asked], 'send', 'needs_you');
  const shown = applyHistory(opened, [
    on('turn_1', {
      type: 'question',
      question: {
        id: 'qst_1',
        text: 'Cook or eat out?',
        options: [],
        free_text: true,
      } as unknown as Extract<ExperienceEvent['item'], { type: 'question' }>['question'],
    }),
    on('turn_1', working),
  ]);
  const block = shown.turns[0]?.blocks[0];
  expect(block?.type === 'question' && block.answered).toBe('closed');
  expect(shown.turns[0]?.status).toBe('needs_you');
});

test('a fresh read after the history takes what changed meanwhile, and live events still apply', () => {
  const opened = fromTurns([{ ...later, status: 'working', answer: '' }], 'pause', 'working');
  // The history says the turn finished after the saved copy was read.
  const replayed = applyHistory(opened, [
    on('turn_2', { type: 'status', status: 'done', composer: 'send' }),
  ]);
  expect(replayed.turns[0]?.status).toBe('working');
  const fresh = adoptSaved(replayed, [later], 'send', 'done');
  expect(fresh.turns[0]?.status).toBe('done');
  expect(fresh.turns[0]?.turn.answer).toBe('Sawaan Thai, 7:30.');
  expect(fresh.composer).toBe('send');
  // A new message's turn, live, is drawn as it comes.
  const live = applyEvent(fresh, on('turn_3', working));
  expect(live.turns.at(-1)?.status).toBe('working');
  expect(live.composer).toBe('pause');
});
