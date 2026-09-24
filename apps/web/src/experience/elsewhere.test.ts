/**
 * A message sent to an open conversation from somewhere else (another tab,
 * another device, the service's own API) is drawn as it happens, not after a
 * reload. Its events start a turn of their own; its saved text is read once
 * and filled in. The page's own message can stream its first events before
 * the send is answered, and those join the page's turn instead of doubling it.
 */
import { expect, test } from 'bun:test';
import {
  acceptLocalTurn,
  addLocalTurn,
  applyEvent,
  fillTurns,
  fromTurns,
  unreadTurns,
} from './reduce.ts';
import type { ExperienceEvent, Turn } from './types.ts';

const AT = '2026-09-24T20:00:00.000Z';
const saved = (id: string, text: string): Turn => ({
  id,
  conversation_id: 'job_1',
  agent_id: 'nova',
  text,
  answer: '',
  status: 'done',
  delivery: null,
  created_at: AT,
});
let seq = 0;
const say = (turnId: string, text: string): ExperienceEvent => ({
  seq: ++seq,
  conversation_id: 'job_1',
  turn_id: turnId,
  created_at: AT,
  item: { type: 'say', text },
});

test('events for a turn this page did not start draw that turn', () => {
  const before = fromTurns([saved('turn_1', 'Plan the weekend')], 'send', 'done');
  const after = applyEvent(before, say('turn_2', 'Checking the forecast first.'));
  expect(after.turns.map((turn) => turn.id)).toEqual(['turn_1', 'turn_2']);
  expect(after.turns[1]?.trail).toEqual([{ type: 'say', text: 'Checking the forecast first.' }]);
  expect(unreadTurns(after)).toEqual(['turn_2']);
});

test('its message is filled in once the saved turn is read', () => {
  const drawn = applyEvent(
    fromTurns([saved('turn_1', 'Plan the weekend')], 'send', 'done'),
    say('turn_2', 'Checking the forecast first.'),
  );
  const filled = fillTurns(drawn, [
    saved('turn_1', 'Plan the weekend'),
    saved('turn_2', 'Move the run to Saturday'),
  ]);
  expect(filled.turns[1]?.turn.text).toBe('Move the run to Saturday');
  expect(unreadTurns(filled)).toEqual([]);
  // A turn this page already knew is left as it was.
  expect(filled.turns[0]?.turn.text).toBe('Plan the weekend');
});

test('the page’s own message is not drawn twice when its events beat the send’s answer', () => {
  let transcript = addLocalTurn(
    fromTurns([], 'send', 'idle'),
    'Find somewhere for dinner',
    'nova',
    'job_1',
    'sending',
    'local_1',
  );
  transcript = applyEvent(transcript, say('turn_9', 'Checking who is free tonight.'));
  expect(transcript.turns).toHaveLength(2);
  transcript = acceptLocalTurn(transcript, 'local_1', 'turn_9', AT);
  expect(transcript.turns).toHaveLength(1);
  expect(transcript.turns[0]?.turn.text).toBe('Find somewhere for dinner');
  expect(transcript.turns[0]?.trail).toEqual([
    { type: 'say', text: 'Checking who is free tonight.' },
  ]);
});
