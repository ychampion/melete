/**
 * Lines about the work under way (waiting for a free slot, a break in the
 * stream) are shown while the turn runs and gone once it ended, so a result
 * opened later reads as its answer, not as the queue it waited in.
 */
import { expect, test } from 'bun:test';
import { applyEvents, fromTurns } from '../experience/reduce.ts';
import type { ExperienceEvent, Turn, TurnStatus } from '../experience/types.ts';
import { logItems } from './worklog.ts';

const AT = '2026-10-01T09:00:00.000Z';
let seq = 0;
const event = (item: ExperienceEvent['item']): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: 'turn_1',
  created_at: AT,
  item,
});
const turnAt = (status: TurnStatus) => {
  const turn: Turn = {
    id: 'turn_1',
    conversation_id: 'job_1',
    agent_id: 'nova',
    text: 'Morning brief',
    answer: '',
    status,
    delivery: null,
    created_at: AT,
  };
  const transcript = applyEvents(fromTurns([turn], 'pause', status), [
    event({
      type: 'note',
      text: 'Waiting for a free slot — 4 other tasks are running',
      transient: true,
    }),
    // Projected before notes were marked.
    event({
      type: 'note',
      text: 'Part of the answer was interrupted. The saved progress is still here.',
    }),
    event({ type: 'note', text: 'Your calendar was not connected, so it is left out.' }),
    event({ type: 'text_delta', text: 'Here is your brief.' }),
  ]);
  const shown = transcript.turns[0];
  if (!shown) throw new Error('missing');
  return logItems(shown).flatMap((item) => (item.type === 'note' ? [item.text] : []));
};

test('while the turn runs, every line about it shows', () => {
  expect(turnAt('working')).toHaveLength(3);
});

test('once the turn ended, only lines about the result stay', () => {
  for (const status of ['done', 'failed', 'stopped'] as const)
    expect(turnAt(status)).toEqual(['Your calendar was not connected, so it is left out.']);
});
