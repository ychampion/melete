/**
 * A receipt can come more than once: a message held before sending is
 * drawn with its countdown, then as sent or cancelled in the same place. An
 * undo's receipt names the change it took back, which is drawn as reversed.
 */
import { expect, test } from 'bun:test';
import { applyEvents, fromTurns } from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-10-04T09:00:00.000Z';
const turn: Turn = {
  id: 'turn_1',
  conversation_id: 'job_1',
  agent_id: 'melete',
  text: 'Tell Alex seven',
  answer: '',
  status: 'done',
  delivery: null,
  created_at: AT,
};
let seq = 0;
const receipt = (fields: Record<string, unknown>): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item: {
    type: 'receipt',
    receipt: { what: 'Sent an email', where: 'Mail', when: AT, ...fields },
  } as ExperienceEvent['item'],
});
const receipts = (events: ExperienceEvent[]) =>
  applyEvents(fromTurns([turn], 'send', 'done'), events).turns[0]?.blocks.flatMap((block) =>
    block.type === 'receipt' ? [block] : [],
  ) ?? [];

test('a held message is replaced in place once it is sent', () => {
  const shown = receipts([
    receipt({
      id: 'act_1',
      what: 'Sending a message',
      sending_until: AT,
      undo: { handle: 'undo_1', valid_until: AT },
    }),
    receipt({ id: 'act_1' }),
  ]);
  expect(shown).toHaveLength(1);
  expect(shown[0]?.receipt.what).toBe('Sent an email');
  expect(shown[0]?.receipt.sending_until).toBeUndefined();
});

test('an undo marks the change it took back as reversed', () => {
  const shown = receipts([
    receipt({ id: 'act_1', what: 'Created an event', undo: { handle: 'undo_1', valid_until: AT } }),
    receipt({ id: 'act_2', what: 'Created an event', undo: { handle: 'undo_2', valid_until: AT } }),
    receipt({ id: 'act_3', what: 'Removed an event', reverses: 'act_1' }),
  ]);
  expect(shown.map((block) => [block.receipt.id, block.reversed])).toEqual([
    ['act_1', true],
    ['act_2', false],
    ['act_3', false],
  ]);
});
